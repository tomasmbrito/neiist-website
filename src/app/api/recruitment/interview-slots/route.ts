import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { UserRole } from "@/types/user";
import { addInterviewSlot, getInterviewSlots } from "@/lib/db/repositories/recruitment.repository";

// Coordinator/admin's own-team view. Fine-grained per-team authorization happens inside
// get_interview_slots / add_interview_slot (is_team_coordinator_or_admin) - this coarse gate
// only keeps a non-coordinator, non-admin user out entirely, same pattern as the review-status
// and decisions routes.
export async function GET(request: NextRequest) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const departmentName = request.nextUrl.searchParams.get("departmentName");
  if (!departmentName || departmentName.trim().length === 0)
    return NextResponse.json({ error: "Equipa obrigatória" }, { status: 400 });

  try {
    const slots = await getInterviewSlots(departmentName, userRoles.user!.istid);
    return NextResponse.json(slots);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const body = await request.json();

    if (typeof body.departmentName !== "string" || body.departmentName.trim().length === 0)
      return NextResponse.json({ error: "Equipa obrigatória" }, { status: 400 });

    const startsAt = new Date(body.startsAt);
    if (Number.isNaN(startsAt.getTime()))
      return NextResponse.json({ error: "Data/hora inválida" }, { status: 400 });

    const location =
      typeof body.location === "string" && body.location.trim().length > 0
        ? body.location.trim()
        : null;

    const slot = await addInterviewSlot(
      body.departmentName,
      userRoles.user!.istid,
      startsAt,
      location
    );

    return NextResponse.json(slot, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
