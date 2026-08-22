import { UserRole } from "@/types/user";

/**
 * What the server can be asked to authorize.
 *
 * ## Why this exists
 *
 * Authorization policy used to live as ~50 hardcoded `UserRole` arrays spread across route
 * handlers and pages. Nothing could answer "what can a coordinator do?" without a grep, and the
 * same rule appeared written two different ways (`[_SHOP_MANAGER, _ADMIN]` in five places,
 * `[_ADMIN, _SHOP_MANAGER]` in one). That is the shape that produced #97 and #117, where a
 * privileged route's list did not match its neighbour's and a path was effectively public.
 *
 * ## Semantics, which are deliberately unchanged
 *
 * Roles are a **flat set**, not a hierarchy: `hasRequiredRole` is an intersection test, so
 * `_ADMIN` does not imply `_COORDINATOR` and never has. Each permission therefore lists every
 * role that holds it, exactly as the old arrays did. Introducing a hierarchy here would be a
 * behaviour change wearing a refactor's clothes.
 *
 * `serverCheckRoles([])` — "any authenticated user" — is not a permission question and keeps
 * using the role helper.
 *
 * ## The rule
 *
 * This table is the only place a capability is granted. A route asks for a permission; it does
 * not decide who has one.
 */
export const PERMISSION_ROLES = {
  // ---- Organisation structure (admin bodies, departments, teams) -----------------------------
  "org.units.manage": [UserRole._ADMIN],

  // ---- Members, roles and memberships --------------------------------------------------------
  "members.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "members.roles.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "members.photos.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  "teams.manage": [UserRole._ADMIN, UserRole._COORDINATOR],

  // ---- User directory ------------------------------------------------------------------------
  /** The full user list as read by the admin area. */
  "users.manage": [UserRole._ADMIN],
  /**
   * The user directory, read and written by the shop's customer picker and its
   * create-walk-in-customer modal.
   *
   * The two halves of `/api/admin/users` used to carry *different* role sets — read admitted
   * _MEMBER but not _SHOP_MANAGER, write the reverse — which was two live defects (#167):
   * the shop manager running the stand could create a customer but not list customers, and any
   * member could pull every student's phone, email, GitHub and LinkedIn in one request.
   *
   * Now the same set both ways, which is what one expects of a single resource.
   */
  "users.directory.read": [UserRole._ADMIN, UserRole._COORDINATOR, UserRole._SHOP_MANAGER],
  "users.directory.write": [UserRole._ADMIN, UserRole._COORDINATOR, UserRole._SHOP_MANAGER],
  /** Editing a user record through the admin path. */
  "users.profile.update": [UserRole._ADMIN, UserRole._COORDINATOR, UserRole._MEMBER],

  // ---- Activities ----------------------------------------------------------------------------
  "activities.manage": [UserRole._ADMIN],
  /**
   * See internal (non-public) events and meetings (#127).
   *
   * _GUEST is absent on purpose: this is the boundary that keeps an internal meeting out of an
   * anonymous response. External Google-account users resolve to _GUEST, so they are excluded
   * too, which is correct — they are not members of the núcleo.
   */
  "activities.viewInternal": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._SHOP_MANAGER,
    UserRole._MEMBER,
  ],

  // ---- Shop: catalogue -----------------------------------------------------------------------
  "shop.products.manage": [UserRole._ADMIN],
  "shop.categories.manage": [UserRole._ADMIN],
  "shop.discounts.manage": [UserRole._ADMIN],
  "shop.uploads.write": [UserRole._ADMIN],

  // ---- Shop: orders --------------------------------------------------------------------------
  "shop.orders.viewAll": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._SHOP_MANAGER,
    UserRole._MEMBER,
  ],
  "shop.orders.create": [UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN],
  "shop.orders.setStatus": [UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN],
  "shop.orders.recordPayment": [UserRole._SHOP_MANAGER, UserRole._COORDINATOR, UserRole._ADMIN],

  // ---- Shop: point of sale and card readers --------------------------------------------------
  "shop.pos.use": [UserRole._ADMIN, UserRole._SHOP_MANAGER],
  "shop.readers.manage": [UserRole._SHOP_MANAGER, UserRole._ADMIN],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSION_ROLES;

