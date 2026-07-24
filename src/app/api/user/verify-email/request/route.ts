import { NextResponse } from "next/server";
import crypto from "crypto";
import { addEmailVerification } from "@/utils/dbUtils";
import { sendEmail, getEmailVerificationTemplate } from "@/utils/emailUtils";
import { cookies } from "next/headers";
import { getUserFromJWT } from "@/utils/authUtils";

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = cookieStore.get("session")?.value;
  const user = getUserFromJWT(session);

  if (!user || !user.istid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const istid = user.istid;

  const { alternativeEmail } = await request.json();
  if (!istid || !alternativeEmail) {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min life for the token
  try {
    await addEmailVerification(istid, alternativeEmail, token, expiresAt);
    const verifyUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/user/verify-email/confirm?token=${token}`;
    await sendEmail({
      to: alternativeEmail,
      subject: "Verifique o seu email alternativo",
      html: getEmailVerificationTemplate(verifyUrl),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error in email verification request:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
