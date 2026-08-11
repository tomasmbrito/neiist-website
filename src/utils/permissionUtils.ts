import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getUser } from "@/utils/dbUtils";
import { UserRole, mapRoleToUserRole, hasRequiredRole } from "@/types/user";
import { getUserFromJWT } from "@/utils/authUtils";

export async function serverCheckRoles(required: UserRole[]) {
  try {
    const sessionToken = (await cookies()).get("session")?.value;
    const jwtUser = getUserFromJWT(sessionToken);
    if (!jwtUser) {
      return {
        isAuthorized: false,
        error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
      };
    }

    const currentUser = await getUser(jwtUser.istid);
    if (!currentUser) {
      return {
        isAuthorized: false,
        error: NextResponse.json({ error: "Current user not found" }, { status: 404 }),
      };
    }

    const currentUserRoles: UserRole[] = currentUser.roles?.map((r) => mapRoleToUserRole(r)) || [
      UserRole._GUEST,
    ];

    if (!hasRequiredRole(currentUserRoles, required)) {
      return {
        isAuthorized: false,
        error: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }),
      };
    }

    return { isAuthorized: true, user: currentUser, roles: currentUserRoles };
  } catch (err) {
    console.error("Error checking permissions:", err);
    return {
      isAuthorized: false,
      error: NextResponse.json({ error: "Internal server error" }, { status: 500 }),
    };
  }
}

/**
 * Page-level authorization guard for Server Components.
 *
 * `serverCheckRoles` returns a `NextResponse`, which a page cannot render, so pages had no
 * usable guard and relied entirely on middleware. Middleware is an optimisation, not a
 * boundary — it is one routing bug away from being bypassed, and it does not run for every
 * rendering path. Call this before any privileged data is fetched.
 *
 * Redirects rather than returning, so it never falls through on the caller's side.
 */
export async function requireRoles(required: UserRole[]) {
  const check = await serverCheckRoles(required);
  if (!check.isAuthorized) redirect("/unauthorized");
  return check;
}