/**
 * The same table inverted: role -> what it can do.
 *
 * Derived rather than hand-maintained, so the two can never disagree. This is the direction the
 * permission matrix screen (#157) renders, and the direction a human actually asks the question
 * in ("what can a coordinator do?").
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = (() => {
  const byRole = Object.fromEntries(
    Object.values(UserRole).map((role) => [role, [] as Permission[]])
  ) as Record<UserRole, Permission[]>;

  for (const [permission, roles] of Object.entries(PERMISSION_ROLES)) {
    for (const role of roles as readonly UserRole[]) {
      byRole[role].push(permission as Permission);
    }
  }

  return byRole;
})();

/**
 * Does any of the roles this user holds grant `permission`?
 *
 * Mirrors `hasRequiredRole`'s intersection semantics exactly, so migrating a call site from a
 * role array to a permission cannot change who gets in.
 */
export function can(userRoles: readonly UserRole[] | undefined, permission: Permission): boolean {
  const granted = PERMISSION_ROLES[permission] as readonly UserRole[];
  return (userRoles ?? []).some((role) => granted.includes(role));
}

/** The roles that hold a permission. Used by the guards and by the matrix screen. */
export function rolesFor(permission: Permission): readonly UserRole[] {
  return PERMISSION_ROLES[permission];
}

/**
 * Portuguese labels for the permission matrix screen (#157).
 *
 * The matrix is for the núcleo, not for developers, so a coordinator can read what their access
 * level actually allows without asking someone to grep. Typed as a total record, so adding a
 * permission without labelling it fails `yarn type:check` rather than rendering a bare key.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "org.units.manage": "Gerir órgãos sociais, departamentos e equipas",
  "members.manage": "Gerir membros e as suas participações",
  "members.roles.manage": "Gerir cargos e o nível de acesso que concedem",
  "members.photos.manage": "Gerir fotografias dos membros",
  "teams.manage": "Gerir equipas",
  "users.manage": "Administrar utilizadores",
  "users.directory.read": "Consultar o diretório de utilizadores",
  "users.directory.write": "Criar utilizadores no diretório",
  "users.profile.update": "Editar o perfil de um utilizador",
  "activities.manage": "Gerir atividades e o calendário",
  "activities.viewInternal": "Ver eventos e reuniões internos",
  "shop.products.manage": "Gerir produtos da loja",
  "shop.categories.manage": "Gerir categorias da loja",
  "shop.discounts.manage": "Gerir códigos de desconto",
  "shop.uploads.write": "Carregar imagens de produtos",
  "shop.orders.viewAll": "Ver todas as encomendas",
  "shop.orders.create": "Criar encomendas",
  "shop.orders.setStatus": "Alterar o estado de encomendas",
  "shop.orders.recordPayment": "Registar pagamentos",
  "shop.pos.use": "Usar o ponto de venda",
  "shop.readers.manage": "Gerir leitores de cartões SumUp",
};

/** Portuguese labels for the access levels themselves. */
export const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole._ADMIN]: "Administrador",
  [UserRole._COORDINATOR]: "Coordenador",
  [UserRole._SHOP_MANAGER]: "Gestor de Loja",
  [UserRole._MEMBER]: "Membro",
  [UserRole._GUEST]: "Convidado",
};

/**
 * Permissions grouped by their domain prefix, in a stable order, for rendering.
 * Derived from the table so a new permission appears with no further edit.
 */
export function permissionsByDomain(): Array<{ domain: string; permissions: Permission[] }> {
  const groups = new Map<string, Permission[]>();
  for (const permission of Object.keys(PERMISSION_ROLES) as Permission[]) {
    const domain = permission.split(".")[0];
    groups.set(domain, [...(groups.get(domain) ?? []), permission]);
  }
  return [...groups.entries()].map(([domain, permissions]) => ({ domain, permissions }));
}

