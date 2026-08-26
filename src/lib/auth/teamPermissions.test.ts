import { describe, expect, it } from "vitest";
import { UserRole } from "@/types/user";
import {
  GRANTABLE_TEAM_PERMISSIONS,
  TEAM_PERMISSION_ROLES,
  TeamAccess,
  TeamPermission,
  canForTeam,
  mayAssignAccess,
  mayDelegateGrant,
} from "@/lib/auth/permissions";

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
  { departmentName: "Fotografia", access: UserRole._MEMBER, source: "membership" },
  { departmentName: "Divulgação", access: UserRole._COORDINATOR, source: "membership" },
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
      {
        departmentName: "Fotografia de Eventos",
        access: UserRole._COORDINATOR,
        source: "membership",
      },
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
    const scopes: TeamAccess[] = [
      { departmentName: "Fotografia", access: UserRole._MEMBER, source: "membership" },
    ];
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
    { departmentName: DIRECAO, access: UserRole._COORDINATOR, source: "membership" },
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
    const member: TeamAccess[] = [
      { departmentName: DIRECAO, access: UserRole._MEMBER, source: "membership" },
    ];
    expect(mayAssignAccess([UserRole._MEMBER], member, DIRECAO, UserRole._MEMBER)).toBe(false);
  });

  /**
   * shop_manager ranks level with member, not above it: it is a different capability, not a
   * higher rank, and treating it as senior would let a shop manager assign membership roles.
   */
  it("does not treat shop_manager as senior to member", () => {
    const shopManager: TeamAccess[] = [
      { departmentName: DIRECAO, access: UserRole._SHOP_MANAGER, source: "membership" },
    ];
    expect(mayAssignAccess([UserRole._SHOP_MANAGER], shopManager, DIRECAO, UserRole._MEMBER)).toBe(
      false
    );
  });
});

/**
 * #184 — the price of unioning grants into the scope pipeline.
 *
 * Every guard now sees grants automatically, which is the point. These tests pin the two places
 * where that reach had to be paid for, because without them a two-week loan quietly becomes
 * permanent authority over someone else's team.
 */
describe("grants do not confer everything a membership does (#184)", () => {
  const membership = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
    source: "membership",
  });
  const grant = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
    source: "grant",
  });

  it("lets a grant open the team's workspace", async () => {
    // The whole purpose of the feature: borrowed access reaches the pages.
    expect(
      canForTeam(
        [UserRole._MEMBER],
        [grant("Fotografia", UserRole._MEMBER)],
        "team.workspace.view",
        "Fotografia"
      )
    ).toBe(true);
  });

  it("lets a coordinator-level grant edit the team's content", async () => {
    expect(
      canForTeam(
        [UserRole._MEMBER],
        [grant("Fotografia", UserRole._COORDINATOR)],
        "team.content.edit",
        "Fotografia"
      )
    ).toBe(true);
  });

  it("does NOT let a coordinator-level grant manage the team's members", async () => {
    // `team.members.manage` is absent from GRANTABLE_TEAM_PERMISSIONS. Lending someone the
    // workspace for a fortnight must not let them add and remove people from a team that is not
    // theirs — those memberships would outlive the grant that created them.
    expect(
      canForTeam(
        [UserRole._MEMBER],
        [grant("Fotografia", UserRole._COORDINATOR)],
        "team.members.manage",
        "Fotografia"
      )
    ).toBe(false);

    // A real coordinator of the same team still can.
    expect(
      canForTeam(
        [UserRole._COORDINATOR],
        [membership("Fotografia", UserRole._COORDINATOR)],
        "team.members.manage",
        "Fotografia"
      )
    ).toBe(true);
  });

  it("does NOT let a grant confer the power to assign permanent access", async () => {
    expect(
      mayAssignAccess(
        [UserRole._MEMBER],
        [grant("Fotografia", UserRole._COORDINATOR)],
        "Fotografia",
        UserRole._MEMBER
      )
    ).toBe(false);

    expect(
      mayAssignAccess(
        [UserRole._COORDINATOR],
        [membership("Fotografia", UserRole._COORDINATOR)],
        "Fotografia",
        UserRole._MEMBER
      )
    ).toBe(true);
  });
});

