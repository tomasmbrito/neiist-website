import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db_query } from "@/utils/db/dbClient";
import { getUser, createUser } from "@/utils/db/userQueries";
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
      // User already exists with this email.
      // Whether they're an IST student or external user, log them in to their existing account.
      // This allows IST students to use Google as an alternative login method.
    } else {
      // Create a new external (non-Técnico) account.
      //
      // The `ext_` prefix is what distinguishes external users from Técnico students, whose
      // istid comes from Fenix. It is deliberately random rather than time-based: the previous
      // `ext_${Date.now().toString(36)}` gave two people signing up in the same millisecond the
      // same istid, and the second INSERT died on users_pkey. It was also enumerable, since
      // consecutive signups produced adjacent identifiers.
      //
      // 36 characters, comfortably inside istid VARCHAR(50). Note this is exactly why the
      // column must stay VARCHAR(50): upstream's VARCHAR(10) cannot hold an external istid.
      userIstid = `ext_${crypto.randomUUID().replace(/-/g, "")}`;

      const created = await createUser({
        istid: userIstid,
        name: name,
        email: email,
        courses: [],
        photo: "",
      });

      // Without this the failure was silent: createUser returns null on error, getUser below
      // then returned null, no session cookie was set, and the user was redirected to a page
      // that simply behaved as though they had never logged in.
      if (!created) {
        console.error("[google-auth] Failed to create external user for", email);
        return NextResponse.redirect(new URL("/?error=account_creation_failed", request.url));
      }
    }

    const user = await getUser(userIstid);
    // Previously this was `if (user)` with no else: when the lookup failed the handler still
    // redirected to the post-login destination, but with no session cookie — indistinguishable
    // from never having logged in, and with nothing logged.
    if (!user) {
      console.error("[google-auth] Resolved no user after login for istid", userIstid);
      return NextResponse.redirect(new URL("/?error=login_failed", request.url));
    }

    // Only same-origin paths, so the redirect cannot be pointed at another site.
    const isSafe = typeof postLoginRedirect === "string" && postLoginRedirect.startsWith("/");
    const response = NextResponse.redirect(new URL(isSafe ? postLoginRedirect! : "/", request.url));

    const jwtPayload = {
      istid: user.istid,
      roles: user.roles,
      name: user.name,
      email: user.email,
    };
    const jwtToken = signUserJWT(jwtPayload);

    response.cookies.set("session", jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // Lax, not Strict, and not omitted.
      //
      // Omitted meant Chrome/Edge applied Lax-by-default but Firefox did not, so on Firefox every
      // cookie-authenticated state-changing route was reachable cross-site (#94). The OAuth state
      // cookies and logout already set sameSite; this was an oversight, not a decision.
      //
      // Strict was considered and rejected: it is not sent on a top-level cross-site navigation,
      // so arriving from an external link (or the OAuth provider's redirect back) would render
      // logged-out until the user navigated internally. Lax blocks the CSRF vector — cross-site
      // POST/PUT/DELETE — while keeping that navigation working.
      sameSite: "lax",
      maxAge: 60 * 60 * 24,
      path: "/",
    });

    response.cookies.delete("google_oauth_state");
    response.cookies.delete("post_login_redirect");
    return response;
  } catch (error: unknown) {
    console.error("Google Auth Error:", error);
    const msg = encodeURIComponent(error instanceof Error ? error.message : "Unknown error");
    return NextResponse.redirect(new URL(`/?error=internal_server_error&msg=${msg}`, request.url));
  }
}