/**
 * Permissions that are meaningful *within a team* rather than globally (#180).
 *
 * Separate from `Permission` on purpose: a team-scoped question must not be answerable by the
 * global `can()`, which would silently ignore the team and grant on "coordinator somewhere".
 * Keeping the two types distinct makes that mistake fail to compile rather than fail quietly.
 */
export const TEAM_PERMISSION_ROLES = {
  /** Add or remove people in a specific team. */
  "team.members.manage": [UserRole._ADMIN, UserRole._COORDINATOR],
  /**
   * Open a team's workspace at all. Every access level qualifies **except `_GUEST`**, because
   * belonging to the team is the whole requirement — a plain member of Visuais reads the Visuais
   * workspace. `_SHOP_MANAGER` is included: it is an access level held *within* a team, not a
   * lesser kind of membership.
   */
  "team.workspace.view": [
    UserRole._ADMIN,
    UserRole._COORDINATOR,
    UserRole._MEMBER,
    UserRole._SHOP_MANAGER,
  ],
  /** Edit a team's workspace content. Its coordinators, not its members. */
  "team.content.edit": [UserRole._ADMIN, UserRole._COORDINATOR],
} as const satisfies Record<string, readonly UserRole[]>;

export type TeamPermission = keyof typeof TEAM_PERMISSION_ROLES;

/** A team the caller belongs to, and the access level they hold there. */
export type TeamAccess = { departmentName: string; access: UserRole };

/**
 * Organisation-wide access levels: holding one grants a team permission in EVERY team.
 *
 * `_ADMIN` only. `_COORDINATOR` is deliberately excluded — being a coordinator of one team is
 * exactly the claim that must not carry into another, which is the whole of #180.
 */
const ORGANISATION_WIDE: readonly UserRole[] = [UserRole._ADMIN];

/**
 * May this caller exercise `permission` **in this specific team**?
 *
 * Answers what three hand-rolled checks were approximating. The rule is:
 *
 *   - an organisation-wide role (admin) qualifies anywhere;
 *   - otherwise the caller must hold a qualifying access level **in that team**, taken from
 *     their membership there rather than from the flattened union across all teams.
 *
 * This can never be wider than the global `can()` for the same underlying roles: both operands
 * are drawn from roles the caller actually holds, and the team branch is strictly narrower
 * because it filters by department first.
 */
export function canForTeam(
  globalRoles: readonly UserRole[] | undefined,
  teamScopes: readonly TeamAccess[] | undefined,
  permission: TeamPermission,
  departmentName: string
): boolean {
  const granted = TEAM_PERMISSION_ROLES[permission] as readonly UserRole[];

  if ((globalRoles ?? []).some((role) => ORGANISATION_WIDE.includes(role))) return true;

  // EXACT comparison, deliberately.
  //
  // An earlier version trimmed and lower-cased both sides "defensively". That was a widening:
  // `neiist.departments.name` is a case-sensitive VARCHAR(30) primary key, so "Fotografia" and
  // "fotografia" can both exist — verified by inserting both. A coordinator of one would then
  // have been authorized for the other, while the route wrote to the RAW name it was given.
  // Authorizing on a normalised value and acting on the un-normalised one is exactly how a check
  // and its effect come apart, which is the same class of confusion as #180.
  //
  // Wrong casing or stray whitespace now fails closed here, and would have failed the foreign
  // key on the write anyway.
  if (departmentName === "") return false;

  return (teamScopes ?? []).some(
    (scope) => scope.departmentName === departmentName && granted.includes(scope.access)
  );
}

/**
 * How much authority an access level carries, for comparing one against another (#180 follow-up).
 *
 * Roles are otherwise a flat set — `hasRequiredRole` is an intersection test and this does not
 * change that. This ordering exists for exactly one question: "is the role being handed out
 * stronger than the one doing the handing?"
 *
 * `shop_manager` sits level with `member` on purpose: it is a different capability, not a higher
 * rank, and treating it as senior would let a shop manager assign membership roles.
 */
