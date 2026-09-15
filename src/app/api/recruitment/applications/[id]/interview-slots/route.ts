import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { validateId } from "@/utils/apiValidationUtils";
import {
  bookInterviewSlot,
  getBookableInterviewSlots,
} from "@/lib/db/repositories/recruitment.repository";
import { sendEmail, getInterviewBookedTemplate } from "@/lib/email";

// Candidate-facing. Ownership of the application is checked inside SQL (applicant_istid must
// match the caller), same shape as the public application submission route - identity from the
// session, never the request body.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [applicationId, idError] = validateId(id, "application id");
  if (idError) return idError;

  try {
    const slots = await getBookableInterviewSlots(applicationId, userRoles.user!.istid);
    return NextResponse.json(slots);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [applicationId, idError] = validateId(id, "application id");
  if (idError) return idError;

  try {
    const body = await request.json();
    const [slotId, slotIdError] = validateId(body.slotId, "slot id");
    if (slotIdError) return slotIdError;

    const result = await bookInterviewSlot(slotId, applicationId, userRoles.user!.istid);

    sendEmail({
      to: result.applicantEmail,
      subject: `Entrevista marcada - ${result.departmentName}`,
      html: getInterviewBookedTemplate(
        result.applicantName,
        result.coordinatorName,
        result.departmentName,
        result.startsAt,
        result.location,
        "candidate"
      ),
    }).catch((err) => console.warn("Failed to send booking email to candidate", { slotId, err }));

    sendEmail({
      to: result.coordinatorEmail,
      subject: `Entrevista marcada - ${result.departmentName}`,
      html: getInterviewBookedTemplate(
        result.coordinatorName,
        result.applicantName,
        result.departmentName,
        result.startsAt,
        result.location,
        "coordinator"
      ),
    }).catch((err) => console.warn("Failed to send booking email to coordinator", { slotId, err }));

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
