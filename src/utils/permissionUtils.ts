import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { getUser, getUserTeamScopes } from "@/utils/db/userQueries";
import { UserRole, mapRoleToUserRole, hasRequiredRole } from "@/types/user";
import {
  Permission,
  rolesFor,
  TeamAccess,
  TeamPermission,
  canForTeam,
  isNeiistMember,
} from "@/lib/auth/permissions";
import { getUserFromJWT } from "@/utils/authUtils";
import { isFrameworkSignal } from "@/lib/errors/frameworkSignal";

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

/**
 * Resolve the caller's identity **and their team scopes** in one place (#183).
 *
 * The workspace asks a different question from every other guard in this file. Those ask "does
 * this person hold a role that grants X?"; the workspace asks "which teams is this person in?",
 * and the answer is per-team data, not a global role. `serverCheckRoles` cannot express it — a
 * coordinator of Visuais and a coordinator of Dev-Team hold the identical global role.
 *
 * Returns `null` rather than throwing for the unauthenticated case so callers choose between
 * redirecting (pages) and a 401 (routes).
 */
export async function getWorkspaceSession(): Promise<{
  user: Awaited<ReturnType<typeof getUser>>;
  roles: UserRole[];
  scopes: TeamAccess[];
} | null> {
  const sessionToken = (await cookies()).get("session")?.value;
  const jwtUser = getUserFromJWT(sessionToken);
  if (!jwtUser) return null;

  // Sequential on purpose: no point fetching scopes for an istid with no user record.
  const user = await getUser(jwtUser.istid);
  if (!user) return null;

  const roles: UserRole[] = user.roles?.map((r) => mapRoleToUserRole(r)) || [UserRole._GUEST];
  const scopes = await getUserTeamScopes(jwtUser.istid);

  return { user, roles, scopes };
}

/**
 * The members-only boundary. **Read this before adding a page under `/workspace`.**
 *
 * A logged-in non-member — any Técnico student who bought a t-shirt, any external Google account —
 * must see *nothing* here. That is the stated requirement and the reason this is a hard redirect
 * rather than an empty state: an empty state still confirms the page exists and still renders a
 * shell built from internal team names.
 *
 * Membership is `scopes.length > 0`, which is exact rather than heuristic: verified against the
 * database, both non-member populations return zero scopes.
 *
 * Board members pass through here on their global role, but only because holding `_ADMIN` implies
 * a membership that produced it.
 */
export async function requireNeiistMember() {
  const session = await getWorkspaceSession();
  if (!session) redirect("/unauthorized");
  if (!isNeiistMember(session.scopes)) redirect("/unauthorized");
  return session;
}

/**
 * The per-team boundary: may this caller open *this* team's workspace?
 *
 * Being a member is not enough — a member of Visuais must not read Dev-Team's pages. This is the
 * page-level counterpart of `canForTeam`, and it must be called by every team-scoped page. The
 * team name is untrusted input from the URL; `canForTeam` compares it against the caller's own
 * scopes, so an unknown or misspelled team simply matches nothing and is refused.
 */
export async function requireTeamWorkspace(departmentName: string, permission: TeamPermission) {
  const session = await requireNeiistMember();
  if (!canForTeam(session.roles, session.scopes, permission, departmentName)) {
    redirect("/unauthorized");
  }
  return session;
}