const ACCESS_RANK: Record<UserRole, number> = {
  [UserRole._GUEST]: 0,
  [UserRole._MEMBER]: 1,
  [UserRole._SHOP_MANAGER]: 1,
  [UserRole._COORDINATOR]: 2,
  [UserRole._ADMIN]: 3,
};

export function accessRank(role: UserRole): number {
  return ACCESS_RANK[role] ?? 0;
}

/**
 * May this caller hand out a role carrying `targetAccess` in `departmentName`?
 *
 * Closes a live privilege escalation. `neiist.add_team_member` checks only that the user exists
 * and that the (department, role) pair is valid, so a coordinator of a department containing an
 * admin-level role could assign it — to themselves. Verified against the seeded data: Direção
 * holds both `Diretora de Atividades (Alameda)` (coordinator) and `Presidente` (admin), so a
 * Diretora de Atividades POSTed herself `Presidente` and came back a global administrator.
 *
 * The rule: you may never grant authority you do not hold. Organisation-wide access grants
 * anything; otherwise the caller's rank *in that department* must be at least the target's.
 */
export function mayAssignAccess(
  globalRoles: readonly UserRole[] | undefined,
  teamScopes: readonly TeamAccess[] | undefined,
  departmentName: string,
  targetAccess: UserRole
): boolean {
  if ((globalRoles ?? []).some((role) => ORGANISATION_WIDE.includes(role))) return true;

  const callerRank = (teamScopes ?? [])
    .filter((scope) => scope.departmentName === departmentName)
    .reduce((highest, scope) => Math.max(highest, accessRank(scope.access)), 0);

  // Two conditions, not one. "At least coordinator" is what makes this safe to call on its own:
  // rank comparison alone would let a member assign a member-level role, which is unreachable
  // today only because the caller must already have passed `team.members.manage`. A security
  // helper should not depend on its caller having checked something first.
  return callerRank >= accessRank(UserRole._COORDINATOR) && callerRank >= accessRank(targetAccess);
}

/**
 * Is this person a NEIIST member at all?
 *
 * **This is not "are they logged in", and that distinction is the entire security boundary of the
 * workspace (#183).** Three populations reach a logged-in state on this site:
 *
 *   - Técnico students who authenticate through Fenix but belong to no team — customers of the
 *     shop and attendees of activities, not members of the núcleo;
 *   - external Google accounts (synthetic `ext_` istid), who cannot hold a membership at all;
 *   - actual members, who hold at least one current membership.
 *
 * Only the third may see the workspace. Membership is derived from live scopes rather than stored
 * as a flag, so it follows automatically when someone joins or leaves a team — there is no second
 * source of truth that can be forgotten.
 */
export function isNeiistMember(teamScopes: readonly TeamAccess[] | undefined): boolean {
  return (teamScopes ?? []).length > 0;
}

/**
 * The teams whose workspace this caller may open, sorted for a stable menu.
 *
 * Organisation-wide access (`_ADMIN` — the Presidente, Vice-Presidente and Vogal today) sees every
 * team, which is what "board members should have full access" means. Everyone else sees exactly
 * the teams they belong to, and the union is automatic for someone in several.
 *
 * `allTeamNames` is passed in rather than read here so this stays a pure function over the
 * caller's claims, testable without a database.
 */
export function visibleWorkspaceTeams(
  globalRoles: readonly UserRole[] | undefined,
  teamScopes: readonly TeamAccess[] | undefined,
  allTeamNames: readonly string[]
): string[] {
  if ((globalRoles ?? []).some((role) => ORGANISATION_WIDE.includes(role))) {
    return [...allTeamNames].sort((a, b) => a.localeCompare(b, "pt"));
  }

  const mine = (teamScopes ?? [])
    .filter((scope) =>
      canForTeam(globalRoles, teamScopes, "team.workspace.view", scope.departmentName)
    )
    .map((scope) => scope.departmentName);

  return [...new Set(mine)].sort((a, b) => a.localeCompare(b, "pt"));
}
