import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addValidDepartmentRole,
  removeValidDepartmentRole,
  updateValidDepartmentRole,
  countDepartmentRoleMembers,
} from "@/utils/db/userQueries";

/**
 * #158. The guard under test is the one that stops an admin locking everyone out of their own
 * site — demonstrated against the dev database before the fix: removing every access='admin'
 * role in a loop left zero admin roles and zero users with admin, and since managing roles
 * requires admin or coordinator, recovery meant a psql session against production.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const DEPT = "Dev-Team";
const ROLE_A = "ZZ Test Admin Role";
const ROLE_B = "ZZ Test Second Admin";
const MEMBER_ROLE = "ZZ Test Member Role";
const TEST_ISTID = "ist9990904";
/**
 * An actor who may grant `admin` (#193).
 *
 * These tests create `admin`-level roles, which now requires the caller to already hold admin.
 * Their authority comes from a `ZZ Test%` role, so `isolateAdminRoles` — which parks every real
 * admin role — leaves it alone, and the last-admin guard below still sees only fixture roles.
 */
const ADMIN_ACTOR = "ist9990905";

let owner: Client;

/** How many active roles grant admin, so a test can assert the guard's actual precondition. */
const adminRoleCount = async (): Promise<number> => {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*)::TEXT FROM neiist.valid_department_roles WHERE access = 'admin' AND active"
  );
  return Number(rows[0].count);
};

/** Park every real admin role so the fixture roles are the only ones that grant admin. */
const isolateAdminRoles = async (): Promise<void> => {
  await owner.query(
    `UPDATE neiist.valid_department_roles SET active = FALSE
     WHERE access = 'admin' AND active AND role_name NOT LIKE 'ZZ Test%'`
  );
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Role Test', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [TEST_ISTID, `${TEST_ISTID}@tecnico.ulisboa.pt`]
  );
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Role Test Admin', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [ADMIN_ACTOR, `${ADMIN_ACTOR}@tecnico.ulisboa.pt`]
  );
});

/**
 * Give ADMIN_ACTOR real admin authority, as the owner role — deliberately not through
 * `addValidDepartmentRole`, since that is the very function under test and it would need an
 * admin to already exist.
 */
const grantActorAdmin = async (roleName: string): Promise<void> => {
  await owner.query(
    `INSERT INTO neiist.valid_department_roles (department_name, role_name, access, active)
     VALUES ($1, $2, 'admin', TRUE) ON CONFLICT DO NOTHING`,
    [DEPT, roleName]
  );
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, $3)", [
    ADMIN_ACTOR,
    DEPT,
    roleName,
  ]);
};

afterEach(async () => {
  // Restore everything this file touched, including the real admin roles it parks.
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [
    [TEST_ISTID, ADMIN_ACTOR],
  ]);
  await owner.query("DELETE FROM neiist.valid_department_roles WHERE role_name LIKE 'ZZ Test%'");
  await owner.query(
    "UPDATE neiist.valid_department_roles SET active = TRUE WHERE access = 'admin' AND NOT active"
  );
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [[TEST_ISTID, ADMIN_ACTOR]]);
  await owner.end();
});

describe("changing a department role's access level", () => {
  it("changes the access level without touching memberships", async () => {
    await addValidDepartmentRole(ADMIN_ACTOR, DEPT, MEMBER_ROLE, "member");
    await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, $3)", [
      TEST_ISTID,
      DEPT,
      MEMBER_ROLE,
    ]);
    expect(await countDepartmentRoleMembers(DEPT, MEMBER_ROLE)).toBe(1);

    await updateValidDepartmentRole(ADMIN_ACTOR, DEPT, MEMBER_ROLE, "shop_manager");

    // The membership survives — the point of the change. Deleting and re-adding the role, which
    // was the only way to do this before, stamps to_date on every current membership.
    expect(await countDepartmentRoleMembers(DEPT, MEMBER_ROLE)).toBe(1);
    const { rows } = await owner.query<{ roles: string[] }>(
      "SELECT roles FROM neiist.get_user($1::VARCHAR(50))",
      [TEST_ISTID]
    );
    expect(rows[0].roles).toContain("shop_manager");
  });

  it("supports shop_manager, which the old TypeScript union omitted", async () => {
    await addValidDepartmentRole(ADMIN_ACTOR, DEPT, MEMBER_ROLE, "shop_manager");
    const { rows } = await owner.query<{ access: string }>(
      "SELECT access::TEXT FROM neiist.valid_department_roles WHERE role_name = $1",
      [MEMBER_ROLE]
    );
    expect(rows[0].access).toBe("shop_manager");
  });

  it("reports a role that does not exist", async () => {
    await expect(
      updateValidDepartmentRole(ADMIN_ACTOR, DEPT, "ZZ Test Nonexistent", "member")
    ).rejects.toMatchObject({ code: "NEI06" });
  });
});

describe("the last-admin lockout guard", () => {
  it("refuses to remove the only role granting admin", async () => {
    await grantActorAdmin(ROLE_A);
    await isolateAdminRoles();
    expect(await adminRoleCount()).toBe(1);

    await expect(removeValidDepartmentRole(DEPT, ROLE_A)).rejects.toMatchObject({ code: "NEI07" });
    expect(await adminRoleCount()).toBe(1);
  });

  it("refuses to demote the only role granting admin", async () => {
    await grantActorAdmin(ROLE_A);
    await isolateAdminRoles();

    await expect(
      updateValidDepartmentRole(ADMIN_ACTOR, DEPT, ROLE_A, "member")
    ).rejects.toMatchObject({
      code: "NEI07",
    });
    expect(await adminRoleCount()).toBe(1);
  });

  it("allows removing an admin role while another one remains", async () => {
    await grantActorAdmin(ROLE_A);
    await grantActorAdmin(ROLE_B);
    await isolateAdminRoles();
    expect(await adminRoleCount()).toBe(2);

    await removeValidDepartmentRole(DEPT, ROLE_A);
    expect(await adminRoleCount()).toBe(1);
  });

  it("allows promoting a role to admin, and demoting it again while another remains", async () => {
    await grantActorAdmin(ROLE_A);
    await addValidDepartmentRole(ADMIN_ACTOR, DEPT, ROLE_B, "member");
    await isolateAdminRoles();

    await updateValidDepartmentRole(ADMIN_ACTOR, DEPT, ROLE_B, "admin");
    expect(await adminRoleCount()).toBe(2);

    await updateValidDepartmentRole(ADMIN_ACTOR, DEPT, ROLE_B, "member");
    expect(await adminRoleCount()).toBe(1);
  });

  /** A non-admin role is unaffected by the guard — it cannot cause a lockout. */
  it("does not block removing a non-admin role when no admin role would be left", async () => {
    await addValidDepartmentRole(ADMIN_ACTOR, DEPT, MEMBER_ROLE, "member");
    await owner.query(
      "UPDATE neiist.valid_department_roles SET active = FALSE WHERE access = 'admin' AND active"
    );
    expect(await adminRoleCount()).toBe(0);

    await expect(removeValidDepartmentRole(DEPT, MEMBER_ROLE)).resolves.toBe(true);
  });
});
