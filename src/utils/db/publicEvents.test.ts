import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createInternalEvent,
  getMemberInternalEvents,
  getPublicInternalEvents,
  publicEventToCalendarEvent,
} from "@/utils/db/eventQueries";

/**
 * #129 slice C — the public calendar, and the member view, reading the database.
 *
 * `get_public_internal_events` is **the only function in the schema that reads
 * `internal_events` without a department**. It earns that by filtering `WHERE is_public`, and
 * that filter is the entire authorization: the function is callable by anyone, so this file is
 * where "an internal meeting must never reach the public calendar" is actually pinned.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM_A = "Fotografia";
const TEAM_B = "Visuais";
const AUTHOR = "ist9997001";
const MEMBER_A = "ist9997002"; // belongs to Fotografia only

let owner: Client;

const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  for (const [istid, name] of [
    [AUTHOR, "Public Author"],
    [MEMBER_A, "Fotografia Only"],
  ]) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), $2, $3)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, name, `${istid}@tecnico.ulisboa.pt`]
    );
  }
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, 'Membro')", [
    MEMBER_A,
    TEAM_A,
  ]);
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [
    [AUTHOR, MEMBER_A],
  ]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [[AUTHOR, MEMBER_A]]);
  await owner.end();
});

const make = (over: Partial<Parameters<typeof createInternalEvent>[0]> = {}) =>
  createInternalEvent({
    kind: "event",
    name: "Evento",
    startsAt: inHours(24),
    isPublic: false,
    departmentName: TEAM_A,
    createdByIstid: AUTHOR,
    ...over,
  });

describe("the public calendar", () => {
  it("shows a public event", async () => {
    const id = await make({ name: "Semana Informática", isPublic: true, locations: ["Alameda"] });
    const events = await getPublicInternalEvents();
    const found = events.find((event) => event.id === id);
    expect(found).toBeDefined();
    expect(found!.locations).toEqual(["Alameda"]);
  });

  it("does NOT show an internal event", async () => {
    // The core property of this whole feature.
    const id = await make({ name: "Interno", isPublic: false });
    expect((await getPublicInternalEvents()).some((event) => event.id === id)).toBe(false);
  });

  it("does NOT show a meeting, even one marked public", async () => {
    // Belt and braces on top of is_public. Not a security control — publishing a meeting is a
    // deliberate act — but nothing in the núcleo's workflow wants a coordination meeting on the
    // students' calendar, and the mistake is one checkbox away.
    const id = await make({ kind: "meeting", name: "Reunião pública", isPublic: true });
    expect((await getPublicInternalEvents()).some((event) => event.id === id)).toBe(false);
  });

  it("shows public events from every team, since the calendar is the núcleo's", async () => {
    const a = await make({ name: "Da Fotografia", isPublic: true, departmentName: TEAM_A });
    const b = await make({ name: "Dos Visuais", isPublic: true, departmentName: TEAM_B });
    const ids = (await getPublicInternalEvents()).map((event) => event.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});

describe("the calendar adapter", () => {
  it("prefixes the id so it cannot collide with a Notion page id", async () => {
    // `neiist.activities` ids are Notion page ids and the two lists are merged, so a bare
    // integer could collide with one.
    const event = publicEventToCalendarEvent({
      id: 42,
      name: "X",
      description: null,
      startsAt: "2026-09-01T10:00:00.000Z",
      endsAt: null,
      updatedAt: "2026-08-24T09:00:00.000Z",
      locations: [],
    });
    expect(event.id).toBe("workspace-42");
  });

  it("gives an event with no end a zero-length span rather than an invalid one", async () => {
    const event = publicEventToCalendarEvent({
      id: 1,
      name: "X",
      description: null,
      startsAt: "2026-09-01T10:00:00.000Z",
      endsAt: null,
      updatedAt: "2026-08-24T09:00:00.000Z",
      locations: [],
    });
    expect(event.end.dateTime).toBe(event.start.dateTime);
  });
});

describe("the member's internal view", () => {
  it("shows the member's own teams' events, public and internal alike", async () => {
    const internal = await make({ name: "Interno da Fotografia", isPublic: false });
    const seen = await getMemberInternalEvents(MEMBER_A);
    expect(seen.some((event) => event.id === internal)).toBe(true);
  });

  it("does NOT show another team's internal events", async () => {
    // The tightening over the Notion view this replaces, which showed every team's internal
    // events to anyone holding `activities.viewInternal`.
    const other = await make({ name: "Interno dos Visuais", departmentName: TEAM_B });
    expect((await getMemberInternalEvents(MEMBER_A)).some((event) => event.id === other)).toBe(
      false
    );
  });

  it("shows nothing at all to someone in no team", async () => {
    await make({ isPublic: true });
    expect(await getMemberInternalEvents("ist0000000")).toEqual([]);
  });

  it("honours a temporary grant, without knowing grants exist", async () => {
    // The reader goes through get_user_team_scopes, which unions memberships with live grants
    // (#184) — so this works with no code here mentioning them.
    const other = await make({ name: "Interno dos Visuais", departmentName: TEAM_B });
    expect((await getMemberInternalEvents(MEMBER_A)).some((event) => event.id === other)).toBe(
      false
    );

    await owner.query(
      `INSERT INTO neiist.team_access_grants
         (grantee_istid, department_name, access, granted_by_istid, reason, expires_at)
       VALUES ($1, $2, 'member', $3, 'teste', NOW() + INTERVAL '7 days')`,
      [MEMBER_A, TEAM_B, AUTHOR]
    );

    expect((await getMemberInternalEvents(MEMBER_A)).some((event) => event.id === other)).toBe(
      true
    );

    await owner.query("DELETE FROM neiist.team_access_grants WHERE grantee_istid = $1", [MEMBER_A]);
  });

  it("omits events that are well in the past", async () => {
    const past = await make({ name: "Antigo", startsAt: inHours(-72) });
    expect((await getMemberInternalEvents(MEMBER_A)).some((event) => event.id === past)).toBe(
      false
    );
  });
});

describe("the Google Calendar adapter (#129 slice D)", () => {
  const sample = {
    id: 42,
    name: "Semana Informática",
    description: "Talks",
    startsAt: "2026-09-01T10:00:00.000Z",
    endsAt: "2026-09-05T18:00:00.000Z",
    updatedAt: "2026-08-24T09:00:00.000Z",
    locations: ["Alameda", "Online"],
  };

  it("marks the event public, so the sink's own filter passes it", async () => {
    // syncEventsToCalendarBatched drops anything not `public` (#202). These come from
    // getPublicInternalEvents, which filters WHERE is_public in SQL — but the flag is set
    // explicitly rather than left to a default, so the sink has a value to act on.
    const { publicEventToNotionShape } = await import("@/utils/db/eventQueries");
    expect(publicEventToNotionShape(sample).public).toBe(true);
  });

  it("carries updated_at, so an edited event actually refreshes the calendar entry", async () => {
    // The sync compares this against what it stored last time. Without it, editing an event in
    // the workspace would leave a stale entry on every member's calendar forever.
    const { publicEventToNotionShape } = await import("@/utils/db/eventQueries");
    expect(publicEventToNotionShape(sample).lastEditedTime).toBe(sample.updatedAt);
  });

  it("is typed Event, never Meeting", async () => {
    // syncEventToCalendar only includes a Meeting when the user is one of its attendees. A public
    // event typed as a meeting would silently reach nobody's calendar.
    const { publicEventToNotionShape } = await import("@/utils/db/eventQueries");
    expect(publicEventToNotionShape(sample).type).toBe("Event");
  });

  it("prefixes the id so it cannot collide with a Notion page id", async () => {
    const { publicEventToNotionShape } = await import("@/utils/db/eventQueries");
    expect(publicEventToNotionShape(sample).id).toBe("workspace-42");
  });

  it("keeps the real updated_at from the database, not a fabricated one", async () => {
    // End to end: create, read back through the public reader, adapt. If updated_at were dropped
    // anywhere in that chain this would fall back to startsAt and the staleness bug returns.
    const id = await make({ name: "Para o calendário", isPublic: true });
    const { publicEventToNotionShape } = await import("@/utils/db/eventQueries");
    const row = (await getPublicInternalEvents()).find((event) => event.id === id);
    expect(row).toBeDefined();
    expect(publicEventToNotionShape(row!).lastEditedTime).toBe(row!.updatedAt);
    expect(new Date(row!.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it("moves updated_at when the event is edited, via the trigger", async () => {
    // update_event_notes was the only thing setting updated_at, so renaming an event or changing
    // its date left the calendar entry stale. A BEFORE UPDATE trigger now covers every column.
    const id = await make({ name: "Antes", isPublic: true });
    const before = (await getPublicInternalEvents()).find((event) => event.id === id)!.updatedAt;

    await owner.query("UPDATE neiist.internal_events SET name = 'Depois' WHERE id = $1", [id]);

    const after = (await getPublicInternalEvents()).find((event) => event.id === id)!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
