import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addValidDepartmentRole, updateValidDepartmentRole } from "@/utils/db/userQueries";

/**
 * #193 — the escalation, in the database.
 *
 * `members.roles.manage` is held by coordinators, `PATCH /api/admin/roles` checked only that, and
 * `update_valid_department_role` took no actor at all. So a coordinator pointed the endpoint at
 * **their own role**, raised it to `admin`, and became an organisation-wide administrator: the
 * full user directory, department and role management, every team's workspace.
 *
 * The API-level guard matters for the message; this file pins the one that cannot be routed
 * around, because the route is not the only caller.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const DEPT = "Divulgação";
const COORD = "ist9993001"; // coordinator by membership — the attacker
const ADMIN = "ist9993002"; // a genuine admin
const COORD_ROLE = "ZZ P0 Coordinator";
const ADMIN_ROLE = "ZZ P0 Admin";
const TARGET_ROLE = "ZZ P0 Target";

let owner: Client;

const accessOf = async (role: string): Promise<string | null> => {
  const { rows } = await owner.query<{ access: string }>(
    "SELECT access FROM neiist.valid_department_roles WHERE department_name = $1 AND role_name = $2",
    [DEPT, role]
  );
  return rows[0]?.access ?? null;
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();

  for (const [istid, name] of [
    [COORD, "P0 Coordinator"],
    [ADMIN, "P0 Admin"],
  ]) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), $2, $3)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, name, `${istid}@tecnico.ulisboa.pt`]
    );
  }

  // Seeded by the owner rather than through the functions under test, so the fixture cannot be
  // invalidated by the guard it exists to test.
  await owner.query(
    `INSERT INTO neiist.valid_department_roles (department_name, role_name, access, active)
     VALUES ($1, $2, 'coordinator', TRUE), ($1, $3, 'admin', TRUE), ($1, $4, 'member', TRUE)
     ON CONFLICT DO NOTHING`,
    [DEPT, COORD_ROLE, ADMIN_ROLE, TARGET_ROLE]
  );
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, $3)", [
    COORD,
    DEPT,
    COORD_ROLE,
  ]);
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, $3)", [
    ADMIN,
    DEPT,
    ADMIN_ROLE,
  ]);
});

afterEach(async () => {
  await owner.query(
    "UPDATE neiist.valid_department_roles SET access = 'member' WHERE department_name = $1 AND role_name = $2",
    [DEPT, TARGET_ROLE]
  );
  await owner.query(
    "UPDATE neiist.valid_department_roles SET access = 'coordinator' WHERE department_name = $1 AND role_name = $2",
    [DEPT, COORD_ROLE]
  );
  await owner.query("DELETE FROM neiist.valid_department_roles WHERE role_name LIKE 'ZZ P0 New%'");
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [[COORD, ADMIN]]);
  await owner.query("DELETE FROM neiist.valid_department_roles WHERE role_name LIKE 'ZZ P0 %'");
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [[COORD, ADMIN]]);
  await owner.end();
});

describe("only an admin may grant admin access (#193)", () => {
  it("refuses a coordinator promoting THEIR OWN role to admin", async () => {
    // The exact escalation, in one line. Before the fix this returned success and the caller
    // became an organisation-wide administrator on their next request.
    await expect(updateValidDepartmentRole(COORD, DEPT, COORD_ROLE, "admin")).rejects.toMatchObject(
      { code: "NEI13" }
    );
    expect(await accessOf(COORD_ROLE)).toBe("coordinator");
  });

  it("refuses a coordinator promoting any other role to admin", async () => {
    await expect(
      updateValidDepartmentRole(COORD, DEPT, TARGET_ROLE, "admin")
    ).rejects.toMatchObject({ code: "NEI13" });
    expect(await accessOf(TARGET_ROLE)).toBe("member");
  });

  it("refuses a coordinator CREATING a role with admin access", async () => {
    // The other half. Fixing only the update would leave the same escalation one call away.
    await expect(
      addValidDepartmentRole(COORD, DEPT, "ZZ P0 New Admin", "admin")
    ).rejects.toMatchObject({ code: "NEI13" });
    expect(await accessOf("ZZ P0 New Admin")).toBeNull();
  });

  it("still lets a coordinator manage roles at every other level", async () => {
    // The fix must not break real work: coordinators legitimately run their teams' roles. The
    // problem was only the `admin` value, which is ORGANISATION_WIDE.
    await expect(updateValidDepartmentRole(COORD, DEPT, TARGET_ROLE, "coordinator")).resolves.toBe(
      true
    );
    expect(await accessOf(TARGET_ROLE)).toBe("coordinator");

    await expect(updateValidDepartmentRole(COORD, DEPT, TARGET_ROLE, "shop_manager")).resolves.toBe(
      true
    );
    await expect(addValidDepartmentRole(COORD, DEPT, "ZZ P0 New Member", "member")).resolves.toBe(
      true
    );
  });

  it("lets a genuine admin grant admin", async () => {
    await expect(updateValidDepartmentRole(ADMIN, DEPT, TARGET_ROLE, "admin")).resolves.toBe(true);
    expect(await accessOf(TARGET_ROLE)).toBe("admin");
  });

  it("refuses an unknown or absent actor", async () => {
    // Fail closed. A caller the database has never heard of must not be treated as privileged,
    // and NULL — used by the two internal call sites that have no actor to thread — must not be
    // able to reach admin either.
    await expect(
      updateValidDepartmentRole("ist0000000", DEPT, TARGET_ROLE, "admin")
    ).rejects.toMatchObject({ code: "NEI13" });

    await expect(
      owner.query(
        "SELECT neiist.add_valid_department_role(NULL, $1, $2, 'admin'::neiist.user_access_enum)",
        [DEPT, "ZZ P0 New Null"]
      )
    ).rejects.toMatchObject({ code: "NEI13" });
  });

  it("does not let the app role reach the unguarded three-argument functions", async () => {
    // The guarded overload is only a boundary if the old one is out of reach. schema.sql grants
    // EXECUTE on everything in the schema to neiist_app_user, so this REVOKE is what makes the
    // guard enforceable rather than advisory.
    const { rows } = await owner.query<{ has: boolean }>(
      `SELECT has_function_privilege(
         'neiist_app_user',
         'neiist.update_valid_department_role(character varying,character varying,neiist.user_access_enum)',
         'EXECUTE'
       ) AS has`
    );
    expect(rows[0].has).toBe(false);
  });
});
