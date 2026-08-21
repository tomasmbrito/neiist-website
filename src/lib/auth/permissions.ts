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
