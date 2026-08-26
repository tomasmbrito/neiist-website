import { NextRequest, NextResponse } from "next/server";
import { bookSchema, cancelBookingSchema } from "@/schemas/interviews";
import { bookInterview, findInterviewInvite } from "@/utils/recruitment/interviewBooking";
import {
  cancelInterviewBooking,
  getFreeInterviewSlots,
  getInterviewBooking,
} from "@/utils/db/interviewQueries";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

/**
 * The candidate's side of interview booking (#218). **Public — there is no session here.**
 *
 * A candidate has no account, so the invitation token is the entire authorization. Three rules
 * follow from that and none of them is optional:
 *
 *  1. **The token decides which team**, never a parameter. A request cannot point a Visuais token
 *     at Fotografia by adding a field, because the department is read from the invite.
 *  2. **The application id is never accepted from the caller** — it comes from the token too.
 *  3. An unknown, expired, or already-decided token gets the same 404. Probing distinguishes
 *     nothing.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t");
  if (!token) return NextResponse.json({ error: "Link inválido." }, { status: 400 });

  const invite = await findInterviewInvite(token);
  if (!invite) return NextResponse.json({ error: "Link inválido ou expirado." }, { status: 404 });

  const [slots, booking] = await Promise.all([
    getFreeInterviewSlots(invite.application_id),
    getInterviewBooking(invite.application_id, invite.department_name),
  ]);

  // Deliberately not echoing the email address back: the page greets them by first name, and a
  // page that prints the address would make a leaked link leak a contact detail too.
  return NextResponse.json({
    name: invite.full_name,
    team: invite.department_name,
    slots,
    booking,
  });
}

export async function POST(request: NextRequest) {
  try {
    const parsed = bookSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    const invite = await findInterviewInvite(parsed.data.token);
    if (!invite) return NextResponse.json({ error: "Link inválido ou expirado." }, { status: 404 });

    const result = await bookInterview(
      parsed.data.slotId,
      invite.application_id,
      invite.department_name,
      invite.full_name
    );

    if (!result.ok) {
      // 409, not 400: the request was fine, somebody else was faster. The page re-fetches and
      // shows what is left rather than telling them they did something wrong.
      return NextResponse.json(
        { error: "Esse horário acabou de ser ocupado. Escolhe outro." },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, emailed: result.emailed });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const parsed = cancelBookingSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Pedido inválido" }, { status: 400 });

    const invite = await findInterviewInvite(parsed.data.token);
    if (!invite) return NextResponse.json({ error: "Link inválido ou expirado." }, { status: 404 });

    // Scoped in SQL to the booking's own application, so a valid token for one candidate cannot
    // cancel another's interview by guessing a slot id.
    await cancelInterviewBooking(parsed.data.slotId, invite.application_id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
