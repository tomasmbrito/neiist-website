import { NextRequest, NextResponse } from "next/server";
import {
  createTeamAccessGrant,
  revokeTeamAccessGrant,
  getTeamAccessGrants,
} from "@/utils/db/userQueries";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { throwIfGrantDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { createGrantSchema, revokeGrantSchema } from "@/schemas/grants";

/**
 * Temporary team access grants (#184).
 *
 * **The route deliberately does very little.** Who may grant what, to whom, for how long, and how
 * far a delegation may reach are all decided inside `neiist.create_team_access_grant`, which
 * derives the caller's authority from the database rather than from anything sent here. This
 * handler establishes *who is asking* and hands that istid over; it never asserts what they are.
 *
 * That split is the point. A rule enforced here would be one route away from being bypassed, and
 * ~58 of ~64 query functions in this repo still `catch { return null }` — a guard that reports
 * failure by returning something falsy is a guard that can be swallowed.
 */

/** Read the grants on a team. Anyone who may open the team's workspace may see who else can. */
export async function GET(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) {
    return NextResponse.json({ error: "Indique a equipa." }, { status: 400 });
  }

  // Same guard the team page uses. Grants name people and carry a reason, so this is internal
  // information about a team and must not be readable by someone outside it.
  if (!canForTeam(session.roles, session.scopes, "team.workspace.view", departmentName)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  return NextResponse.json(await getTeamAccessGrants(departmentName));
}

export async function POST(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = createGrantSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    const { granteeIstid, departmentName, access, expiresAt, reason, parentGrantId } = parsed.data;

    const id = await createTeamAccessGrant(
      session.user.istid,
      granteeIstid,
      departmentName,
      access,
      expiresAt,
      reason,
      parentGrantId ?? null
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    try {
      throwIfGrantDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = revokeGrantSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }

    // No permission check here on purpose: revoke_team_access_grant decides, because the answer
    // depends on the grant itself (its granter, its grantee) and not on a role this route could
    // read. Duplicating it would be a second version of the rule, free to disagree.
    await revokeTeamAccessGrant(
      session.user.istid,
      parsed.data.grantId,
      parsed.data.reason ?? null
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfGrantDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
