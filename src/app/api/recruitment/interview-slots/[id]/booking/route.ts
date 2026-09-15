import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { validateId } from "@/utils/apiValidationUtils";
import { cancelInterviewBooking } from "@/lib/db/repositories/recruitment.repository";
import { sendEmail, getInterviewCancelledTemplate } from "@/lib/email";

// Either the candidate who booked the slot or the owning team's coordinator/admin can cancel -
// cancel_interview_booking does that fine-grained check itself, so any logged-in user may call
// this route (same shape as the public application POST route: identity from the session,
// authorization from SQL).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userRoles = await serverCheckRoles([]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [slotId, idError] = validateId(id, "slot id");
  if (idError) return idError;

  try {
    const result = await cancelInterviewBooking(slotId, userRoles.user!.istid);

    sendEmail({
      to: result.applicantEmail,
      subject: `Entrevista cancelada - ${result.departmentName}`,
      html: getInterviewCancelledTemplate(
        result.applicantName,
        result.departmentName,
        result.startsAt
      ),
    }).catch((err) =>
      console.warn("Failed to send cancellation email to candidate", { slotId, err })
    );

    sendEmail({
      to: result.coordinatorEmail,
      subject: `Entrevista cancelada - ${result.departmentName}`,
      html: getInterviewCancelledTemplate(
        result.coordinatorName,
        result.departmentName,
        result.startsAt
      ),
    }).catch((err) =>
      console.warn("Failed to send cancellation email to coordinator", { slotId, err })
    );

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
