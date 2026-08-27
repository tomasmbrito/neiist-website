import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createInternalEvent,
  deleteInternalEvent,
  getInternalEventOwner,
  getTeamInternalEvents,
} from "@/utils/db/eventQueries";

/**
 * #129 slice A, against the real database.
 *
 * The property that matters most is negative and structural: an internal meeting must not be
 * reachable without naming its team. So the last test in this file introspects `pg_proc` rather
 * than testing a behaviour — it asserts that no function which touches `internal_events` can
 * return rows without either taking a department or filtering `is_public`.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM_A = "Fotografia";
const TEAM_B = "Visuais";
const AUTHOR = "ist9994001";

let owner: Client;

const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Event Author', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [AUTHOR, `${AUTHOR}@tecnico.ulisboa.pt`]
  );
  // A membership, because `create_internal_event` now only accepts members as attendees (#208's
  // rule, extended to the create path). This fixture had none — it was inviting a non-member.
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, 'Membro')", [
    AUTHOR,
    TEAM_A,
  ]);
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = $1", [AUTHOR]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [AUTHOR]);
  await owner.end();
});

const make = (over: Partial<Parameters<typeof createInternalEvent>[0]> = {}) =>
  createInternalEvent({
    kind: "meeting",
    name: "Reunião de coordenação",
    startsAt: inHours(24),
    isPublic: false,
    departmentName: TEAM_A,
    createdByIstid: AUTHOR,
    ...over,
  });

describe("creating an event writes atomically", () => {
  it("writes the event, its locations and its attendees in one call", async () => {
    const id = await make({
      kind: "event",
      name: "Semana Informática",
      endsAt: inHours(30),
      locations: ["Alameda", "Online"],
      attendees: [AUTHOR],
    });

    const events = await getTeamInternalEvents(TEAM_A);
    const created = events.find((e) => e.id === id);
    expect(created).toBeDefined();
    expect(created!.locations.sort()).toEqual(["Alameda", "Online"]);
    expect(created!.attendeeCount).toBe(1);
  });

  it("leaves nothing behind when the event itself is refused", async () => {
    // The atomicity claim: locations must not survive an event that was never created. A
    // half-written event with orphan locations is not a state anything should observe.
    const before = await owner.query("SELECT count(*)::INT AS n FROM neiist.event_locations");
    await expect(make({ name: "   ", locations: ["Alameda"] })).rejects.toMatchObject({
      code: "NEI14",
    });
    const after = await owner.query("SELECT count(*)::INT AS n FROM neiist.event_locations");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("drops an attendee who is not a real user rather than refusing the whole event", async () => {
    const id = await make({ attendees: [AUTHOR, "ist0000000"] });
    const created = (await getTeamInternalEvents(TEAM_A)).find((e) => e.id === id);
    expect(created!.attendeeCount).toBe(1);
  });

  it("deduplicates repeated locations and attendees", async () => {
    const id = await make({ locations: ["Alameda", "Alameda"], attendees: [AUTHOR, AUTHOR] });
    const created = (await getTeamInternalEvents(TEAM_A)).find((e) => e.id === id);
    expect(created!.locations).toEqual(["Alameda"]);
    expect(created!.attendeeCount).toBe(1);
  });
});

describe("validation", () => {
  it("refuses a blank name", async () => {
    await expect(make({ name: "  " })).rejects.toMatchObject({ code: "NEI14" });
  });

  it("refuses an end before the start", async () => {
    await expect(make({ startsAt: inHours(10), endsAt: inHours(2) })).rejects.toMatchObject({
      code: "NEI14",
    });
  });

  it("refuses an unknown kind", async () => {
    await expect(make({ kind: "party" as unknown as "event" })).rejects.toMatchObject({
      code: "NEI14",
    });
  });

  it("refuses an unknown team", async () => {
    await expect(make({ departmentName: "ZZ Nonexistent" })).rejects.toMatchObject({
      code: "NEI15",
    });
  });
});

describe("team scoping", () => {
  it("returns only the named team's events", async () => {
    await make({ name: "Só da Fotografia", departmentName: TEAM_A });
    await make({ name: "Só dos Visuais", departmentName: TEAM_B });

    const a = await getTeamInternalEvents(TEAM_A);
    const b = await getTeamInternalEvents(TEAM_B);

    expect(a.some((e) => e.name === "Só da Fotografia")).toBe(true);
    expect(a.some((e) => e.name === "Só dos Visuais")).toBe(false);
    expect(b.some((e) => e.name === "Só dos Visuais")).toBe(true);
  });

  it("reports the owning team from the row, for authorizing a mutation", async () => {
    // The route authorizes deletion against this, never against a department in the request —
    // trusting the body would let a coordinator of one team delete another's events.
    const id = await make({ departmentName: TEAM_B });
    expect(await getInternalEventOwner(id)).toBe(TEAM_B);
    expect(await getInternalEventOwner(999_999_999)).toBeNull();
  });

  it("deletes the event and cascades its locations and attendees", async () => {
    const id = await make({ locations: ["Alameda"], attendees: [AUTHOR] });
    await deleteInternalEvent(id);

    expect((await getTeamInternalEvents(TEAM_A)).some((e) => e.id === id)).toBe(false);
    const orphans = await owner.query(
      "SELECT count(*)::INT AS n FROM neiist.event_locations WHERE event_id = $1",
      [id]
    );
    expect(orphans.rows[0].n).toBe(0);
  });
});

describe("the is_public boundary", () => {
  it("defaults to false when nothing says otherwise", async () => {
    const id = await make({ isPublic: false });
    const created = (await getTeamInternalEvents(TEAM_A)).find((e) => e.id === id);
    expect(created!.isPublic).toBe(false);

    // And at the column level, so a future INSERT that omits it cannot publish by accident.
    const column = await owner.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'neiist' AND table_name = 'internal_events' AND column_name = 'is_public'`
    );
    expect(column.rows[0].column_default).toBe("false");
  });

  it("has no reader that can return internal events without naming a team", async () => {
    // Structural, and the most important test here — but the FIRST version of it was theatre.
    //
    // A security review wrote six leaky functions against the original predicate
    // (`proretset AND prosrc LIKE '%internal_events%' AND prosrc NOT LIKE '%is_public%' AND args
    // NOT LIKE '%character varying%'`) and it caught **none** of them: a JSONB return is not
    // `proretset`; an unused `VARCHAR(10)` argument satisfies the varchar test without being a
    // department; SELECTing `is_public` is indistinguishable from filtering on it; and `prosrc`
    // is **empty** for PG14+ `BEGIN ATOMIC` bodies, so it was blind to the modern syntax for
    // exactly the functions it policed. Verified all four against the live database.
    //
    // So this no longer tries to recognise a leak. It **enumerates every function that touches
    // the table** — through `pg_depend`, which sees `BEGIN ATOMIC` and views, unioned with the
    // source text, which sees quoted bodies; neither alone is sufficient — and asserts the set
    // equals a written-down list. A new reader fails here by name until someone adds it on
    // purpose, whatever shape it takes.
    const ALLOWED = [
      // Department-scoped: structurally cannot return another team's events.
      "get_team_internal_events",
      "get_internal_event_detail",
      "get_event_attendees",
      "get_event_documents",
      "get_event_relations",
      "get_member_internal_events",
      // The ONE unscoped reader, and it filters `WHERE is_public AND kind = 'event'`. Adding a
      // second name to this half of the list is a security decision, not a refactor.
      "get_public_internal_events",
      // Writers and scalar helpers: they touch the table but do not return event rows.
      "create_internal_event",
      "delete_internal_event",
      "get_internal_event_owner",
      "update_event_notes",
      "set_event_attendance",
      "relate_events",
      // #130. Tasks touch internal_events through the optional event link; all three are
      // department-scoped or keyed to one person's own live scopes, so they are readers of the
      // permitted shape. Listed here deliberately — this test failing when Phase 2 landed is the
      // guard working: a new function reading the table must be acknowledged, not slip in.
      "create_task",
      "get_team_tasks",
      "get_user_tasks",
      // #219. Neither returns event CONTENT: `event_teams` returns department names only (which
      // team may see event N), and `set_event_collaborator` returns void. They touch the table
      // but cannot leak a name, a date or an attendee, which is what this list guards.
      "event_teams",
      "set_event_collaborator",
      // #210. The Notion importer's upsert. A WRITER: it returns the new event's `id` and nothing
      // else, takes the owning department as a required argument, and cannot be reached from a
      // route — the import runs from `scripts/import-notion-events.mts` as the owner role. Added
      // deliberately, which is the point of this list: it failed by name until someone justified
      // it in writing.
      "import_internal_event",
      // #137 first slice. `hand_over_public_calendar` is a writer returning a count.
      //
      // `public_calendar_handover_report` is the one that needed thinking about, because it DOES
      // return event titles and dates with no department parameter — the exact shape this list
      // exists to police. It earns its place the same way `get_public_internal_events` does:
      // every row it can return is ALREADY on the public calendar. The `ready` branch INNER JOINs
      // `activities`, so an event only appears there if the Notion sync is publishing its page to
      // students right now; the `orphan_activity` branch reads `activities` alone, which is the
      // public calendar table. It cannot reach an event that is not already public.
      //
      // It is also operator-run: no route calls it. That is a reason to keep watching it, not a
      // reason to skip the check — a future route could.
      "public_calendar_handover_report",
      "hand_over_public_calendar",
      // #232. `raise_requirements` is a writer returning a count, and it REFUSES an event that is
      // not the requesting team's — so it cannot even be used to probe for one.
      //
      // `get_team_requirements` does return an event NAME to a team that does not own the event —
      // which is the intended behaviour, not a hole. A requerimento is raised deliberately by the
      // owning team TO another team; being told which event you are drawing a poster for is the
      // entire point. It is the same shape as a collaborating team seeing an event (#219), and it
      // is keyed in SQL: a team that is neither the requester nor the target cannot reach the row,
      // proven by test rather than by the route remembering.
      "raise_requirements",
      "get_team_requirements",
    ].sort();

    const { rows } = await owner.query<{ proname: string }>(
      `SELECT DISTINCT proname FROM (
         -- pg_depend: sees BEGIN ATOMIC bodies and view dependencies, where prosrc is empty.
         SELECT p.proname
         FROM pg_proc p
         JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass
         WHERE d.refobjid = 'neiist.internal_events'::regclass
         UNION
         -- Source text: sees quoted bodies, which pg_depend does not record.
         SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         -- prokind = 'f': pg_get_functiondef raises on aggregates, and an aggregate cannot be
         -- an unscoped reader anyway.
         WHERE n.nspname = 'neiist'
           AND p.prokind = 'f'
           AND coalesce(p.prosrc, '') || coalesce(pg_get_functiondef(p.oid), '')
               LIKE '%internal_events%'
       ) touching
       ORDER BY proname`
    );

    expect(rows.map((row) => row.proname)).toEqual(ALLOWED);
  });

  it("exposes no VIEW over internal_events that could be read unscoped", async () => {
    // The one evasion the function-level check above cannot see: a function reading a view that
    // reads the table mentions neither, so it is invisible to both halves. There are no views
    // over this table, and the app role has no direct SELECT either — asserted rather than
    // assumed, because a GRANTed view would be reachable and completely unguarded.
    const views = await owner.query<{ relname: string }>(
      `SELECT c.relname
       FROM pg_class c
       JOIN pg_depend d ON d.objid = c.oid
       WHERE c.relkind = 'v' AND d.refobjid = 'neiist.internal_events'::regclass`
    );
    expect(views.rows).toEqual([]);

    const direct = await owner.query<{ has: boolean }>(
      `SELECT has_table_privilege('neiist_app_user', 'neiist.internal_events', 'SELECT') AS has`
    );
    expect(direct.rows[0].has).toBe(false);
  });
});
