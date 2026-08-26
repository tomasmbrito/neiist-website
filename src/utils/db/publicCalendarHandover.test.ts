import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * #137, first slice — handing the public calendar from the Notion sync to the workspace.
 *
 * #210 imports the public Notion events as `members`, because the old Notion -> `activities` sync
 * still publishes those same pages and importing them as `public` would show each of them twice.
 * This is the handover, and it has exactly one dangerous failure mode:
 *
 *   **an `activities` row with no imported event.**
 *
 * That is a public event living only in the old sync. Promote the others, switch the sync off, and
 * it silently disappears from the students' calendar — and nobody finds out until a student turns
 * up to something that is no longer listed. So the handover refuses while any orphan exists, and
 * that refusal is what most of this file tests.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM = "Organização de Eventos";
const AUTHOR = "ist9994701";
const PAGE_A = "zzhandover0000000000000000000001";
const PAGE_B = "zzhandover0000000000000000000002";

let owner: Client;

const importEvent = async (page: string, name: string, visibility = "members") => {
  const { rows } = await owner.query<{ import_internal_event: number }>(
    `SELECT neiist.import_internal_event(
       $1::TEXT, 'event', $2::TEXT, NOW() + INTERVAL '10 days', NULL,
       $3::neiist.event_visibility_enum, $4::VARCHAR(30), $5::VARCHAR(50),
       ARRAY[]::TEXT[], ARRAY[]::VARCHAR(50)[], ARRAY[]::VARCHAR(30)[])`,
    [page, name, visibility, TEAM, AUTHOR]
  );
  return rows[0].import_internal_event;
};

const publishActivity = (page: string, title: string) =>
  owner.query(
    `INSERT INTO neiist.activities (id, title, start, last_edited_time)
     VALUES ($1, $2, NOW() + INTERVAL '10 days', NOW()) ON CONFLICT (id) DO NOTHING`,
    [page, title]
  );

const report = async () => {
  const { rows } = await owner.query<{ status: string; notion_page_id: string }>(
    "SELECT status, notion_page_id FROM neiist.public_calendar_handover_report() WHERE notion_page_id LIKE 'zz%'"
  );
  return rows;
};

const handOver = (force = false) =>
  owner.query<{ hand_over_public_calendar: number }>(
    "SELECT neiist.hand_over_public_calendar($1::BOOLEAN)",
    [force]
  );

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Importador', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [AUTHOR, `${AUTHOR}@tecnico.ulisboa.pt`]
  );
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE notion_page_id LIKE 'zz%'");
  await owner.query("DELETE FROM neiist.activities WHERE id LIKE 'zz%'");
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [AUTHOR]);
  await owner.end();
});

describe("the handover", () => {
  it("promotes an imported event and removes the sync's copy, together", async () => {
    const id = await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");

    const { rows } = await handOver();
    expect(rows[0].hand_over_public_calendar).toBe(1);

    const after = await owner.query<{ visibility: string }>(
      "SELECT visibility::TEXT AS visibility FROM neiist.internal_events WHERE id = $1",
      [id]
    );
    expect(after.rows[0].visibility).toBe("public");

    // And the sync's copy is gone, so the calendar shows it once rather than twice.
    const activity = await owner.query("SELECT 1 FROM neiist.activities WHERE id = $1", [PAGE_A]);
    expect(activity.rows).toHaveLength(0);
  });

  it("is idempotent — a second run promotes nothing", async () => {
    await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");
    await handOver();
    const second = await handOver();
    expect(second.rows[0].hand_over_public_calendar).toBe(0);
  });

  it("promotes ONLY the members-only downgrade, never a team-internal event", async () => {
    // Found by mutation. Dropping `AND e.visibility = 'members'` from the promote failed nothing,
    // because every existing test either had no activities row or was already members-only.
    //
    // It matters because `members` is not just any visibility here — it is the specific, deliberate
    // downgrade #210 applies to a page that was public in Notion. An event marked `teams` or
    // `owner` is internal on purpose, and promoting it because some stale activities row happens
    // to share its Notion id publishes an internal event to every student. That is #202 and #127
    // again, arriving through a third door.
    const id = await importEvent(PAGE_B, "Reunião interna", "teams");
    await publishActivity(PAGE_B, "Reunião interna");

    await handOver(true); // forced, so the orphan guard is not what stops it

    const after = await owner.query<{ visibility: string }>(
      "SELECT visibility::TEXT AS visibility FROM neiist.internal_events WHERE id = $1",
      [id]
    );
    expect(after.rows[0].visibility).toBe("teams");
    // And its activities row is untouched, because nothing was handed over for it.
    const activity = await owner.query("SELECT 1 FROM neiist.activities WHERE id = $1", [PAGE_B]);
    expect(activity.rows).toHaveLength(1);
  });

  it("leaves events the sync never published alone", async () => {
    // A members-only event with no activities row is members-only ON PURPOSE — it was never
    // public in Notion. Promoting it would publish something internal.
    const id = await importEvent(PAGE_B, "Reunião interna");
    await handOver();
    const after = await owner.query<{ visibility: string }>(
      "SELECT visibility::TEXT AS visibility FROM neiist.internal_events WHERE id = $1",
      [id]
    );
    expect(after.rows[0].visibility).toBe("members");
  });
});

describe("the orphan guard — the failure this exists to prevent", () => {
  it("REFUSES while the sync publishes something that was never imported", async () => {
    // Promote the others and switch the sync off, and this event silently vanishes from the
    // students' calendar. Failing loudly is the only outcome anybody notices.
    await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_B, "Jantar de Curso"); // never imported

    await expect(handOver()).rejects.toMatchObject({ code: "NEI15" });
  });

  it("changes nothing when it refuses", async () => {
    const id = await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_B, "Jantar de Curso");

    await expect(handOver()).rejects.toMatchObject({ code: "NEI15" });

    const after = await owner.query<{ visibility: string }>(
      "SELECT visibility::TEXT AS visibility FROM neiist.internal_events WHERE id = $1",
      [id]
    );
    expect(after.rows[0].visibility).toBe("members");
    const still = await owner.query("SELECT 1 FROM neiist.activities WHERE id LIKE 'zz%'");
    expect(still.rows).toHaveLength(2);
  });

  it("names the orphans in the report, so they can be fixed", async () => {
    await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_B, "Jantar de Curso");

    const rows = await report();
    expect(rows).toContainEqual({ status: "ready", notion_page_id: PAGE_A });
    expect(rows).toContainEqual({ status: "orphan_activity", notion_page_id: PAGE_B });
  });

  it("proceeds when forced, for the case where the orphans really are stale", async () => {
    // An escape hatch, but never the default: somebody has to say they know.
    await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_B, "Evento antigo");

    const { rows } = await handOver(true);
    expect(rows[0].hand_over_public_calendar).toBe(1);
  });

  it("reports nothing to do once the handover is complete", async () => {
    await importEvent(PAGE_A, "Workshop de Rust");
    await publishActivity(PAGE_A, "Workshop de Rust");
    await handOver();
    expect(await report()).toEqual([]);
  });
});
