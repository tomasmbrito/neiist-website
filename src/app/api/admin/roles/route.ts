import { NextRequest, NextResponse } from "next/server";
import {
  addValidDepartmentRole,
  removeValidDepartmentRole,
  updateValidDepartmentRole,
  countDepartmentRoleMembers,
  getDepartmentRoles,
} from "@/utils/db/userQueries";
import { serverCheckPermission } from "@/utils/permissionUtils";
import { throwIfRoleDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { departmentRoleAccessSchema, updateDepartmentRoleSchema } from "@/schemas/admin";
import { can } from "@/lib/auth/permissions";
import { UserRole } from "@/types/user";

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
    const { departmentName, roleName, access } = parsed.data;

    // Same rule as POST. This is the path that was exploitable: a coordinator PATCHing their own
    // role to `admin` became an organisation-wide administrator (#193).
    if (access === UserRole._ADMIN && !can(userRoles.roles, "members.roles.grantAdmin")) {
      return NextResponse.json(
        { error: "Apenas um administrador pode atribuir o nível de acesso de administrador." },
        { status: 403 }
      );
    }

    await updateValidDepartmentRole(userRoles.user!.istid, departmentName, roleName, access);
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
