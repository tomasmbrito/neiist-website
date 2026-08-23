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
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
});

afterAll(async () => {
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
    // Structural, not behavioural, and the most important test here.
    //
    // The rule is that internal material cannot leak by *omission* — someone adding a
    // `get_all_events()` for a dashboard, forgetting `is_public`, and shipping every team's
    // meetings to anyone. That mistake passes every behavioural test written today, because the
    // function would be new. So this asserts the invariant over the whole schema instead: any
    // function whose body reads internal_events must either take a department parameter or
    // mention is_public.
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'neiist'
         AND p.prosrc LIKE '%internal_events%'
         -- Set-returning only: these are the functions that emit event ROWS. A scalar helper
         -- like get_internal_event_owner (which returns just a department name, and exists
         -- precisely so mutations authorize against the row rather than the request) and a
         -- void delete are not readers and are correctly not caught here.
         AND p.proretset
         AND p.prosrc NOT LIKE '%is_public%'
         AND pg_get_function_identity_arguments(p.oid) NOT LIKE '%character varying%'`
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  });
});
