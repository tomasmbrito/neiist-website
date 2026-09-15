import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { validateId } from "@/utils/apiValidationUtils";
import { UserRole } from "@/types/user";
import { confirmInterviewBooking } from "@/lib/db/repositories/recruitment.repository";
import { sendEmail, getInterviewBookedTemplate } from "@/lib/email";

// Coordinator/admin only - turns a requested booking into a confirmed one. Coarse role gate
// here, fine-grained per-team check inside confirm_interview_booking (is_team_coordinator_or_admin),
// same pattern as every other coordinator-facing recruitment route.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [slotId, idError] = validateId(id, "slot id");
  if (idError) return idError;

  try {
    const result = await confirmInterviewBooking(slotId, userRoles.user!.istid);

    sendEmail({
      to: result.applicantEmail,
      subject: `Entrevista confirmada - ${result.departmentName}`,
      html: getInterviewBookedTemplate(
        result.applicantName,
        result.coordinatorName,
        result.departmentName,
        result.startsAt,
        result.location,
        "candidate",
        "confirmed"
      ),
    }).catch((err) =>
      console.warn("Failed to send confirmation email to candidate", { slotId, err })
    );

    sendEmail({
      to: result.coordinatorEmail,
      subject: `Entrevista confirmada - ${result.departmentName}`,
      html: getInterviewBookedTemplate(
        result.coordinatorName,
        result.applicantName,
        result.departmentName,
        result.startsAt,
        result.location,
        "coordinator",
        "confirmed"
      ),
    }).catch((err) =>
      console.warn("Failed to send confirmation email to coordinator", { slotId, err })
    );

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
