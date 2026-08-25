import { NextRequest, NextResponse } from "next/server";
import { decideApplicationTeam, getTeamApplications } from "@/utils/db/recruitmentQueries";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import { decideApplicationSchema } from "@/schemas/recruitment";
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

  return NextResponse.json(await getTeamApplications(departmentName));
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
    const { applicationId, departmentName, outcome, note } = parsed.data;

    // Authorized against the department being decided. A coordinator of Visuais deciding
    // Dev-Team's part of a shared application is exactly what must not happen — and the SQL
    // refuses a department that is not on the application, so the two agree.
    if (!canForTeam(session.roles, session.scopes, "team.recruitment.decide", departmentName)) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    await decideApplicationTeam(
      applicationId,
      departmentName,
      outcome,
      session.user.istid,
      note ?? null
    );
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
