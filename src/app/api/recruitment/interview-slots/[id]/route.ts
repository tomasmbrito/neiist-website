import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { validateId } from "@/utils/apiValidationUtils";
import { UserRole } from "@/types/user";
import { removeInterviewSlot } from "@/lib/db/repositories/recruitment.repository";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userRoles = await serverCheckRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [slotId, idError] = validateId(id, "slot id");
  if (idError) return idError;

  try {
    await removeInterviewSlot(slotId, userRoles.user!.istid);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
