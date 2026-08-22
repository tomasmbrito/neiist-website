import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUserTeamScopes } from "@/utils/db/userQueries";
import { UserRole } from "@/types/user";

/**
 * #180 and #181, against the real database.
 *
 * The unit tests in teamPermissions.test.ts pin the decision rule; these pin the data it is fed,
 * which is where the original bug actually lived — `get_user` flattens access across teams, so
 * no caller could tell Fotografia-member from Divulgação-coordinator.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const ANA = "ist9990920";

let owner: Client;

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = $1", [ANA]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [ANA]);
  await owner.query("SELECT neiist.add_user($1::VARCHAR(50), 'Ana Scopes', $2)", [
    ANA,
    `${ANA}@tecnico.ulisboa.pt`,
  ]);
  await owner
    .query("SELECT neiist.add_valid_department_role('Fotografia', 'Membro', 'member')")
    .catch(() => undefined);
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Fotografia', 'Membro')", [
    ANA,
  ]);
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Divulgação', 'Coordenador')", [
    ANA,
  ]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = $1", [ANA]);
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [ANA]);
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [ANA]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [ANA]);
  await owner.end();
});

describe("getUserTeamScopes (#180)", () => {
  it("reports the access level held in EACH team, not a union", async () => {
    const scopes = await getUserTeamScopes(ANA);
    const byTeam = Object.fromEntries(scopes.map((s) => [s.departmentName, s.access]));

    expect(byTeam["Fotografia"]).toBe(UserRole._MEMBER);
    expect(byTeam["Divulgação"]).toBe(UserRole._COORDINATOR);
  });

  it("returns nothing for a user with no memberships", async () => {
    expect(await getUserTeamScopes("ist000000000")).toEqual([]);
  });

  /**
   * A member who left keeps no access — the liveness rule get_user already applies
   * (to_date IS NULL OR to_date > CURRENT_DATE).
   *
   * Ended *today*, not yesterday: from_date is today, so an earlier to_date would violate
   * valid_member_dates. Today is both a valid end date after #181 and genuinely "ended" under
   * that rule, which makes this the same case a coordinator hits undoing a mistake.
   */
  it("excludes a membership that has ended", async () => {
    await owner.query(
      `UPDATE neiist.membership SET to_date = CURRENT_DATE
       WHERE user_istid = $1 AND department_name = 'Divulgação'`,
      [ANA]
    );
    try {
      const scopes = await getUserTeamScopes(ANA);
      expect(scopes.map((s) => s.departmentName)).not.toContain("Divulgação");
      expect(scopes.map((s) => s.departmentName)).toContain("Fotografia");
    } finally {
      await owner.query(
        `UPDATE neiist.membership SET to_date = NULL
         WHERE user_istid = $1 AND department_name = 'Divulgação'`,
        [ANA]
      );
    }
  });
});

describe("same-day membership correction (#181)", () => {
  /**
   * add_team_member sets from_date = CURRENT_DATE and remove_team_member sets to_date =
   * CURRENT_DATE, against a CHECK that demanded to_date > from_date. So a coordinator who added
   * the wrong person could not undo it until the next day, and the violation surfaced as a 500.
   */
  it("lets a member added today be removed today", async () => {
    const temp = "ist9990921";
    await owner.query("SELECT neiist.add_user($1::VARCHAR(50), 'Same Day', $2)", [
      temp,
      `${temp}@tecnico.ulisboa.pt`,
    ]);
    try {
      await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Fotografia', 'Membro')", [
        temp,
      ]);
      await expect(
        owner.query("SELECT neiist.remove_team_member($1::VARCHAR(50), 'Fotografia', 'Membro')", [
          temp,
        ])
      ).resolves.toBeDefined();
    } finally {
      await owner.query("DELETE FROM neiist.membership WHERE user_istid = $1", [temp]);
      await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [temp]);
      await owner.query("DELETE FROM neiist.users WHERE istid = $1", [temp]);
    }
  });

  /** The invariant that actually matters is still enforced: an end never precedes a start. */
  it("still rejects an end date before the start date", async () => {
    await expect(
      owner.query(
        `UPDATE neiist.membership SET to_date = from_date - 1
         WHERE user_istid = $1 AND department_name = 'Fotografia'`,
        [ANA]
      )
    ).rejects.toMatchObject({ constraint: "valid_member_dates" });
  });
});