describe("mayDelegateGrant (#184)", () => {
  const membership = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
    source: "membership",
  });
  const grant = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
    source: "grant",
  });

  const held = grant("Fotografia", UserRole._COORDINATOR);

  it("lets a coordinator pass their grant to a member of their own team", () => {
    expect(
      mayDelegateGrant(
        [membership("Divulgação", UserRole._COORDINATOR), held],
        [membership("Divulgação", UserRole._MEMBER)],
        held,
        UserRole._MEMBER
      )
    ).toBe(true);
  });

  it("refuses delegating to someone outside the delegator's own team", () => {
    // "a member of HIS team", stated exactly. The Visuais person is a member of the núcleo, just
    // not one this coordinator has authority over.
    expect(
      mayDelegateGrant(
        [membership("Divulgação", UserRole._COORDINATOR), held],
        [membership("Visuais", UserRole._MEMBER)],
        held,
        UserRole._MEMBER
      )
    ).toBe(false);
  });

  it("refuses a delegator who is only a member of their own team", () => {
    expect(
      mayDelegateGrant(
        [membership("Divulgação", UserRole._MEMBER), held],
        [membership("Divulgação", UserRole._MEMBER)],
        held,
        UserRole._MEMBER
      )
    ).toBe(false);
  });

  it("refuses a delegator whose coordinator status is itself only a grant", () => {
    // A grant must never bootstrap the authority to make more grants, or one loan multiplies.
    expect(
      mayDelegateGrant(
        [grant("Divulgação", UserRole._COORDINATOR), held],
        [membership("Divulgação", UserRole._MEMBER)],
        held,
        UserRole._MEMBER
      )
    ).toBe(false);
  });

  it("refuses delegating more than was granted", () => {
    const memberGrant = grant("Fotografia", UserRole._MEMBER);
    expect(
      mayDelegateGrant(
        [membership("Divulgação", UserRole._COORDINATOR), memberGrant],
        [membership("Divulgação", UserRole._MEMBER)],
        memberGrant,
        UserRole._COORDINATOR
      )
    ).toBe(false);
  });

  it("never delegates admin", () => {
    expect(
      mayDelegateGrant(
        [membership("Divulgação", UserRole._COORDINATOR), held],
        [membership("Divulgação", UserRole._MEMBER)],
        held,
        UserRole._ADMIN
      )
    ).toBe(false);
  });
});

/**
 * The team-permission policy, written out.
 *
 * `permissions.test.ts` has done this for global permissions since #156; team permissions had no
 * equivalent, even though since #183 they decide who reads another team's workspace. A change to
 * `TEAM_PERMISSION_ROLES` does not fail to compile and does not fail a smoke test — it silently
 * widens or narrows access to internal material. So it is asserted here, and a policy change has
 * to be made twice, on purpose, and shows up in the diff.
 */
const EXPECTED_TEAM_POLICY: Record<TeamPermission, UserRole[]> = {
  "team.members.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "team.workspace.view": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._MEMBER,
    UserRole._SHOP_MANAGER,
  ],
  "team.content.edit": [UserRole._ADMIN, UserRole._COORDINATOR],
  // #129. Members may call meetings, matching what Notion allows today; coordinators run events,
  // because an event is the team acting outwards.
  "team.meetings.manage": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._MEMBER,
    UserRole._SHOP_MANAGER,
  ],
  "team.events.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  // #208. Same roles as manage, but absent from GRANTABLE_TEAM_PERMISSIONS — the distinction is
  // grantability, not which role holds it.
  "team.events.delete": [UserRole._ADMIN, UserRole._COORDINATOR],
  "team.events.publish": [UserRole._ADMIN, UserRole._COORDINATOR],
  // #219. Pulling Visuais in to make the poster is part of running the event.
  "team.events.collaborators": [UserRole._ADMIN, UserRole._COORDINATOR],
  // #130. Members manage tasks (ordinary team business); only coordinators delete them.
  "team.tasks.manage": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._MEMBER,
    UserRole._SHOP_MANAGER,
  ],
  "team.tasks.delete": [UserRole._ADMIN, UserRole._COORDINATOR],
  // #134. Coordinators of the team, plus the board. Absent from GRANTABLE — applications are
  // other people's personal data and the decision changes somebody's year.
  "team.recruitment.decide": [UserRole._ADMIN, UserRole._COORDINATOR],
};

/**
 * Which permissions a *borrowed* scope satisfies. Default-deny: a new team permission is not
 * grantable until it is added here, so forgetting refuses the grantee rather than over-serving.
 */
