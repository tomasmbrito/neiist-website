import { NextRequest, NextResponse } from "next/server";
import { getDepartmentRoleOrder, setDepartmentRoleOrder } from "@/utils/db/userQueries";
import { serverCheckPermission } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { getUserTeamScopes } from "@/utils/db/userQueries";

export async function GET(request: NextRequest) {
  const userRoles = await serverCheckPermission("members.roles.manage");
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  const department = request.nextUrl.searchParams.get("department");
  if (!department) {
    return NextResponse.json({ error: "Department parameter is required" }, { status: 400 });
  }
  const order = await getDepartmentRoleOrder(department);
  return NextResponse.json(order);
}

export async function POST(request: NextRequest) {
  const userRoles = await serverCheckPermission("members.roles.manage");
  if (!userRoles.isAuthorized) {
    return userRoles.error;
  }
  const { departmentName, roles } = await request.json();
  if (!departmentName || !Array.isArray(roles)) {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }

  // Same missing scope as /api/admin/roles (#205): `members.roles.manage` is global, the
  // department came from the body, so any coordinator could reorder any other team's hierarchy.
  // Cosmetic compared with redefining access levels, but it is the same boundary and there is no
  // reason for it to be the one place that still ignores it.
  const scopes = await getUserTeamScopes(userRoles.user!.istid);
  if (!canForTeam(userRoles.roles, scopes, "team.members.manage", departmentName)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const ok = await setDepartmentRoleOrder(departmentName, roles);
  return NextResponse.json({ ok });
}
