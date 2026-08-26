import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { onboardingSchema } from "@/schemas/recruitment";
import { findOnboarding } from "@/utils/recruitment/decisionEmails";
import { completeOnboarding } from "@/utils/db/onboardingQueries";
import { throwIfRecruitmentDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * Onboarding, candidate side (#224). **Public — there is no session here.**
 *
 * The token is the entire authorization, which imposes the same three rules as the interview
 * booking route:
 *
 *  1. **The token decides the team and the application**, never a request field.
 *  2. An unknown, expired, or already-spent token gets the same 404 — probing distinguishes
 *     nothing.
 *  3. **Nothing here creates a membership.** #134 decided that, and #193 is why.
 */
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t");
  if (!token) return NextResponse.json({ error: "Link inválido." }, { status: 400 });

  const invite = await findOnboarding(token);
  if (!invite) return NextResponse.json({ error: "Link inválido ou já usado." }, { status: 404 });

  // Name and team only. The address is not echoed back: a leaked link should not also leak a
  // contact detail, and the page has no use for it.
  return NextResponse.json({ name: invite.full_name, team: invite.department_name });
}

export async function POST(request: NextRequest) {
  try {
    const parsed = onboardingSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Pedido inválido" },
        { status: 400 }
      );
    }

    // Spending the token and recording the answers happen in ONE SQL call, so a failure cannot
    // burn the candidate's only link and record nothing.
    const result = await completeOnboarding(
      hash(parsed.data.token),
      parsed.data.preferredName,
      parsed.data.phone ?? null
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    try {
      throwIfRecruitmentDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    return handleApiError(error);
  }
}