const EXPECTED_GRANTABLE: TeamPermission[] = [
  "team.workspace.view",
  "team.content.edit",
  "team.meetings.manage",
  "team.events.manage",
  "team.tasks.manage",
  // Decided 2026-08-23: grants are treated as membership for events, publishing included. The
  // accepted consequence is that a published event outlives the grant that created it.
  "team.events.publish",
  // #219. A borrowed coordinator scope exists so someone can help run the team's events, and
  // pulling in a collaborating team is part of that. Reversible, so nothing outlives the grant.
  "team.events.collaborators",
];

describe("team permission policy", () => {
  it("matches the written-down table exactly", () => {
    expect(TEAM_PERMISSION_ROLES).toEqual(EXPECTED_TEAM_POLICY);
  });

  it("has an entry for every team permission — no silent additions", () => {
    // A new permission with no line above fails here rather than being quietly ungoverned.
    expect(Object.keys(TEAM_PERMISSION_ROLES).sort()).toEqual(
      Object.keys(EXPECTED_TEAM_POLICY).sort()
    );
  });

  it("grants exactly the permissions a borrowed scope is meant to satisfy", () => {
    expect([...GRANTABLE_TEAM_PERMISSIONS].sort()).toEqual([...EXPECTED_GRANTABLE].sort());
  });

  it("never lets a grant DELETE a team's events", () => {
    // #208. Publishing outliving a grant was accepted knowingly; erasing the minutes archive was
    // not. A two-week loan must not be able to destroy a year of atas.
    expect(GRANTABLE_TEAM_PERMISSIONS).not.toContain("team.events.delete");
  });

  it("never lets a grant read or decide recruitment applications", () => {
    // #134. Applications hold names, phones, emails and motivations for people who may never
    // join. A borrowed two-week scope must not open that, nor decide who gets in.
    expect(GRANTABLE_TEAM_PERMISSIONS).not.toContain("team.recruitment.decide");
  });

  it("never lets a grant manage a team's membership", () => {
    // The one that must not drift: memberships created by a grantee outlive the grant.
    expect(GRANTABLE_TEAM_PERMISSIONS).not.toContain("team.members.manage");
  });
});

/**
 * #205 — role management is team-scoped, like membership management.
 *
 * `members.roles.manage` is a global permission held by every coordinator, and the roles handlers
 * took the department from the request body. So a coordinator of Fotografia could redefine
 * Dev-Team's access levels, or DELETE one — which stamps `to_date` on every live membership of
 * that role, terminating another team's whole roster.
 *
 * Demonstrated against a running app before the fix: `PATCH {departmentName:"Dev-Team", …}` from
 * an account whose only membership is Fotografia returned 200 and changed the row.
 *
 * The unit-level guard is `canForTeam(..., "team.members.manage", departmentName)` — the same
 * call `/api/admin/memberships` already made. These pin the decision it encodes.
 */
describe("role management is scoped to the caller's own team (#205)", () => {
  const membership = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
    source: "membership",
  });
  const grant = (departmentName: string, access: UserRole): TeamAccess => ({
    departmentName,
    access,
    source: "grant",
  });

  const fotografiaCoordinator = [membership("Fotografia", UserRole._COORDINATOR)];

  it("lets a coordinator manage roles in their own team", () => {
    expect(
      canForTeam(
        [UserRole._COORDINATOR],
        fotografiaCoordinator,
        "team.members.manage",
        "Fotografia"
      )
    ).toBe(true);
  });

  it("refuses them in another team", () => {
    expect(
      canForTeam([UserRole._COORDINATOR], fotografiaCoordinator, "team.members.manage", "Dev-Team")
    ).toBe(false);
  });

  it("still lets the board manage every team's roles", () => {
    // `_ADMIN` is ORGANISATION_WIDE, so the President is unaffected by the scoping.
    expect(
      canForTeam(
        [UserRole._ADMIN],
        [membership("Direção", UserRole._ADMIN)],
        "team.members.manage",
        "Dev-Team"
      )
    ).toBe(true);
  });

  it("does NOT let a temporary grant redefine the team's roles", () => {
    // `team.members.manage` is absent from GRANTABLE_TEAM_PERMISSIONS, which is what stops a
    // two-week loan from rewriting what a role is worth — a change that would outlive it.
    expect(
      canForTeam(
        [UserRole._MEMBER],
        [grant("Fotografia", UserRole._COORDINATOR)],
        "team.members.manage",
        "Fotografia"
      )
    ).toBe(false);
  });
});
