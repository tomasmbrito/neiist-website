import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * #210 — importing the Notion events, idempotently.
 *
 * The mapping is tested separately against recorded payloads (`eventImportMapping.test.ts`).
 * This file tests the *write*, and the property that matters is **running it twice changes
 * nothing** — because the importer will be run more than once before the output looks right, and
 * 52 events silently becoming 104 is the failure that would not be noticed until somebody opened
 * the workspace.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM = "Dev-Team";
const HELPER = "Visuais";
const AUTHOR = "ist9994501";
const ATTENDEE = "ist9994502";
const PAGE = "zz24a4ecf9fdeb81fbbb43000bcc6aa433";

let owner: Client;

const importEvent = (over: Partial<Record<string, unknown>> = {}) => {
  const input = {
    page: PAGE,
    kind: "meeting",
    name: "Reunião importada",
    startsAt: "2026-09-01T18:00:00Z",
    endsAt: "2026-09-01T19:00:00Z",
    visibility: "teams",
    department: TEAM,
    locations: ["Alameda"],
    attendees: [ATTENDEE],
    collaborators: [] as string[],
    ...over,
  };
  return owner.query<{ import_internal_event: number }>(
    `SELECT neiist.import_internal_event(
       $1::TEXT, $2::TEXT, $3::TEXT, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ,
       $6::neiist.event_visibility_enum, $7::VARCHAR(30), $8::VARCHAR(50),
       $9::TEXT[], $10::VARCHAR(50)[], $11::VARCHAR(30)[])`,
    [
      input.page,
      input.kind,
      input.name,
      input.startsAt,
      input.endsAt,
      input.visibility,
      input.department,
      AUTHOR,
      input.locations,
      input.attendees,
      input.collaborators,
    ]
  );
};

const countImported = async () => {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::INT AS n FROM neiist.internal_events WHERE notion_page_id LIKE 'zz%'"
  );
  return rows[0].n;
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  for (const istid of [AUTHOR, ATTENDEE]) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), 'Importador', $2)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, `${istid}@tecnico.ulisboa.pt`]
    );
  }
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE notion_page_id LIKE 'zz%'");
});

afterAll(async () => {
  // Events reference the author, so they go first — otherwise the user delete trips the FK.
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = ANY($1)", [
    [AUTHOR, ATTENDEE],
  ]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [[AUTHOR, ATTENDEE]]);
  await owner.end();
});

describe("idempotence — the property the whole design turns on", () => {
  it("imports once and updates on a second run, rather than duplicating", async () => {
    const first = await importEvent();
    const second = await importEvent();
    expect(second.rows[0].import_internal_event).toBe(first.rows[0].import_internal_event);
    expect(await countImported()).toBe(1);
  });

  it("picks up a change made in Notion between runs", async () => {
    await importEvent();
    await importEvent({ name: "Reunião renomeada", visibility: "owner" });

    const { rows } = await owner.query<{ name: string; visibility: string }>(
      "SELECT name, visibility::TEXT AS visibility FROM neiist.internal_events WHERE notion_page_id = $1",
      [PAGE]
    );
    expect(rows[0]).toMatchObject({ name: "Reunião renomeada", visibility: "owner" });
    expect(await countImported()).toBe(1);
  });

  it("replaces locations rather than accumulating them", async () => {
    // A merge would make a removal in Notion invisible here forever — the event would keep a
    // location nobody can see any more, and re-running would never fix it.
    await importEvent({ locations: ["Alameda", "Tagus"] });
    await importEvent({ locations: ["Online"] });

    const { rows } = await owner.query<{ name: string }>(
      `SELECT l.location AS name FROM neiist.event_locations l
       JOIN neiist.internal_events e ON e.id = l.event_id
       WHERE e.notion_page_id = $1 ORDER BY l.location`,
      [PAGE]
    );
    expect(rows.map((r) => r.name)).toEqual(["Online"]);
  });

  it("leaves rows created in the website alone", async () => {
    // #137 needs to tell imported rows from native ones. A native row has notion_page_id NULL,
    // and the partial unique index is what lets many of them coexist.
    const native = await owner.query<{ id: number }>(
      `SELECT neiist.create_internal_event('meeting', 'Reunião nativa', NULL,
         NOW() + INTERVAL '2 days', NULL, FALSE, $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
      [TEAM, AUTHOR]
    );
    const second = await owner.query<{ id: number }>(
      `SELECT neiist.create_internal_event('meeting', 'Outra nativa', NULL,
         NOW() + INTERVAL '3 days', NULL, FALSE, $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
      [TEAM, AUTHOR]
    );
    await importEvent();

    // Two NULL-keyed rows coexist, and the import touched neither.
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.internal_events WHERE id = ANY($1) AND notion_page_id IS NULL",
      [[native.rows[0].id, second.rows[0].id]]
    );
    expect(rows[0].n).toBe(2);
    await owner.query("DELETE FROM neiist.internal_events WHERE id = ANY($1)", [
      [native.rows[0].id, second.rows[0].id],
    ]);
  });
});

