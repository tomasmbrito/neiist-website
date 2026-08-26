import { NextRequest, NextResponse } from "next/server";
import { submitApplication } from "@/utils/db/recruitmentQueries";
import { submitApplicationSchema } from "@/schemas/recruitment";
import { throwIfRecruitmentDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * Submit an application to join NEIIST (#134). **Public — no session required.**
 *
 * This is the only unauthenticated write in the workspace family, and it is deliberate: putting a
 * Fenix login in front of the form would ask people to authenticate to a system they have no
 * relationship with yet, to apply for a relationship. The candidate's istid is captured as a
 * field so acceptance can match them later.
 *
 * Because there is no caller to authorize, **every rule lives in `neiist.submit_application`** —
 * the round must be open, the teams must exist and be teams, one application per person per
 * round. A route-level check would be the only copy and therefore the only thing to forget.
 *
 * Rate limiting is the generic 60/min per IP from `proxy.ts`. That is thin for a public write and
 * is noted as follow-up rather than pretended away; the UNIQUE (edition, istid) constraint is
 * what actually bounds the damage — a flood produces one row per istid, not thousands.
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = submitApplicationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }

    const id = await submitApplication(parsed.data);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    // A duplicate is a person applying twice, not an error worth a stack trace.
    if ((error as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { error: "Já existe uma candidatura com este número de aluno nesta edição." },
        { status: 409 }
      );
    }
    try {
      throwIfRecruitmentDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
