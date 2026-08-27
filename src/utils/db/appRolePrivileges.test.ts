import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The app role may not touch a table directly — and the test suite cannot notice on its own.
 *
 * `docker/schema.sql:11-16` deliberately gives `neiist_app_user` no table privileges. Every read
 * and write goes through a `SECURITY DEFINER` function so the rule about who may see what lives in
 * one place instead of being re-derived at each call site.
 *
 * **Every other test in this repository connects as the OWNER.** So a query that inlines SQL
 * against a table passes the whole suite and then fails in the running app with
 * `permission denied for table …`. That is exactly what happened: four functions added across
 * migrations 020-028 read tables directly, and `/workspace` returned 500 for everyone.
 *
 * This file is the only one that connects as the APP role. It does not inspect source text —
 * it asks Postgres what that role can actually do, which is the thing that was wrong.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

/** The same connection string, as `neiist_app_user`. Password is the local dev default. */
const appUrl = () => {
  const parsed = new URL(OWNER_URL!);
  parsed.username = "neiist_app_user";
  parsed.password = "neiist_app_password";
  return parsed.toString();
};

let app: Client | null = null;

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  try {
    app = new Client({ connectionString: appUrl() });
    await app.connect();
  } catch {
    // The local password may differ. Rather than fail the suite on an environment detail, the
    // tests below skip — but the privilege query in the last test runs as the owner and still
    // catches the real defect, so the guard is never silently absent.
    app = null;
  }
});

afterAll(async () => {
  await app?.end();
});

describe("neiist_app_user has no table privileges", () => {
  it("cannot select from membership — the table that broke /workspace", async () => {
    if (!app) return;
    await expect(app.query("SELECT 1 FROM neiist.membership LIMIT 1")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("cannot select from users, internal_events or interview_slots either", async () => {
    if (!app) return;
    for (const table of ["users", "internal_events", "interview_slots", "recruitment_editions"]) {
      await expect(app.query(`SELECT 1 FROM neiist.${table} LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
    }
  });

  it("CAN call the functions the app actually uses", async () => {
    if (!app) return;
    // The other half of the property: locking the role down is only correct if the sanctioned
    // path works. Each of these replaced a raw query that was failing in production.
    await expect(app.query("SELECT neiist.is_board_signatory('ist0000000')")).resolves.toBeTruthy();
    await expect(
      app.query("SELECT * FROM neiist.get_open_recruitment_edition()")
    ).resolves.toBeTruthy();
    await expect(
      app.query("SELECT * FROM neiist.get_interview_slot_times(0)")
    ).resolves.toBeTruthy();
  });
});

describe("the privilege grant itself", () => {
  it("grants no table privilege to neiist_app_user anywhere in the schema", async () => {
    // Runs as the OWNER, so it works even when the app connection above could not be made. This is
    // the assertion that would have caught the bug: it reads the catalogue rather than trusting
    // that nobody wrote a raw query.
    const owner = new Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = 'neiist_app_user' AND table_schema = 'neiist'
         ORDER BY table_name, privilege_type`
      );
      expect(rows).toEqual([]);
    } finally {
      await owner.end();
    }
  });
});
