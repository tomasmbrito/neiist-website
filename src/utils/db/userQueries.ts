import { Membership, DbMembership, mapDbMembershipToMembership } from "@/types/memberships";
import { User, UserRole, mapRoleToUserRole, mapDbUserToUser } from "@/types/user";
import { db_query } from "@/utils/db/dbClient";

export const createUser = async (user: Partial<User>): Promise<User | null> => {
  if (!user.istid || !user.name || !user.email) return null;
  try {
    const {
      rows: [newUser],
    } = await db_query<User>(
      `SELECT * FROM neiist.add_user($1::VARCHAR(50), $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT, $6::TEXT, $7::TEXT[])`,
      [
        user.istid,
        user.name,
        user.email,
        user.alternativeEmail,
        user.phone,
        user.photo,
        user.courses,
      ]
    );
    if (!newUser) return null;
    newUser.roles = newUser.roles?.map(mapRoleToUserRole);
    return newUser ? mapDbUserToUser(newUser) : null;
  } catch (error) {
    console.error("Error creating user:", error);
    return null;
  }
};

export const updateUser = async (istid: string, updates: Partial<User>): Promise<User | null> => {
  try {
    const {
      rows: [updatedUser],
    } = await db_query<User>("SELECT * FROM neiist.update_user($1::VARCHAR(50), $2::JSONB)", [
      istid,
      JSON.stringify(updates),
    ]);
    if (!updatedUser) return null;
    updatedUser.roles = updatedUser.roles?.map(mapRoleToUserRole);
    return updatedUser ? mapDbUserToUser(updatedUser) : null;
  } catch (error) {
    console.error("Error updating user:", error);
    return null;
  }
};

export const updateUserPhoto = async (istid: string, photoData: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.update_user_photo($1::VARCHAR(50), $2::TEXT)", [
      istid,
      photoData,
    ]);
    return true;
  } catch (error) {
    console.error("Error updating user photo:", error);
    return false;
  }
};

export const getUser = async (istid: string): Promise<User | null> => {
  try {
    const {
      rows: [user],
    } = await db_query<User>("SELECT * FROM neiist.get_user($1::VARCHAR(50))", [istid]);
    if (!user) return null;
    const dbMemberships = (
      await db_query<DbMembership>(
        "SELECT * FROM neiist.get_all_memberships() WHERE user_istid = $1 AND active = TRUE",
        [istid]
      )
    ).rows;

    const memberships: Membership[] = dbMemberships.map((raw, idx) =>
      mapDbMembershipToMembership(raw, user.email, user.photo, idx)
    );
    let highest: { roleName: string; position: number } | null = null;
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();

    // Role orders are fetched once per DISTINCT department, in parallel, rather than once per
    // membership in sequence. A user in five departments previously cost five awaited
    // round-trips here, and duplicates were re-fetched. getUser runs inside serverCheckRoles,
    // so this is on the path of every guarded page and API route.
    const uniqueDepartments = Array.from(new Set(memberships.map((m) => m.departmentName)));
    const roleOrders = await Promise.all(
      uniqueDepartments.map((department) =>
        db_query<{ role_name: string; position: number }>(
          "SELECT role_name, position FROM neiist.get_department_role_order($1)",
          [department]
        ).then((result) => [department, result.rows] as const)
      )
    );
    const roleOrderByDepartment = new Map(roleOrders);

    for (const membership of memberships) {
      const roleOrder = roleOrderByDepartment.get(membership.departmentName) ?? [];
      const found = roleOrder.find(
        (r) => normalize(r.role_name) === normalize(membership.roleName)
      );
      if (found) {
        if (!highest || found.position < highest.position) {
          highest = { roleName: membership.roleName, position: found.position };
        }
      }
    }

    const positionName = highest?.roleName ?? memberships[0]?.roleName ?? null;

    return {
      ...mapDbUserToUser(user),
      positionName,
    };
  } catch (error) {
    console.error("Error fetching user:", error);
    return null;
  }
};

export const getAllUsers = async (): Promise<User[]> => {
  try {
    const { rows } = await db_query<User>("SELECT * FROM neiist.get_all_users()");
    return rows.map(mapDbUserToUser);
  } catch (error) {
    console.error("Error fetching all users:", error);
    return [];
  }
};

