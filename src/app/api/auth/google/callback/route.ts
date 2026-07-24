import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser, createUser, db_query } from "@/utils/dbUtils";
import { signUserJWT } from "@/utils/authUtils";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const savedState = cookieStore.get("google_oauth_state")?.value;
  const postLoginRedirect = cookieStore.get("post_login_redirect")?.value;

  if (error || !code) {
    return NextResponse.redirect(new URL("/?error=google_auth_failed", request.url));
  }

  if (!state || state !== savedState) {
    return NextResponse.redirect(new URL("/?error=invalid_state", request.url));
  }

  try {
    const baseUrl = new URL(request.url).origin;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${baseUrl}/api/auth/google/callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Failed to exchange Google code:", errorData);
      return NextResponse.redirect(new URL("/?error=google_token_exchange_failed", request.url));
    }

    const { access_token } = await tokenResponse.json();

    // Get user info
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!userInfoResponse.ok) {
      console.error("Failed to fetch Google user info");
      return NextResponse.redirect(new URL("/?error=google_user_info_failed", request.url));
    }

    const googleUserInfo = await userInfoResponse.json();
    const { email, name } = googleUserInfo;

    // Task 1: Reject emails ending with @tecnico.ulisboa.pt
    if (email.endsWith("@tecnico.ulisboa.pt")) {
      return NextResponse.redirect(new URL("/?error=use_fenix_for_tecnico_emails", request.url));
    }

    // Lookup user by email securely
    const { rows } = await db_query<{ get_user_by_email: string | null }>(
      "SELECT neiist.get_user_by_email($1)",
      [email]
    );
    let userIstid = rows[0]?.get_user_by_email;

    if (userIstid) {
      // Task 2: Reject Google logins if email is already registered to a user with an active istid
      const isExternalUser = userIstid.startsWith("ext_");

      if (!isExternalUser) {
        return NextResponse.redirect(new URL("/?error=email_registered_with_fenix", request.url));
      }

      // Gracefully link new Google identity if email matches existing user with an external istid
      // (This is implicitly handled by using the same istid)
    } else {
      // Create new external user
      // Issue #12 requires creating external users with an ext_ prefix if they are new.
      const timestamp = Date.now().toString(36);
      userIstid = `ext_${timestamp}`;

      await createUser({
        istid: userIstid,
        name: name,
        email: email,
        alternativeEmail: "",
        phone: "",
        courses: [],
        photo: "",
      });
    }

    const user = await getUser(userIstid);
    if (user) {
      const jwtPayload = {
        istid: user.istid,
        roles: user.roles,
        name: user.name,
        email: user.email,
      };
      const jwtToken = signUserJWT(jwtPayload);

      cookieStore.set("session", jwtToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: 60 * 60 * 24,
        path: "/",
      });
    }

    const response = NextResponse.redirect(new URL(postLoginRedirect || "/", request.url));
    response.cookies.delete("google_oauth_state");
    response.cookies.delete("post_login_redirect");
    return response;
  } catch (error) {
    console.error("Google Auth Error:", error);
    return NextResponse.redirect(new URL("/?error=internal_server_error", request.url));
  }
}
