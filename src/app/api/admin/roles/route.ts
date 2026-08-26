import { NextRequest, NextResponse } from "next/server";
import {
  addValidDepartmentRole,
  removeValidDepartmentRole,
  setRoleBoardMembership,
  updateValidDepartmentRole,
  countDepartmentRoleMembers,
  getDepartmentRoles,
  getUserTeamScopes,
} from "@/utils/db/userQueries";
import { serverCheckPermission } from "@/utils/permissionUtils";
import { throwIfRoleDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { departmentRoleAccessSchema, updateDepartmentRoleSchema } from "@/schemas/admin";
import { can, canForTeam } from "@/lib/auth/permissions";
import { UserRole } from "@/types/user";

/**
 * May this caller manage roles **in this department**? (#205)
 *
 * `members.roles.manage` is a global permission held by every coordinator, and these handlers took
 * the department from the request body — so a coordinator of Fotografia could redefine Dev-Team's
 * roles, or DELETE one and have `remove_valid_department_role` stamp `to_date` on every live
 * membership of it, terminating another team's roster.
 *
 * That is the cross-team boundary #180 exists to hold, and `/api/admin/memberships` already holds
 * it the same way — `canForTeam(..., "team.members.manage", departmentName)`. This brings roles
 * into line. Organisation-wide `_ADMIN` still passes everywhere, via `ORGANISATION_WIDE` inside
 * `canForTeam`, so the board is unaffected.
 *
 * Scoped in TypeScript rather than SQL deliberately, matching memberships: the precise rule
 * depends on `GRANTABLE_TEAM_PERMISSIONS`, which is a TypeScript artefact, and an SQL copy would
 * be the same policy written twice and free to drift.
 */
async function mayManageRolesIn(
  roles: UserRole[] | undefined,
  istid: string,
  departmentName: string
): Promise<boolean> {
  const scopes = await getUserTeamScopes(istid);
  return canForTeam(roles, scopes, "team.members.manage", departmentName);
}

export async function GET(request: NextRequest) {
  const userRoles = await serverCheckPermission("members.roles.manage");
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  try {
    const department = request.nextUrl.searchParams.get("department");
    if (!department) {
      return NextResponse.json({ error: "Department parameter is required" }, { status: 400 });
    }
    const roles = await getDepartmentRoles(department);

    // How many people hold each role, so the UI can say "this affects N members" before an
    // access level is changed. Changing a role's access changes what its holders can do
    // immediately, and that consequence should be visible rather than discovered.
    const withImpact = await Promise.all(
      roles.map(async (role) => ({
        ...role,
        memberCount: await countDepartmentRoleMembers(department, role.role_name),
      }))
    );
    return NextResponse.json(withImpact);
  } catch {
    return NextResponse.json({ error: "Failed to fetch roles" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const userRoles = await serverCheckPermission("members.roles.manage");
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  try {
    const { departmentName, roleName, access } = await request.json();
    if (!departmentName || !roleName) {
      return NextResponse.json(
        { error: "Department name and role name are required" },
        { status: 400 }
      );
    }
    // Validated rather than passed straight to the enum cast, and it accepts shop_manager —
    // which the previous TypeScript union omitted even though the enum has always had it.
    const accessParsed = departmentRoleAccessSchema.safeParse(access ?? "member");
    if (!accessParsed.success) {
      return NextResponse.json({ error: "Nível de acesso inválido" }, { status: 400 });
    }

    if (!(await mayManageRolesIn(userRoles.roles, userRoles.user!.istid, departmentName))) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // #193: a coordinator may manage their teams' roles, but only an admin may create
    // organisation-wide power. Checked here for a clear 403, and again in SQL, which is the
    // enforcement — the unguarded three-argument function has had EXECUTE revoked from the app
    // role so this cannot be routed around by a future caller.
    if (
      accessParsed.data === UserRole._ADMIN &&
      !can(userRoles.roles, "members.roles.grantAdmin")
    ) {
      return NextResponse.json(
        { error: "Apenas um administrador pode atribuir o nível de acesso de administrador." },
        { status: 403 }
      );
    }

    const success = await addValidDepartmentRole(
      userRoles.user!.istid,
      departmentName,
      roleName,
      accessParsed.data
    );
    if (success) {
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: "Failed to add role" }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: "Failed to add role" }, { status: 500 });
  }
}

/**
 * Change which access level a department role grants (#158).
 *
 * Previously the only way to do this was to delete the role and re-create it, which ends every
 * current membership of it (remove_valid_department_role stamps to_date) — so people silently
 * lost their position and their history to what should be a one-field edit.
 */
export async function PATCH(request: NextRequest) {
  const userRoles = await serverCheckPermission("members.roles.manage");
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  try {
    const parsed = updateDepartmentRoleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    const { departmentName, roleName, access, boardMember } = parsed.data;

    if (!(await mayManageRolesIn(userRoles.roles, userRoles.user!.istid, departmentName))) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Same rule as POST. This is the path that was exploitable: a coordinator PATCHing their own
    // role to `admin` became an organisation-wide administrator (#193).
    if (access === UserRole._ADMIN && !can(userRoles.roles, "members.roles.grantAdmin")) {
      return NextResponse.json(
        { error: "Apenas um administrador pode atribuir o nível de acesso de administrador." },
        { status: 403 }
      );
    }

    // Board membership is an escalation of the same family as granting `admin`, and needs the same
    // gate (#193): a coordinator who could mark their own role `board_member` would become a
    // recruitment board signatory for every team. Checked separately from `access` because the
    // two are now independent — a `coordinator` role can be on the board, which is the whole
    // point of #217, so the access check above does not cover this one.
    if (boardMember !== undefined && !can(userRoles.roles, "members.roles.grantAdmin")) {
      return NextResponse.json(
        { error: "Apenas a direção pode definir que cargos pertencem à direção." },
        { status: 403 }
      );
    }

    await updateValidDepartmentRole(userRoles.user!.istid, departmentName, roleName, access);
    if (boardMember !== undefined) {
      await setRoleBoardMembership(departmentName, roleName, boardMember);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    // NEI07 (last admin) becomes a 409 carrying its Portuguese message rather than a blanket 500.
    try {
      throwIfRoleDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const userRoles = await serverCheckPermission("members.roles.manage");
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  try {
    const { departmentName, roleName } = await request.json();
    if (!departmentName || !roleName) {
      return NextResponse.json(
        { error: "Department name and role name are required" },
        { status: 400 }
      );
    }

    // The most destructive of the three: `remove_valid_department_role` stamps `to_date` on every
    // current membership of the role, so an unscoped DELETE terminated another team's entire
    // roster and their workspace access in one request.
    if (!(await mayManageRolesIn(userRoles.roles, userRoles.user!.istid, departmentName))) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    await removeValidDepartmentRole(departmentName, roleName);
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfRoleDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
