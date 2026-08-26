import { NextRequest, NextResponse } from "next/server";
import { getWorkspaceSession } from "@/utils/permissionUtils";
import { canForTeam } from "@/lib/auth/permissions";
import {
  addInterviewSlot,
  getTeamInterviewSlots,
  removeInterviewSlot,
} from "@/utils/db/interviewQueries";
import { getOpenEdition } from "@/utils/db/recruitmentQueries";
import { addSlotSchema, inviteSchema, removeSlotSchema } from "@/schemas/interviews";
import { inviteToInterview } from "@/utils/recruitment/interviewBooking";
import { getTeamApplications } from "@/utils/db/recruitmentQueries";
import { throwIfRecruitmentDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * Interview availability, coordinator side (#218).
 *
 * Gated on `team.recruitment.decide` — the same permission as reading applications, and for the
 * same reason: who is being interviewed, and when, is information about candidates.
 */
async function guard(request: NextRequest, departmentName: string) {
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

  const auth = await guard(request, departmentName);
  if ("error" in auth) return auth.error;

  return NextResponse.json(await getTeamInterviewSlots(departmentName));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Two actions on one route, because they are the same subject and the same guard.
    if (body?.action === "invite") {
      const parsed = inviteSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

      const auth = await guard(request, parsed.data.departmentName);
      if ("error" in auth) return auth.error;

      // The candidate's name and address come from the application, never from the request — a
      // route that accepted an email would let a coordinator send an invite anywhere.
      const application = (await getTeamApplications(parsed.data.departmentName)).find(
        (candidate) => candidate.id === parsed.data.applicationId
      );
      if (!application) {
        return NextResponse.json({ error: "Candidatura não encontrada." }, { status: 404 });
      }

      const sent = await inviteToInterview(
        parsed.data.applicationId,
        parsed.data.departmentName,
        auth.session.user!.istid,
        application.fullName,
        application.email
      );
      return NextResponse.json({ success: true, emailed: sent });
    }

    const parsed = addSlotSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }
    const auth = await guard(request, parsed.data.departmentName);
    if ("error" in auth) return auth.error;

    const edition = await getOpenEdition();
    if (!edition) {
      return NextResponse.json(
        { error: "Não há uma edição de recrutamento aberta." },
        { status: 409 }
      );
    }

    // Published in the caller's OWN name. Availability belongs to a person, and a coordinator
    // cannot put a colleague's calendar on offer.
    const id = await addInterviewSlot(
      edition.id,
      parsed.data.departmentName,
      auth.session.user!.istid,
      parsed.data.startsAt,
      parsed.data.endsAt,
      parsed.data.location ?? null
    );
    return NextResponse.json({ success: true, id });
  } catch (error) {
    try {
      throwIfRecruitmentDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const departmentName = request.nextUrl.searchParams.get("department");
  if (!departmentName) return NextResponse.json({ error: "Indique a equipa." }, { status: 400 });

  const auth = await guard(request, departmentName);
  if ("error" in auth) return auth.error;

  try {
    const parsed = removeSlotSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    // Scoped to the caller's own istid inside SQL, and it refuses a booked slot — the candidate
    // has already been told, and deleting the row leaves them turning up to nothing.
    await removeInterviewSlot(parsed.data.slotId, auth.session.user!.istid);
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
