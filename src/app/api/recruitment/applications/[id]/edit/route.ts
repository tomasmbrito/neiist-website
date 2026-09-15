import { NextRequest, NextResponse } from "next/server";
import { serverCheckRoles } from "@/lib/auth";
import { handleApiError } from "@/utils/apiErrorUtils";
import { isValidPhone, validateId } from "@/utils/apiValidationUtils";
import { updateMyApplication } from "@/lib/db/repositories/recruitment.repository";
import type { ApplicationCampus } from "@/types/recruitment";

const CAMPUSES: ApplicationCampus[] = ["Alameda", "Taguspark"];

// Candidate-facing self-edit, distinct from the admin/coordinator PATCH on the sibling
// applications/[id]/route.ts (review status). Ownership and the "locked once any interview is
// confirmed" gate are both enforced inside update_my_application, not here - identity from the
// session, never the request body, same shape as every other candidate-facing route.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([]);
  if (!userRoles.isAuthorized) return userRoles.error;

  const { id } = await params;
  const [applicationId, idError] = validateId(id, "application id");
  if (idError) return idError;

  try {
    const body = await request.json();

    if (!Array.isArray(body.departments) || body.departments.length === 0)
      return NextResponse.json({ error: "Escolhe pelo menos uma equipa" }, { status: 400 });

    if (body.departments.length > 3)
      return NextResponse.json({ error: "Podes escolher no máximo 3 equipas" }, { status: 400 });

    if (!CAMPUSES.includes(body.campus))
      return NextResponse.json({ error: "Campus inválido" }, { status: 400 });

    if (typeof body.course !== "string" || body.course.trim().length === 0)
      return NextResponse.json({ error: "Curso obrigatório" }, { status: 400 });

    const curricularYear = Number(body.curricularYear);
    if (!Number.isInteger(curricularYear) || curricularYear < 1 || curricularYear > 5)
      return NextResponse.json({ error: "Ano inválido" }, { status: 400 });

    if (typeof body.phone !== "string" || !isValidPhone(body.phone))
      return NextResponse.json({ error: "Número de telemóvel inválido" }, { status: 400 });

    if (typeof body.motivation !== "string" || body.motivation.trim().length === 0)
      return NextResponse.json({ error: "Motivação obrigatória" }, { status: 400 });

    if (typeof body.funFact !== "string" || body.funFact.trim().length === 0)
      return NextResponse.json({ error: "Campo obrigatório" }, { status: 400 });

    await updateMyApplication(applicationId, userRoles.user!.istid, {
      phone: body.phone.trim(),
      campus: body.campus,
      course: body.course.trim(),
      curricularYear,
      priorExperience:
        typeof body.priorExperience === "string" && body.priorExperience.trim().length > 0
          ? body.priorExperience.trim()
          : null,
      motivation: body.motivation.trim(),
      funFact: body.funFact.trim(),
      wantsWaitlist: body.wantsWaitlist !== false,
      departments: body.departments,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