describe("failing loudly rather than quietly", () => {
  it("REFUSES an unknown department instead of dropping the event", async () => {
    await expect(importEvent({ department: "Equipa Que Não Existe" })).rejects.toMatchObject({
      code: "NEI15",
    });
    expect(await countImported()).toBe(0);
  });

  it("refuses an invalid kind", async () => {
    await expect(importEvent({ kind: "party" })).rejects.toMatchObject({ code: "NEI14" });
  });
});

describe("attendees are reported, never invented", () => {
  it("keeps the event when an attendee has no account", async () => {
    // Following #129: losing a whole event over one stale roster entry is worse than importing it
    // with one attendee missing. The script prints who was skipped.
    const result = await importEvent({ attendees: [ATTENDEE, "ist0000000"] });
    expect(result.rows[0].import_internal_event).toBeGreaterThan(0);

    const { rows } = await owner.query<{ user_istid: string }>(
      `SELECT a.user_istid FROM neiist.event_attendees a
       JOIN neiist.internal_events e ON e.id = a.event_id
       WHERE e.notion_page_id = $1`,
      [PAGE]
    );
    expect(rows.map((r) => r.user_istid)).toEqual([ATTENDEE]);
  });

  it("does not create a user to satisfy the foreign key", async () => {
    await importEvent({ attendees: ["ist0000000"] });
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.users WHERE istid = 'ist0000000'"
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("collaborating teams (#219)", () => {
  it("records them, and never the owner itself", async () => {
    // "Coordenação/Direção" maps to Direção plus every team; the owner appearing in its own
    // collaborator list would make event_teams return a duplicate.
    await importEvent({ department: TEAM, collaborators: [HELPER, TEAM] });
    const { rows } = await owner.query<{ department_name: string }>(
      `SELECT c.department_name FROM neiist.event_collaborating_teams c
       JOIN neiist.internal_events e ON e.id = c.event_id
       WHERE e.notion_page_id = $1`,
      [PAGE]
    );
    expect(rows.map((r) => r.department_name)).toEqual([HELPER]);
  });

  it("replaces them on a re-run", async () => {
    await importEvent({ collaborators: [HELPER] });
    await importEvent({ collaborators: [] });
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::INT AS n FROM neiist.event_collaborating_teams c
       JOIN neiist.internal_events e ON e.id = c.event_id
       WHERE e.notion_page_id = $1`,
      [PAGE]
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("the /activities duplicate check", () => {
  it("reports a page the old Notion sync already publishes", async () => {
    // `neiist.activities.id` IS the Notion page id, which makes this exact rather than a guess
    // about matching titles and dates.
    await owner.query(
      `INSERT INTO neiist.activities (id, title, last_edited_time)
       VALUES ($1, 'Já publicado', NOW()) ON CONFLICT (id) DO NOTHING`,
      [PAGE]
    );
    const { rows } = await owner.query<{ activity_exists: boolean }>(
      "SELECT neiist.activity_exists($1::TEXT)",
      [PAGE]
    );
    expect(rows[0].activity_exists).toBe(true);
    await owner.query("DELETE FROM neiist.activities WHERE id = $1", [PAGE]);
  });

  it("says no for a page it has never seen", async () => {
    const { rows } = await owner.query<{ activity_exists: boolean }>(
      "SELECT neiist.activity_exists($1::TEXT)",
      ["nope"]
    );
    expect(rows[0].activity_exists).toBe(false);
  });
});
