import { NextRequest, NextResponse } from "next/server";
import {
  addTeamMember,
  removeTeamMember,
  getAllMemberships,
  getUserTeamScopes,
  getDepartmentRoleAccess,
} from "@/utils/db/userQueries";
import { canForTeam, mayAssignAccess } from "@/lib/auth/permissions";
import { serverCheckPermission } from "@/utils/permissionUtils";
import type { Membership } from "@/types/memberships";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { assignNeiistEmail } from "@/utils/db/memberEmails";
import { throwIfEmailDbError } from "@/utils/db/errorMapper";
import { ValidationError } from "@/lib/errors";

/**
 * Authorize a membership change **for one team** (#180).
 *
 * The previous version asked "is this caller a coordinator *somewhere*, and a member of this
 * team?" — because `roles` is the union of access levels across every team the caller belongs
 * to. A plain Membro of Fotografia who coordinated Divulgação therefore passed for Fotografia,
 * and could add or remove its members. Reproduced against a running app: HTTP 200 and a row.
 *
 * `canForTeam` resolves the access level held in *that* department instead of approximating it.
 *
 * `departmentName === ""` means "not about one team" — the listing path — and requires the
 * global permission alone, which is what it always did.
 */
async function checkMembershipPermission(departmentName: string) {
  const roles = await serverCheckPermission("members.manage");
  if (!roles.isAuthorized) return roles;

  const denied = {
    isAuthorized: false,
    error: NextResponse.json(
      { error: "Insufficient permissions - Admin or team coordinator required" },
      { status: 403 }
    ),
  } as const;

  if (departmentName === "") return roles;

  const scopes = roles.user ? await getUserTeamScopes(roles.user.istid) : [];
  return canForTeam(roles.roles, scopes, "team.members.manage", departmentName) ? roles : denied;
}

export async function GET() {
  const permissionCheck = await checkMembershipPermission("");
  if (!permissionCheck.isAuthorized) {
    return permissionCheck.error;
  }

  try {
    const memberships: Membership[] = await getAllMemberships();
    return NextResponse.json(memberships);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { istid, departmentName, roleName } = await request.json();
    if (!istid || !departmentName || !roleName) {
      throw new ValidationError("All fields are required");
    }

    const permissionCheck = await checkMembershipPermission(departmentName);
    if (!permissionCheck.isAuthorized) {
      return permissionCheck.error;
    }

    // You may never hand out authority you do not hold.
    //
    // add_team_member checks only that the user exists and that the (department, role) pair is
    // valid, so without this a coordinator of a department that also contains an admin-level
    // role could assign it — to themselves. Verified against the seeded data: Direção holds both
    // "Diretora de Atividades (Alameda)" (coordinator) and "Presidente" (admin), and a Diretora
    // de Atividades POSTed herself Presidente and became a global administrator.
    // Re-read rather than threaded through checkMembershipPermission's return union: POST is not
    // the hot path, and keeping the guard's contract a plain boolean is worth one extra query.
    const callerScopes = permissionCheck.user
      ? await getUserTeamScopes(permissionCheck.user.istid)
      : [];
    const targetAccess = await getDepartmentRoleAccess(departmentName, roleName);
    if (!targetAccess) {
      return NextResponse.json({ error: "Cargo inválido para este departamento" }, { status: 400 });
    }
    if (!mayAssignAccess(permissionCheck.roles, callerScopes, departmentName, targetAccess)) {
      return NextResponse.json(
        { error: "Não podes atribuir um cargo com mais permissões do que as tuas." },
        { status: 403 }
      );
    }

    const success = await addTeamMember(istid, departmentName, roleName);
    if (!success) {
      return NextResponse.json({ error: "Failed to add team member" }, { status: 500 });
    }

    // Reserve the @neiist.pt address (#213), and return it so whoever is adding the member can
    // go and create the mailbox in Google Workspace.
    //
    // AFTER the membership, and non-fatally: the membership is the thing that matters, and an
    // address that could not be derived (an unusual name, a collision run) must not undo it. The
    // failure is reported instead of swallowed — `neiistEmail: null` with `emailError` tells the
    // UI to say so, rather than showing a blank where an address should be.
    //
    // Idempotent, so re-adding someone to a second team does not change an address they already
    // have — silently changing an email address is the thing this must never do.
    let neiistEmail: string | null = null;
    let emailError: string | null = null;
    try {
      neiistEmail = await assignNeiistEmail(istid);
    } catch (error) {
      try {
        throwIfEmailDbError(error);
      } catch (mapped) {
        emailError = (mapped as Error).message;
      }
      if (!emailError) {
        console.error("Failed to reserve a @neiist.pt address:", error);
        emailError = "Não foi possível gerar o endereço @neiist.pt.";
      }
    }

    return NextResponse.json({ success: true, neiistEmail, emailError });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { istid, departmentName, roleName } = await request.json();
    if (!istid || !departmentName || !roleName) {
      throw new ValidationError("All fields are required");
    }

    const permissionCheck = await checkMembershipPermission(departmentName);
    if (!permissionCheck.isAuthorized) {
      return permissionCheck.error;
    }

    const success = await removeTeamMember(istid, departmentName, roleName);
    if (success) {
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: "Failed to remove team member" }, { status: 500 });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
