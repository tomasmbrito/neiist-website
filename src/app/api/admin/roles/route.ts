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
    const success = await addValidDepartmentRole(departmentName, roleName, accessParsed.data);
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
    await updateValidDepartmentRole(departmentName, roleName, access);
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
