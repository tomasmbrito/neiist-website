import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { validateId } from "@/utils/apiValidationUtils";
import { UserRole } from "@/types/user";
import { setApplicationReviewStatus } from "@/lib/db/repositories/recruitment.repository";

const REVIEW_STATUSES = ["new", "contacted", "archived"];

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [applicationId, idError] = validateId(id, "application id");
  if (idError) return idError;

  try {
    const body = await request.json();

    if (!REVIEW_STATUSES.includes(body.reviewStatus))
      return NextResponse.json({ error: "Estado de revisão inválido" }, { status: 400 });

    const note =
      typeof body.reviewNote === "string" && body.reviewNote.trim().length > 0
        ? body.reviewNote.trim()
        : null;

    const updated = await setApplicationReviewStatus(
      applicationId,
      body.reviewStatus,
      note,
      userRoles.user!.istid
    );

    if (!updated)
      return NextResponse.json({ error: "Candidatura não encontrada" }, { status: 404 });

    return NextResponse.json(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