export const addMember = async (
  istid: string,
  department = "Members",
  role = "Member"
): Promise<boolean> => {
  try {
    try {
      await db_query("SELECT neiist.add_department($1)", [department]);
      await db_query("SELECT neiist.add_team($1, $2)", [department, "General membership team"]);
      // NULL actor: this path has no caller identity to thread and creates a `member` role, so
      // it fails closed — a NULL actor can never satisfy may_grant_admin_access (#193).
      await db_query("SELECT neiist.add_valid_department_role(NULL, $1, $2, $3)", [
        department,
        role,
        "member",
      ]);
    } catch {}
    await db_query("SELECT neiist.add_team_member($1, $2, $3)", [istid, department, role]);
    return true;
  } catch (error) {
    console.error("Error adding member:", error);
    return false;
  }
};

export const addCollaborator = async (
  istid: string,
  teams: string[],
  position: string
): Promise<boolean> => {
  try {
    for (const team of teams) {
      try {
        // NULL actor, as above: fixed `coordinator` level, so it cannot reach `admin` (#193).
        await db_query("SELECT neiist.add_valid_department_role(NULL, $1, $2, $3)", [
          team,
          position,
          "coordinator",
        ]);
      } catch {}
      await db_query("SELECT neiist.add_team_member($1, $2, $3)", [istid, team, position]);
    }
    return true;
  } catch (error) {
    console.error("Error adding collaborator:", error);
    return false;
  }
};

export const removeRole = async (
  istid: string,
  department: string,
  role: string
): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.remove_team_member($1, $2, $3)", [istid, department, role]);
    return true;
  } catch (error) {
    console.error("Error removing role:", error);
    return false;
  }
};

export const getUsersByAccess = async (access: string): Promise<User[]> => {
  try {
    const { rows } = await db_query<User>(
      "SELECT istid, name, email, phone, courses, campus, photo_path as photo FROM neiist.get_users_by_access($1)",
      [access]
    );
    return rows.map(mapDbUserToUser);
  } catch (error) {
    console.error("Error fetching users by access:", error);
    return [];
  }
};

export const getDepartmentRoles = async (
  departmentName: string
): Promise<Array<{ role_name: string; access: string; active: boolean }>> => {
  try {
    const { rows } = await db_query<{
      role_name: string;
      access: string;
      active: boolean;
    }>("SELECT role_name, access, active FROM neiist.get_department_roles($1)", [departmentName]);
    return rows;
  } catch (error) {
    console.error("Error fetching department roles:", error);
    return [];
  }
};

export const addEmailVerification = async (
  istid: string,
  email: string,
  token: string,
  expiresAt: string
): Promise<void> => {
  try {
    await db_query("SELECT neiist.add_email_verification($1, $2, $3, $4)", [
      istid,
      email,
      token,
      expiresAt,
    ]);
  } catch (error) {
    console.error("Error adding email verification:", error);
    throw error;
  }
};

export const getEmailVerification = async (
  token: string
): Promise<{ istid: string; email: string; expires_at: string } | null> => {
  try {
    const {
      rows: [row],
    } = await db_query<{ istid: string; email: string; expires_at: string }>(
      "SELECT * FROM neiist.get_email_verification($1)",
      [token]
    );
    return row ?? null;
  } catch (error) {
    console.error("Error fetching email verification:", error);
    return null;
  }
};

export const deleteEmailVerification = async (token: string): Promise<void> => {
  try {
    await db_query("SELECT neiist.delete_email_verification($1)", [token]);
  } catch (error) {
    console.error("Error deleting email verification:", error);
    throw error;
  }
};

export const getEmailVerificationByUser = async (
  istid: string
): Promise<{ email: string; expires_at: string } | null> => {
  try {
    const {
      rows: [row],
    } = await db_query<{ email: string; expires_at: string }>(
      "SELECT * FROM neiist.get_email_verification_by_user($1)",
      [istid]
    );
    return row ?? null;
  } catch (error) {
    console.error("Error fetching pending alternative email:", error);
    return null;
  }
};

// Department management
export const addDepartment = async (name: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.add_department($1)", [name]);
    return true;
  } catch (error) {
    console.error("Error adding department:", error);
    return false;
  }
};

export const removeDepartment = async (name: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.remove_department($1)", [name]);
    return true;
  } catch (error) {
    console.error("Error removing department:", error);
    return false;
  }
};

export const getAllDepartments = async (): Promise<
  Array<{ name: string; department_type: string; active: boolean }>
> => {
  try {
    const { rows } = await db_query<{
      name: string;
      department_type: string;
      active: boolean;
    }>("SELECT * FROM neiist.get_all_departments()");
    return rows;
  } catch (error) {
    console.error("Error fetching departments:", error);
    return [];
  }
};

// Team management
export const addTeam = async (name: string, description: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.add_team($1, $2)", [name, description]);
    return true;
  } catch (error) {
    console.error("Error adding team:", error);
    return false;
  }
};

