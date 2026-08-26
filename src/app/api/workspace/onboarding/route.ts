import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import {
  getPendingOnboarding,
  getTeamLink,
  markOnboardingComplete,
  setTeamLink,
} from "@/utils/db/onboardingQueries";
import { markOnboardedSchema, teamLinkSchema } from "@/schemas/recruitment";
import { throwIfRecruitmentDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * The coordinator's side of onboarding (#224) and the team's WhatsApp link (#225).
 *
 * Gated on `team.recruitment.decide`, the same permission as reading applications: the queue holds
 * names, phone numbers and email addresses of people who have just been accepted, which is the
 * same category of data and deserves the same narrow, non-grantable permission.
 */
async function guard(departmentName: string) {
  const session = await getWorkspaceSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  }
  if (!canForTeam(session.roles, session.scopes, "team.recruitment.decide", departmentName)) {
    return { error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }
  return { session };
}

export async function GET(request: NextRequest) {
  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) return NextResponse.json({ error: "Indique a equipa." }, { status: 400 });

  const auth = await guard(departmentName);
  if ("error" in auth) return auth.error;

  const [pending, link] = await Promise.all([
    getPendingOnboarding(departmentName),
    getTeamLink(departmentName),
  ]);
  return NextResponse.json({ pending, link });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body?.action === "mark") {
      const parsed = markOnboardedSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

      const auth = await guard(parsed.data.departmentName);
      if ("error" in auth) return auth.error;

      // Records only. Creating the membership stays a deliberate act in the members screen —
      // this endpoint must never grow an `add_team_member` call.
      await markOnboardingComplete(
        parsed.data.applicationId,
        parsed.data.departmentName,
        auth.session.user!.istid
      );
      return NextResponse.json({ success: true });
    }

    const parsed = teamLinkSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    const auth = await guard(parsed.data.departmentName);
    if ("error" in auth) return auth.error;

    // The URL shape is validated in SQL, so a future caller inherits the same rule rather than
    // re-implementing it. The message comes back verbatim.
    await setTeamLink(
      parsed.data.departmentName,
      parsed.data.whatsappUrl,
      auth.session.user!.istid
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
