import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getUser } from "@/utils/db/userQueries";
import { UserRole, mapRoleToUserRole, hasRequiredRole } from "@/types/user";
import { Permission, rolesFor } from "@/lib/auth/permissions";
import { getUserFromJWT } from "@/utils/authUtils";

/**
 * Next signals control flow by *throwing*, not by returning: `cookies()` outside a request scope
 * throws `DynamicServerError` to mark the route dynamic, `redirect()` throws `NEXT_REDIRECT`,
 * `notFound()` throws `NEXT_NOT_FOUND`. Every one of them carries a `digest`.
 *
 * A blanket `catch` therefore does not just log an error — it *cancels the framework's control
 * flow*. `serverCheckRoles` swallowed `DynamicServerError`, so the signal Next uses to decide a
 * route is dynamic never reached it, and the route stayed a prerender candidate. That is the
 * whole reason pages needed `export const dynamic = "force-dynamic"` (#111).
 *
 * These are not our errors to handle. Re-throw them and only then fall back to the 500.
 */
const isFrameworkSignal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "digest" in error &&
  typeof (error as { digest: unknown }).digest === "string";

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
    if (isFrameworkSignal(err)) throw err;

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

/**
 * Authorize an API route by **what it does**, not by who happens to be allowed today.
 *
 * Prefer this over `serverCheckRoles` with a literal array. The array form spread the policy
 * across ~50 files, so nothing could answer "what can a coordinator do?" and the same rule ended
 * up written two different ways. `src/lib/auth/permissions.ts` is now the single place that
 * grants a capability to a role.
 *
 * Behaviour is identical to passing the permission's role list directly — `rolesFor` returns
 * exactly that list, and `hasRequiredRole` is the same intersection test as before.
 */
export async function serverCheckPermission(permission: Permission) {
  return serverCheckRoles([...rolesFor(permission)]);
}

/**
 * Page-level equivalent of `serverCheckPermission`. Redirects to /unauthorized rather than
 * returning a response, so it never falls through on the caller's side.
 */
export async function requirePermission(permission: Permission) {
  return requireRoles([...rolesFor(permission)]);
}
