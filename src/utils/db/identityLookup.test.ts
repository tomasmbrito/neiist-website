import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByAnyEmail } from "@/utils/db/userQueries";

/**
 * #124 — how the Google login path resolves an address to an account.
 *
 * The distinction under test is the whole point: matching the *primary* (Fenix) email is the
 * account, unambiguously. Matching a verified *alternative* email is a linking prompt, because
 * signing in with Google proves control of the Google address, not of the Técnico account that
 * address is recorded against.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const ISTID = "ist9990906";
const PRIMARY = "ist9990906@tecnico.ulisboa.pt";
const ALTERNATIVE = "pessoal.teste.9990906@gmail.com";

let owner: Client;

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [ISTID]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [ISTID]);
  await owner.query("SELECT neiist.add_user($1::VARCHAR(50), 'Identity Test', $2)", [
    ISTID,
    PRIMARY,
  ]);
  // Reaches user_contacts only through the verified email_token flow in production; inserted
  // directly here because this test is about the lookup, not the verification flow.
  await owner.query(
    `INSERT INTO neiist.user_contacts (user_istid, contact_type, contact_value)
     VALUES ($1, 'alt_email', $2)
     ON CONFLICT (user_istid, contact_type) DO UPDATE SET contact_value = EXCLUDED.contact_value`,
    [ISTID, ALTERNATIVE]
  );
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [ISTID]);
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [ISTID]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [ISTID]);
  await owner.end();
});

describe("findUserByAnyEmail", () => {
  it("reports a primary-email match as the account", async () => {
    const match = await findUserByAnyEmail(PRIMARY);
    expect(match).toEqual({ istid: ISTID, matchedPrimaryEmail: true });
  });

  /**
   * The case #124 exists for: a student whose Google account is their personal address, already
   * recorded as their alternative email. Before this, they got a second `ext_` account.
   */
  it("reports an alternative-email match as NOT primary, so the caller can prompt", async () => {
    const match = await findUserByAnyEmail(ALTERNATIVE);
    expect(match).toEqual({ istid: ISTID, matchedPrimaryEmail: false });
  });

  it("returns null for an unknown address, which is the create-an-account case", async () => {
    expect(await findUserByAnyEmail("nobody.at.all@example.com")).toBeNull();
  });

  it("matches case-insensitively, because email domains are", async () => {
    const match = await findUserByAnyEmail(ALTERNATIVE.toUpperCase());
    expect(match).toEqual({ istid: ISTID, matchedPrimaryEmail: false });
  });

  /**
   * If an address is somehow both someone's primary and another account's alternative, the
   * primary must win — it is the stronger claim, and the alternative is user-supplied.
   */
  it("prefers a primary match over an alternative one", async () => {
    const other = "ist9990907";
    await owner.query("SELECT neiist.add_user($1::VARCHAR(50), 'Other', $2)", [other, ALTERNATIVE]);
    try {
      const match = await findUserByAnyEmail(ALTERNATIVE);
      expect(match).toEqual({ istid: other, matchedPrimaryEmail: true });
    } finally {
      await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [other]);
      await owner.query("DELETE FROM neiist.users WHERE istid = $1", [other]);
    }
  });
});
