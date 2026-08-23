import { describe, expect, it } from "vitest";
import { UserRole, hasRequiredRole } from "@/types/user";
import {
  PERMISSION_ROLES,
  ROLE_PERMISSIONS,
  Permission,
  can,
  rolesFor,
  isNeiistMember,
  visibleWorkspaceTeams,
  TeamAccess,
} from "@/lib/auth/permissions";

/**
 * #156. This file has one job that matters more than the others: prove the refactor changed
 * **who can do what** by exactly nothing.
 *
 * The migration replaced ~50 hardcoded `UserRole` arrays with named permissions. A mistake there
 * does not fail to compile and does not fail a smoke test — it silently widens or narrows access
 * on one route. So the old arrays are written out here verbatim, and asserted against the table.
 */

/**
 * The reviewed policy: who is expected to hold each permission.
 *
 * It started as a verbatim transcription of the role array each call site passed **before**
 * #156, so the refactor could be proven to change nothing. It is no longer purely that — #167
 * deliberately changed the two `users.directory.*` entries, and that line is edited here in the
 * same commit rather than the assertion being loosened.
 *
 * That is the whole point of this file: a policy change has to be written down twice, on
 * purpose, and shows up in the diff where a reviewer can see it.
 */
const EXPECTED_POLICY: Record<Permission, UserRole[]> = {
  "org.units.manage": [UserRole._ADMIN],
  "members.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "members.roles.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  // Added in #193. _COORDINATOR absent is the whole point: it is what stops a coordinator
  // promoting their own role to admin and becoming an organisation-wide administrator.
  "members.roles.grantAdmin": [UserRole._ADMIN],
  "members.photos.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "teams.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "users.manage": [UserRole._ADMIN],
  // CHANGED ON PURPOSE in #167, which is why this line is edited rather than the assertion
  // loosened. Read admitted _MEMBER but not _SHOP_MANAGER and write was the reverse; both were
  // defects. See the block comment in permissions.ts.
  "users.directory.read": [UserRole._ADMIN, UserRole._COORDINATOR, UserRole._SHOP_MANAGER],
  "users.directory.write": [UserRole._ADMIN, UserRole._COORDINATOR, UserRole._SHOP_MANAGER],
  "users.profile.update": [UserRole._ADMIN, UserRole._COORDINATOR, UserRole._MEMBER],
  "activities.manage": [UserRole._ADMIN],
  // Added in #127. _GUEST absent: this is what keeps internal meetings out of an anonymous
  // response, so it is written down here on purpose rather than inherited.
  "activities.viewInternal": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._SHOP_MANAGER,
    UserRole._MEMBER,
  ],
  "shop.products.manage": [UserRole._ADMIN],
  "shop.categories.manage": [UserRole._ADMIN],
  "shop.discounts.manage": [UserRole._ADMIN],
  "shop.uploads.write": [UserRole._ADMIN],
  "shop.orders.viewAll": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._SHOP_MANAGER,
    UserRole._MEMBER,
  ],
  "shop.orders.create": [UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN],
  "shop.orders.setStatus": [UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN],
  "shop.orders.recordPayment": [UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN],
  "shop.pos.use": [UserRole._ADMIN, UserRole._SHOP_MANAGER],
  "shop.readers.manage": [UserRole._SHOP_MANAGER, UserRole._ADMIN],
};

const ALL_ROLES = Object.values(UserRole);

describe("the permission table matches the reviewed policy", () => {
  it.each(Object.keys(PERMISSION_ROLES) as Permission[])(
    "%s grants exactly the reviewed set of roles",
    (permission) => {
      expect([...rolesFor(permission)].sort()).toEqual([...EXPECTED_POLICY[permission]].sort());
    }
  );

  /**
   * The real check: for every permission and every role, `can()` must agree with the
   * `hasRequiredRole` call a route would make with the reviewed role list. This is what caught
   * the refactor being a no-op, rather than the table above merely matching itself.
   */
  it.each(Object.keys(PERMISSION_ROLES) as Permission[])(
    "%s: can() agrees with hasRequiredRole for every role",
    (permission) => {
      for (const role of ALL_ROLES) {
        expect(can([role], permission)).toBe(hasRequiredRole([role], EXPECTED_POLICY[permission]));
      }
    }
  );
});

