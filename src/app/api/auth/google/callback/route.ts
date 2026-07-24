import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser, db_query } from "@/utils/dbUtils";
import { signUserJWT } from "@/utils/authUtils";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(new URL("/?error=google_auth_failed", request.url));
  }

  try {
    // In Issue #10, this code will be exchanged for Google tokens
    // For now, this is a placeholder implementation for Issue #11 constraints.
    // We assume we have the Google user info (email, name, id)
    // const googleUserInfo = await exchangeGoogleCodeForUser(code);
    // const { email, name, id: googleId } = googleUserInfo;

    // Task 1: Reject emails ending with @tecnico.ulisboa.pt
    if ("placeholder@example.com".endsWith("@tecnico.ulisboa.pt")) {
      return NextResponse.redirect(new URL("/?error=use_fenix_for_tecnico_emails", request.url));
    }

    // Lookup user by email
    const { rows } = await db_query("SELECT * FROM neiist.users WHERE email = $1", [
      "placeholder@example.com",
    ]);
    const existingUser = rows[0];

    if (existingUser) {
      // Task 2: Reject Google logins if email is already registered to a user with an active istid
      // An active istid means it follows the typical IST format (e.g. ist123456)
      // or we can just check if it doesn't start with 'ext_' (external).
      const isExternalUser = existingUser.istid.startsWith("ext_");

      if (!isExternalUser) {
        return NextResponse.redirect(new URL("/?error=email_registered_with_fenix", request.url));
      }

      // Task 3: Gracefully link new Google identity if email matches existing user with no istid (or external istid)
      // Since Google id is not in the schema yet, this is a placeholder for the link logic
      // e.g. await db_query("UPDATE neiist.users SET google_id = $1 WHERE istid = $2", [googleId, existingUser.istid]);

      const user = await getUser(existingUser.istid);
      if (user) {
        const jwtPayload = {
          istid: user.istid,
          roles: user.roles,
          name: user.name,
          email: user.email,
        };
        const jwtToken = signUserJWT(jwtPayload);

        const cookieStore = await cookies();
        cookieStore.set("session", jwtToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          maxAge: 60 * 60 * 24,
          path: "/",
        });
      }

      return NextResponse.redirect(new URL("/", request.url));
    } else {
      // Create new external user
      // ... handled in Issue #10
      return NextResponse.redirect(new URL("/", request.url));
    }
  } catch (error) {
    console.error("Google Auth Error:", error);
    return NextResponse.redirect(new URL("/?error=internal_server_error", request.url));
  }
}
