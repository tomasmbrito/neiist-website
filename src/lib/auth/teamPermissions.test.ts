import { describe, expect, it } from "vitest";
import { UserRole } from "@/types/user";
import { canForTeam, mayAssignAccess, TeamAccess } from "@/lib/auth/permissions";

/**
 * #180 — the escalation this closes, stated as a test.
 *
 * `getUser().roles` is the union of access levels across every team, so "is this person a
 * coordinator" cannot distinguish which team they coordinate. Three call sites needed the
 * distinction and approximated it; the membership API asked "coordinator somewhere AND a member
 * of this team", which let a plain Membro of Fotografia manage Fotografia.
 */

/** Ana: a plain member of Fotografia, a coordinator of Divulgação. */
const ANA_GLOBAL_ROLES = [UserRole._COORDINATOR, UserRole._MEMBER];
const ANA_SCOPES: TeamAccess[] = [
  { departmentName: "Fotografia", access: UserRole._MEMBER },
  { departmentName: "Divulgação", access: UserRole._COORDINATOR },
];

describe("canForTeam", () => {
  /** The exact escalation, reproduced against a running app before the fix. */
  it("refuses a team the caller only belongs to, despite coordinating another", () => {
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "Fotografia")).toBe(
      false
    );
  });

  it("allows the team the caller actually coordinates", () => {
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "Divulgação")).toBe(
      true
    );
  });

  it("refuses a team the caller does not belong to at all", () => {
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "Dev-Team")).toBe(false);
  });

  it("allows an admin in every team, including ones they do not belong to", () => {
    expect(canForTeam([UserRole._ADMIN], [], "team.members.manage", "Dev-Team")).toBe(true);
  });

  /**
   * Pinned deliberately: making _COORDINATOR organisation-wide would restore the bug, because
   * coordinating one team would again carry into all of them.
   */
  it("does not treat coordinator as organisation-wide", () => {
    expect(canForTeam([UserRole._COORDINATOR], [], "team.members.manage", "Fotografia")).toBe(
      false
    );
  });

  it("refuses a guest, and a caller with no scopes", () => {
    expect(canForTeam([UserRole._GUEST], [], "team.members.manage", "Fotografia")).toBe(false);
    expect(canForTeam(undefined, undefined, "team.members.manage", "Fotografia")).toBe(false);
  });

  it("fails closed on an empty or whitespace team name rather than matching everything", () => {
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "")).toBe(false);
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "   ")).toBe(false);
  });

  /**
   * CHANGED after security review. An earlier version folded case and trimmed "defensively";
   * that was a widening, because `departments.name` is a case-sensitive primary key and
   * "Fotografia" and "fotografia" can both exist — while the route writes with the RAW name.
   * A coordinator of one would have been authorized for the other.
   */
  it("requires an exact team-name match, because the write uses the raw value", () => {
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", " Divulgação ")).toBe(
      false
    );
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "divulgação")).toBe(
      false
    );
    expect(canForTeam(ANA_GLOBAL_ROLES, ANA_SCOPES, "team.members.manage", "Divulgação")).toBe(
      true
    );
  });

  /**
   * The old profile check used `team.toLowerCase().includes("fotografia")`, so a team merely
   * containing the word would have qualified. Exact matching is the fix.
   */
  it("does not match a team whose name merely contains the target", () => {
    const scopes: TeamAccess[] = [
      { departmentName: "Fotografia de Eventos", access: UserRole._COORDINATOR },
    ];
    expect(canForTeam([UserRole._COORDINATOR], scopes, "team.members.manage", "Fotografia")).toBe(
      false
    );
  });

  /**
   * Structural guarantee worth pinning: a team-scoped grant is never wider than the global one,
   * because both are drawn from roles the caller actually holds.
   */
  it("cannot grant to a caller who holds no qualifying role anywhere", () => {
    const scopes: TeamAccess[] = [{ departmentName: "Fotografia", access: UserRole._MEMBER }];
    expect(canForTeam([UserRole._MEMBER], scopes, "team.members.manage", "Fotografia")).toBe(false);
  });
});

/**
 * The privilege escalation found by security review of #180, and verified live before the fix:
 * a Diretora de Atividades (coordinator of Direção) POSTed herself the `Presidente` role, whose
 * access is `admin`, and came back a global administrator — {coordinator} -> {admin,coordinator}.
 *
 * `add_team_member` only checks that the user exists and that the (department, role) pair is
 * valid for that department, so nothing stopped a coordinator handing out an admin-level role
 * that happens to live in the same department. Direção holds both today.
 */
describe("mayAssignAccess", () => {
  const DIRECAO = "Direção";
  const coordinatorOfDirecao: TeamAccess[] = [
    { departmentName: DIRECAO, access: UserRole._COORDINATOR },
  ];

  it("refuses a coordinator handing out an admin-level role", () => {
    expect(
      mayAssignAccess([UserRole._COORDINATOR], coordinatorOfDirecao, DIRECAO, UserRole._ADMIN)
    ).toBe(false);
  });

  it("allows a coordinator to hand out coordinator and member roles in their own department", () => {
    expect(
      mayAssignAccess([UserRole._COORDINATOR], coordinatorOfDirecao, DIRECAO, UserRole._COORDINATOR)
    ).toBe(true);
    expect(
      mayAssignAccess([UserRole._COORDINATOR], coordinatorOfDirecao, DIRECAO, UserRole._MEMBER)
    ).toBe(true);
  });

  it("refuses a coordinator in a department they do not coordinate", () => {
    expect(
      mayAssignAccess([UserRole._COORDINATOR], coordinatorOfDirecao, "Visuais", UserRole._MEMBER)
    ).toBe(false);
  });

  it("allows an admin to hand out anything, anywhere", () => {
    expect(mayAssignAccess([UserRole._ADMIN], [], "Visuais", UserRole._ADMIN)).toBe(true);
  });

  it("refuses a plain member entirely", () => {
    const member: TeamAccess[] = [{ departmentName: DIRECAO, access: UserRole._MEMBER }];
    expect(mayAssignAccess([UserRole._MEMBER], member, DIRECAO, UserRole._MEMBER)).toBe(false);
  });

  /**
   * shop_manager ranks level with member, not above it: it is a different capability, not a
   * higher rank, and treating it as senior would let a shop manager assign membership roles.
   */
  it("does not treat shop_manager as senior to member", () => {
    const shopManager: TeamAccess[] = [{ departmentName: DIRECAO, access: UserRole._SHOP_MANAGER }];
    expect(mayAssignAccess([UserRole._SHOP_MANAGER], shopManager, DIRECAO, UserRole._MEMBER)).toBe(
      false
    );
  });
});