describe("can", () => {
  it("is false for a guest on every permission", () => {
    for (const permission of Object.keys(PERMISSION_ROLES) as Permission[]) {
      expect(can([UserRole._GUEST], permission)).toBe(false);
    }
  });

  it("is false for a user with no roles at all", () => {
    expect(can([], "shop.orders.setStatus")).toBe(false);
    expect(can(undefined, "shop.orders.setStatus")).toBe(false);
  });

  it("grants when any one of several held roles qualifies", () => {
    expect(can([UserRole._GUEST, UserRole._SHOP_MANAGER], "shop.pos.use")).toBe(true);
  });

  /**
   * Roles are a flat set, not a hierarchy — `hasRequiredRole` is an intersection test and always
   * has been. Pinning it so nobody "fixes" admin into a superuser by accident, which would grant
   * it members.manage, users.directory.read and every other permission it does not hold today.
   */
  it("does not treat admin as implying the other roles", () => {
    expect(can([UserRole._ADMIN], "users.directory.read")).toBe(true); // admin IS listed here
    expect(can([UserRole._ADMIN], "members.manage")).toBe(true); // and here
    expect(can([UserRole._COORDINATOR], "org.units.manage")).toBe(false); // but not implied
    expect(can([UserRole._SHOP_MANAGER], "shop.products.manage")).toBe(false);
  });
});

describe("ROLE_PERMISSIONS", () => {
  it("is the exact inverse of PERMISSION_ROLES", () => {
    for (const role of ALL_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(rolesFor(permission)).toContain(role);
      }
    }
    for (const [permission, roles] of Object.entries(PERMISSION_ROLES)) {
      for (const role of roles as readonly UserRole[]) {
        expect(ROLE_PERMISSIONS[role]).toContain(permission as Permission);
      }
    }
  });

  it("gives _GUEST nothing", () => {
    expect(ROLE_PERMISSIONS[UserRole._GUEST]).toEqual([]);
  });

  it("has an entry for every role, so a new role cannot be silently missing", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });
});

/**
 * #183 — the members-only workspace boundary.
 *
 * These tests exist because the requirement is stated as a *security* property: "the other people
 * who login to the website but are not NEIIST members should not be able to see these pages".
 * That makes the interesting cases the negative ones, so most of what follows asserts refusal.
 */
describe("isNeiistMember", () => {
  const scope = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
  });

  it("refuses a logged-in Técnico student who belongs to no team", () => {
    // The shop customer. Authenticated, real istid, zero memberships — and the single most
    // likely person to try the URL, since they already have a working session.
    expect(isNeiistMember([])).toBe(false);
  });

  it("refuses an external Google account", () => {
    // ext_ istids cannot hold a membership at all, so they arrive here with undefined scopes.
    expect(isNeiistMember(undefined)).toBe(false);
  });

  it("admits a member holding a single plain membership", () => {
    expect(isNeiistMember([scope("Visuais", UserRole._MEMBER)])).toBe(true);
  });
});

describe("visibleWorkspaceTeams", () => {
  const ALL = ["Dev-Team", "Divulgação", "Visuais"];
  const scope = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
  });

  it("shows a member only their own team", () => {
    // The core requirement: "a member of the team Visuais should only have access to the pages
    // related to the Visuais team".
    const scopes = [scope("Visuais", UserRole._MEMBER)];
    expect(visibleWorkspaceTeams([UserRole._MEMBER], scopes, ALL)).toEqual(["Visuais"]);
  });

  it("unions the teams of someone who belongs to several", () => {
    const scopes = [scope("Visuais", UserRole._MEMBER), scope("Dev-Team", UserRole._COORDINATOR)];
    expect(visibleWorkspaceTeams([UserRole._COORDINATOR], scopes, ALL)).toEqual([
      "Dev-Team",
      "Visuais",
    ]);
  });

  it("does NOT let a coordinator of one team see another", () => {
    // #180 restated at the page level. Being a coordinator is a global role, so a naive check
    // against `can()` would pass here and expose every team to any team's coordinator.
    const scopes = [scope("Dev-Team", UserRole._COORDINATOR)];
    expect(visibleWorkspaceTeams([UserRole._COORDINATOR], scopes, ALL)).toEqual(["Dev-Team"]);
  });

  it("shows the board every team", () => {
    // "the board members should have full access to all the pages". _ADMIN is organisation-wide.
    const scopes = [scope("Direção", UserRole._ADMIN)];
    expect(visibleWorkspaceTeams([UserRole._ADMIN], scopes, ALL)).toEqual(ALL);
  });

  it("shows a non-member nothing even if the team list is non-empty", () => {
    expect(visibleWorkspaceTeams([UserRole._GUEST], [], ALL)).toEqual([]);
  });

  it("deduplicates a team where someone holds two roles", () => {
    // Two positions in one team is common (#8) and must not produce two sidebar entries.
    const scopes = [scope("Dev-Team", UserRole._COORDINATOR), scope("Dev-Team", UserRole._MEMBER)];
    expect(visibleWorkspaceTeams([UserRole._COORDINATOR], scopes, ALL)).toEqual(["Dev-Team"]);
  });
});
