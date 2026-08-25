import { NextRequest, NextResponse } from "next/server";
import {
  getApprovalSides,
  getTeamApplications,
  recordApplicationApproval,
  withdrawApplicationApproval,
} from "@/utils/db/recruitmentQueries";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { decideApplicationSchema, withdrawApprovalSchema } from "@/schemas/recruitment";
import { throwIfRecruitmentDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * Reviewing applications, inside the workspace (#134).
 *
 * Gated on `team.recruitment.decide` — **not** `team.workspace.view`. Every other workspace
 * reader lets any member of the team look, but these rows hold names, phone numbers, emails and
 * motivations belonging to people who may never join NEIIST. Reading them is a narrower act than
 * reading the team's own calendar, so it needs its own permission, and that permission is not
 * grantable.
 */
export async function GET(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) {
    return NextResponse.json({ error: "Indique a equipa." }, { status: 400 });
  }
  if (!canForTeam(session.roles, session.scopes, "team.recruitment.decide", departmentName)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // The caller's own sides ride along, so the UI knows which button to offer without a second
  // round trip — and without ever being the thing that decides. SQL checks it again on write.
  const [applications, sides] = await Promise.all([
    getTeamApplications(departmentName),
    session.user ? getApprovalSides(session.user.istid, departmentName) : Promise.resolve([]),
  ]);
  return NextResponse.json({ applications, sides });
}

export async function PATCH(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = decideApplicationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    const { applicationId, departmentName, decision, side, note } = parsed.data;

    // Authorized against the department being decided. A coordinator of Visuais deciding
    // Dev-Team's part of a shared application is exactly what must not happen — and the SQL
    // refuses a department that is not on the application, so the two agree.
    if (!canForTeam(session.roles, session.scopes, "team.recruitment.decide", departmentName)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // `canForTeam` says they may take part in this team's recruitment. WHICH half they sign is a
    // separate question, answered in SQL from their memberships — a board member's
    // organisation-wide access satisfies the check above for every team, and must not thereby
    // become the team's own signature.
    const signedAs = await recordApplicationApproval(
      applicationId,
      departmentName,
      decision,
      session.user.istid,
      side ?? null,
      note ?? null
    );
    return NextResponse.json({ success: true, side: signedAs });
  } catch (error) {
    try {
      throwIfRecruitmentDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

/** Take back your own signature, reopening a decision that has not been acted on. */
export async function DELETE(request: NextRequest) {
  const session = await getWorkspaceSession();
  if (!session?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  try {
    const parsed = withdrawApprovalSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });
    }
    const { applicationId, departmentName } = parsed.data;

    if (!canForTeam(session.roles, session.scopes, "team.recruitment.decide", departmentName)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Scoped to the caller's own istid inside SQL, not by a parameter — withdrawing someone
    // else's signature is precisely how one person would end up holding both.
    await withdrawApplicationApproval(applicationId, departmentName, session.user.istid);
    return NextResponse.json({ success: true });
  } catch (error) {
    try {
      throwIfRecruitmentDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