export const removeTeam = async (name: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.remove_team($1)", [name]);
    return true;
  } catch (error) {
    console.error("Error removing team:", error);
    return false;
  }
};

export const getAllTeams = async (): Promise<
  Array<{ name: string; description: string; active: boolean }>
> => {
  try {
    const { rows } = await db_query<{
      name: string;
      description: string;
      active: boolean;
    }>("SELECT * FROM neiist.get_all_teams()");
    return rows;
  } catch (error) {
    console.error("Error fetching teams:", error);
    return [];
  }
};

// Admin body management
export const addAdminBody = async (name: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.add_admin_body($1)", [name]);
    return true;
  } catch (error) {
    console.error("Error adding admin body:", error);
    return false;
  }
};

export const removeAdminBody = async (name: string): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.remove_admin_body($1)", [name]);
    return true;
  } catch (error) {
    console.error("Error removing admin body:", error);
    return false;
  }
};

export const getAllAdminBodies = async (): Promise<Array<{ name: string; active: boolean }>> => {
  try {
    const { rows } = await db_query<{ name: string; active: boolean }>(
      "SELECT * FROM neiist.get_all_admin_bodies()"
    );
    return rows;
  } catch (error) {
    console.error("Error fetching admin bodies:", error);
    return [];
  }
};

// Valid department roles management
/**
 * The access levels `neiist.user_access_enum` actually has.
 *
 * `shop_manager` used to be missing from this union, so the admin UI could not create a role
 * granting it even though the enum, `UserRole` and every shop guard support it.
 */
export type DepartmentRoleAccess = "admin" | "coordinator" | "shop_manager" | "member";

/**
 * Errors propagate on purpose, like `removeValidDepartmentRole` and for the same reason.
 *
 * This used to `catch { return false }`, which turned the #193 refusal — "only an administrator
 * may create a role with admin access" — into an indistinguishable falsy value, so the route
 * answered a generic failure instead of saying why. A security guard that reports itself by
 * returning something can be swallowed by any caller that was written before the guard existed;
 * that is the whole reason these rules RAISE.
 */
export const addValidDepartmentRole = async (
  actorIstid: string,
  departmentName: string,
  roleName: string,
  access: DepartmentRoleAccess = "member"
): Promise<boolean> => {
  await db_query("SELECT neiist.add_valid_department_role($1::VARCHAR(50), $2, $3, $4)", [
    actorIstid,
    departmentName,
    roleName,
    access,
  ]);
  return true;
};

/**
 * Errors propagate on purpose — this is one of the few functions here that does not swallow.
 *
 * `neiist.remove_valid_department_role` refuses to remove the last admin-level role (NEI07,
 * #158). Returning `false` on that would turn a precise, actionable Portuguese message into a
 * generic 500, which is exactly the failure the guard exists to make visible.
 */
export const removeValidDepartmentRole = async (
  departmentName: string,
  roleName: string
): Promise<boolean> => {
  await db_query("SELECT neiist.remove_valid_department_role($1, $2)", [departmentName, roleName]);
  return true;
};

/** Change which access level a department role grants (#158). Errors propagate — see above. */
export const updateValidDepartmentRole = async (
  actorIstid: string,
  departmentName: string,
  roleName: string,
  access: DepartmentRoleAccess
): Promise<boolean> => {
  // The actor goes to the database, which decides whether they may grant `admin` (#193). The
  // route checks the same thing first for a friendly error, but this is the enforcement: the
  // three-argument form has had EXECUTE revoked from the app role precisely so this cannot be
  // routed around.
  await db_query("SELECT neiist.update_valid_department_role($1::VARCHAR(50), $2, $3, $4)", [
    actorIstid,
    departmentName,
    roleName,
    access,
  ]);
  return true;
};

/** How many people currently hold this role, so the UI can show the blast radius of a change. */
export const countDepartmentRoleMembers = async (
  departmentName: string,
  roleName: string
): Promise<number> => {
  const {
    rows: [row],
  } = await db_query<{ count: number }>(
    "SELECT neiist.count_department_role_members($1, $2) AS count",
    [departmentName, roleName]
  );
  return Number(row?.count ?? 0);
};

export const getAllValidDepartmentRoles = async (): Promise<
  Array<{
    department_name: string;
    role_name: string;
    access: string;
    active: boolean;
  }>
> => {
  try {
    const { rows } = await db_query<{
      department_name: string;
      role_name: string;
      access: string;
      active: boolean;
    }>("SELECT * FROM neiist.get_all_valid_department_roles()");
    return rows;
  } catch (error) {
    console.error("Error fetching valid department roles:", error);
    return [];
  }
};

