import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addEventDocument,
  createInternalEvent,
  getEventAttendees,
  getEventDocuments,
  getEventRelations,
  getInternalEventDetail,
  relateEvents,
  removeEventAttendee,
  setEventAttendance,
  unrelateEvents,
  updateEventNotes,
} from "@/utils/db/eventQueries";

/**
 * #129 slice B, against the real database.
 *
 * Slice A established that a team's event list is scoped. The risk this slice adds is the
 * **event id**: every read and write here is addressed by one, and an id is the one thing a
 * client fully controls. So the tests that matter are the ones passing a real id belonging to
 * another team — the IDOR shape — and they should return nothing rather than relying on the
 * caller to compare owners afterwards.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM_A = "Fotografia";
const TEAM_B = "Visuais";
const AUTHOR = "ist9996001";
const GUEST = "ist9996002";

let owner: Client;
let eventA = 0;
let eventB = 0;

const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  for (const [istid, name] of [
    [AUTHOR, "Detail Author"],
    [GUEST, "Detail Guest"],
  ]) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), $2, $3)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, name, `${istid}@tecnico.ulisboa.pt`]
    );
  }
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [[AUTHOR, GUEST]]);
  await owner.end();
});

const makeIn = (team: string, name = "Reunião") =>
  createInternalEvent({
    kind: "meeting",
    name,
    startsAt: inHours(24),
    isPublic: false,
    departmentName: team,
    createdByIstid: AUTHOR,
  });

const twoEvents = async () => {
  eventA = await makeIn(TEAM_A, "A");
  eventB = await makeIn(TEAM_B, "B");
};

describe("reads are keyed by event AND team", () => {
  it("returns the event to its own team", async () => {
    await twoEvents();
    const detail = await getInternalEventDetail(eventA, TEAM_A);
    expect(detail?.name).toBe("A");
  });

  it("returns nothing for a real id belonging to another team", async () => {
    // The IDOR case. Not "returns it and the route filters" — nothing comes back at all, so a
    // route that forgot to compare owners still cannot leak another team's meeting.
    await twoEvents();
    expect(await getInternalEventDetail(eventB, TEAM_A)).toBeNull();
  });

  it("scopes attendees, documents and relations the same way", async () => {
    await twoEvents();
    await setEventAttendance(eventB, AUTHOR, "accepted");
    await addEventDocument(eventB, "ata", "Ata da reunião", "https://example.org/ata");

    // Everything about event B is invisible when asked for as if it were team A's.
    expect(await getEventAttendees(eventB, TEAM_A)).toEqual([]);
    expect(await getEventDocuments(eventB, TEAM_A)).toEqual([]);
    expect(await getEventRelations(eventB, TEAM_A)).toEqual([]);

    // …and visible to its own team, so the scoping is not just breaking the query.
    expect((await getEventAttendees(eventB, TEAM_B)).length).toBe(1);
    expect((await getEventDocuments(eventB, TEAM_B)).length).toBe(1);
  });
});

describe("agenda and minutes", () => {
  it("round-trips, and blanks become null rather than empty strings", async () => {
    const id = await makeIn(TEAM_A);
    await updateEventNotes(id, "  1. Orçamento\n2. Datas  ", "   ");

    const detail = await getInternalEventDetail(id, TEAM_A);
    expect(detail?.agenda).toBe("1. Orçamento\n2. Datas");
    // "   " must not be stored as content: a whitespace-only minute reads as "there are minutes".
    expect(detail?.minutes).toBeNull();
  });

  it("raises for an event that does not exist", async () => {
    await expect(updateEventNotes(999_999_999, "x", null)).rejects.toMatchObject({
      code: "NEI15",
    });
  });
});

describe("attendance", () => {
  it("upserts rather than duplicating", async () => {
    // "invite Ana" and "Ana said yes" are the same row at different times. Treating them as two
    // inserts is how a person ends up listed twice.
    const id = await makeIn(TEAM_A);
    await setEventAttendance(id, AUTHOR, "invited");
    await setEventAttendance(id, AUTHOR, "accepted");

    const attendees = await getEventAttendees(id, TEAM_A);
    expect(attendees).toHaveLength(1);
    expect(attendees[0].response).toBe("accepted");
  });

  it("refuses an unknown response", async () => {
    const id = await makeIn(TEAM_A);
    await expect(
      setEventAttendance(id, AUTHOR, "maybe" as unknown as "invited")
    ).rejects.toMatchObject({ code: "NEI14" });
  });

  it("refuses an unknown person", async () => {
    const id = await makeIn(TEAM_A);
    await expect(setEventAttendance(id, "ist0000000", "invited")).rejects.toMatchObject({
      code: "NEI15",
    });
  });

  it("removes an attendee", async () => {
    const id = await makeIn(TEAM_A);
    await setEventAttendance(id, AUTHOR, "invited");
    await removeEventAttendee(id, AUTHOR);
    expect(await getEventAttendees(id, TEAM_A)).toEqual([]);
  });
});

describe("documents", () => {
  it("refuses a non-http URL", async () => {
    // The value is rendered into an href. `javascript:` there is stored XSS, and `z.url()` on its
    // own would accept it — so it is refused in the schema, the CHECK, and the function.
    const id = await makeIn(TEAM_A);
    await expect(
      addEventDocument(id, "other", "Malicioso", "javascript:alert(1)")
    ).rejects.toMatchObject({ code: "NEI14" });
    await expect(addEventDocument(id, "other", "Ficheiro", "file:///etc/passwd")).rejects.toThrow();
  });

  it("refuses a blank title and an unknown kind", async () => {
    const id = await makeIn(TEAM_A);
    await expect(addEventDocument(id, "other", "   ", "https://x.pt")).rejects.toMatchObject({
      code: "NEI14",
    });
    await expect(
      addEventDocument(id, "contrato" as unknown as "other", "T", "https://x.pt")
    ).rejects.toMatchObject({ code: "NEI14" });
  });

  it("accepts a normal link", async () => {
    const id = await makeIn(TEAM_A);
    await addEventDocument(id, "plano", "Plano de Atividades", "https://drive.google.com/x");
    const documents = await getEventDocuments(id, TEAM_A);
    expect(documents).toHaveLength(1);
    expect(documents[0].kind).toBe("plano");
  });
});

describe("related events", () => {
  it("relates in both directions from a single row", async () => {
    // Stored once with the smaller id first. Two mirrored rows would be two chances to disagree.
    const first = await makeIn(TEAM_A, "Primeiro");
    const second = await makeIn(TEAM_A, "Segundo");
    await relateEvents(second, first);

    expect((await getEventRelations(first, TEAM_A)).map((r) => r.id)).toEqual([second]);
    expect((await getEventRelations(second, TEAM_A)).map((r) => r.id)).toEqual([first]);

    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.event_relations WHERE event_id = $1 OR related_event_id = $1",
      [first]
    );
    expect(rows[0].n).toBe(1);
  });

  it("is idempotent whichever order it is given", async () => {
    const first = await makeIn(TEAM_A, "Primeiro");
    const second = await makeIn(TEAM_A, "Segundo");
    await relateEvents(first, second);
    await relateEvents(second, first);
    expect(await getEventRelations(first, TEAM_A)).toHaveLength(1);
  });

  it("refuses relating an event to itself", async () => {
    const id = await makeIn(TEAM_A);
    await expect(relateEvents(id, id)).rejects.toMatchObject({ code: "NEI14" });
  });

  it("refuses relating across teams", async () => {
    // Otherwise one team's detail page would name another team's internal meeting.
    await twoEvents();
    await expect(relateEvents(eventA, eventB)).rejects.toMatchObject({ code: "NEI15" });
  });

  it("unrelates whichever order it is given", async () => {
    const first = await makeIn(TEAM_A, "Primeiro");
    const second = await makeIn(TEAM_A, "Segundo");
    await relateEvents(first, second);
    await unrelateEvents(second, first);
    expect(await getEventRelations(first, TEAM_A)).toEqual([]);
  });

  it("cascades when an event is deleted", async () => {
    const first = await makeIn(TEAM_A, "Primeiro");
    const second = await makeIn(TEAM_A, "Segundo");
    await relateEvents(first, second);
    await owner.query("DELETE FROM neiist.internal_events WHERE id = $1", [second]);
    expect(await getEventRelations(first, TEAM_A)).toEqual([]);
  });
});

describe("slice A's structural guard still holds", () => {
  it("adds no row-returning reader without a department parameter", async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'neiist'
         AND p.prosrc LIKE '%internal_events%'
         AND p.proretset
         AND p.prosrc NOT LIKE '%is_public%'
         AND pg_get_function_identity_arguments(p.oid) NOT LIKE '%character varying%'`
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  });
});
