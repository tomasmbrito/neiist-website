import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { validateId } from "@/utils/apiValidationUtils";
import { UserRole } from "@/types/user";
import { setTeamDecision } from "@/lib/db/repositories/recruitment.repository";
import { sendEmail, getApplicationDecisionTemplate } from "@/lib/email";
import type { DecisionSide } from "@/types/recruitment";

const SIDES: DecisionSide[] = ["coordinator", "board"];
const DECISIONS = ["accepted", "rejected"];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Board-side callers aren't necessarily UserRole.COORDINATOR/ADMIN by the department they're
  // deciding on, but Direção roles already map to admin/coordinator access globally (see
  // is_recruitment_board_member) - so this coarse gate is still correct, same as the review
  // status route. The real per-side, per-team authorization happens inside set_team_decision.
  const userRoles = await serverCheckRoles([UserRole._ADMIN, UserRole._COORDINATOR]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [applicationId, idError] = validateId(id, "application id");
  if (idError) return idError;

  try {
    const body = await request.json();

    if (typeof body.departmentName !== "string" || body.departmentName.trim().length === 0)
      return NextResponse.json({ error: "Equipa obrigatória" }, { status: 400 });

    if (!SIDES.includes(body.side))
      return NextResponse.json({ error: "Lado inválido" }, { status: 400 });

    if (!DECISIONS.includes(body.decision))
      return NextResponse.json({ error: "Decisão inválida" }, { status: 400 });

    const result = await setTeamDecision(
      applicationId,
      body.departmentName,
      body.side,
      body.decision,
      userRoles.user!.istid
    );

    if (!result) return NextResponse.json({ error: "Candidatura não encontrada" }, { status: 404 });

    if (result.justFinalized) {
      sendEmail({
        to: result.applicantEmail,
        subject:
          result.outcome === "accepted"
            ? `A tua candidatura ao NEIIST - ${result.departmentName}`
            : `Resultado da tua candidatura - ${result.departmentName}`,
        html: getApplicationDecisionTemplate(
          result.applicantName,
          result.departmentName,
          result.outcome === "accepted" ? "accepted" : "rejected"
        ),
      }).catch((err) => console.warn("Failed to send decision email", { applicationId, err }));
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