// Team member management
export const addTeamMember = async (
  istid: string,
  departmentName: string,
  roleName: string
): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.add_team_member($1, $2, $3)", [istid, departmentName, roleName]);
    return true;
  } catch (error) {
    console.error("Error adding team member:", error);
    return false;
  }
};

export const removeTeamMember = async (
  istid: string,
  departmentName: string,
  roleName: string
): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.remove_team_member($1, $2, $3)", [
      istid,
      departmentName,
      roleName,
    ]);
    return true;
  } catch (error) {
    console.error("Error removing team member:", error);
    return false;
  }
};

export const getAllMemberships = async (): Promise<Membership[]> => {
  try {
    const [dbMemberships, users] = await Promise.all([
      db_query<DbMembership>("SELECT * FROM neiist.get_all_memberships()").then((res) => res.rows),
      getAllUsers(),
    ]);
    return dbMemberships.map((raw, idx) => {
      const user = users.find((u) => u.istid === raw.user_istid);
      return mapDbMembershipToMembership(raw, user?.email || "", user?.photo || "", idx);
    });
  } catch (error) {
    console.error("Error fetching memberships:", error);
    return [];
  }
};

export const getDepartmentRoleOrder = async (
  departmentName: string
): Promise<Array<{ role_name: string; position: number }>> => {
  try {
    const { rows } = await db_query<{ role_name: string; position: number }>(
      "SELECT * FROM neiist.get_department_role_order($1)",
      [departmentName]
    );
    return rows;
  } catch (error) {
    console.error("Error fetching department role order:", error);
    return [];
  }
};

export const setDepartmentRoleOrder = async (
  departmentName: string,
  roles: string[]
): Promise<boolean> => {
  try {
    await db_query("SELECT neiist.set_department_role_order($1, $2)", [departmentName, roles]);
    return true;
  } catch (error) {
    console.error("Error setting department role order:", error);
    return false;
  }
};

/** One team the user belongs to, and the access level they hold *there* (#180). */
export type TeamScope = {
  departmentName: string;
  departmentType: string;
  access: UserRole;
};

/**
 * Which access level this user holds in each team, right now.
 *
 * `getUser().roles` flattens access across every department, so it cannot answer "is this person
 * a coordinator OF Fotografia" — only "is this person a coordinator somewhere". Three call sites
 * needed the former and approximated it; two got it wrong, which is #180.
 *
 * Returns current memberships only, matching `get_user`'s liveness rule.
 */
export const getUserTeamScopes = async (istid: string): Promise<TeamScope[]> => {
  const { rows } = await db_query<{
    department_name: string;
    department_type: string;
    access: string;
  }>("SELECT * FROM neiist.get_user_team_scopes($1::VARCHAR(50))", [istid]);

  return rows.map((row) => ({
    departmentName: row.department_name,
    departmentType: row.department_type,
    access: mapRoleToUserRole(row.access),
  }));
};

/**
 * The access level a given role grants inside a given department, or `null` if the pair is not a
 * valid active role there.
 *
 * Used to compare what is being handed out against what the assigner holds — see
 * `mayAssignAccess`. Returning `null` for an unknown pair means the caller fails closed rather
 * than defaulting to something permissive.
 */
export const getDepartmentRoleAccess = async (
  departmentName: string,
  roleName: string
): Promise<UserRole | null> => {
  const {
    rows: [row],
  } = await db_query<{ access: string | null }>(
    "SELECT neiist.get_department_role_access($1, $2)::TEXT AS access",
    [departmentName, roleName]
  );
  return row?.access ? mapRoleToUserRole(row.access) : null;
};

/**
 * Find an account by any email it is known under, reporting HOW it matched (#124).
 *
 * `matchedPrimaryEmail: true` — the Fenix address. That is the account, unambiguously.
 * `matchedPrimaryEmail: false` — a *verified* alternative email. The caller must treat this as a
 * linking prompt, not a login: proving control of a Google address does not prove control of the
 * Técnico account it is recorded against.
 *
 * Returns `null` when the address is unknown, which is the "create an external account" case.
 */
export const findUserByAnyEmail = async (
  email: string
): Promise<{ istid: string; matchedPrimaryEmail: boolean } | null> => {
  const {
    rows: [row],
  } = await db_query<{ istid: string; matched_primary_email: boolean }>(
    "SELECT istid, matched_primary_email FROM neiist.find_user_by_any_email($1)",
    [email]
  );
  return row ? { istid: row.istid, matchedPrimaryEmail: row.matched_primary_email } : null;
};
