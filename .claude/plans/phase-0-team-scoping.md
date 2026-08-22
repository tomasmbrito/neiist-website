# Plan: Phase 0 — per-team authorization on the existing department model (#128)

**Status: proposal.** Written after reading `notion-to-website-plan.md` §5.2/5.3/6, the live
`neiist` schema, and every current call site that already tries to answer "which team is this
person in".

---

## 0. The issue's premise is false, and following it would be actively harmful

#128 says *"There is no concept of a team in the database today"* and asks for
`neiist.teams (id, slug, name, active)` + `neiist.team_members (…)`.

Verified against the running dev database (`postgres:15.19`, container `neiist_db`) and
`docker/schema.sql`:

| #128 asks for | Already exists |
|---|---|
| `teams` table | **`neiist.teams` literally already exists** — `schema.sql:101`, `name VARCHAR(30) PK REFERENCES neiist.departments(name)`, `description`. `CREATE TABLE neiist.teams` would fail. |
| seeded with the teams | `neiist.departments` holds all seven Notion teams as `department_type='team'`, active: Contacto, Controlo & Qualidade, Dev-Team, Divulgação, Fotografia, Organização de Eventos, Visuais — plus Direção / Conselho Fiscal / Mesa da Assembleia Geral as `admin_body`. |
| `team_members(team_id, user_istid, role, joined_at, left_at)` | `neiist.membership(user_istid, department_name, role_name, from_date, to_date)` — `schema.sql:121`. `to_date` **is** `left_at`, and `get_user` already filters on it. |
| history matters | `idx_membership_active` and `idx_membership_to_date` (`schema.sql:145-148`) exist for exactly this. |
| admin UI for team membership | `/team-management`, `/departments-management` and `/api/admin/memberships` already ship. |

Building the proposed tables would create a **second parallel model** of the same facts. This
repository has already paid for that once: #119 deleted a 1,053-line repository layer with zero
call sites, written against a UUID migration that was never applied
(`decision-log.md`, 2026-08-12). Doing it again would fork membership between two tables, one of
which `get_user` reads and the other of which nothing reads.

**So this plan extends the existing model.** Acceptance criteria 1 ("teams and team_members
exist, seeded"), 5 ("Coordenação can manage membership through an admin page") and the
blocked-on item "#111" are **already satisfied**; #111 was fixed in PR #149 and
`permissionUtils.ts:21-25` carries the `isFrameworkSignal` re-throw.

The issue also lists #80 as a blocker because "membership changes are multi-table". They are not:
`add_team_member` is one `INSERT`, `remove_team_member` is one `UPDATE`. Nothing in this plan
needs `withTransaction`.

### Where I disagree with the framing in the task brief

The brief says the two gaps are (1) no `TEAM_LEAD` and (2) no per-team scoping. Both are real.
But per-team scoping is not *absent* — it exists **three times, hand-rolled, and two of the three
are wrong**:

1. `src/app/api/admin/memberships/route.ts:9-33` — `checkMembershipPermission`.
2. `src/app/api/user/update/[userId]/route.ts:25-27` — `teams.some(t => t.toLowerCase().includes("fotografia"))`.
3. `src/app/team-management/page.tsx:31-45` — fetches every user, every membership and every
   valid role, then derives "my coordinator teams" in JavaScript.

That changes the job from "invent a mechanism" to "replace three divergent copies with one",
which is a stronger argument and a smaller diff.

---

## 1. Context — what I found

### 1.1 The live defect that motivates the whole story

`neiist.get_user` (`schema.sql:434-444`) aggregates access levels **across all departments**:

```sql
array_agg(DISTINCT vdr.access::TEXT) AS access_array   -- GROUP BY m.user_istid
```

So `User.roles` is a flat set with the department stripped off. `User.teams`
(`schema.sql:445-453`) is a flat set of department names, also stripped. **The pairing is lost.**

Consequence, in production code today:

> Someone who is a plain **Membro of Fotografia** and **Coordenador of Divulgação** has
> `roles = [member, coordinator]` and `teams = [Fotografia, Divulgação]`.
> `checkMembershipPermission("Fotografia")` sees `isCoordinator === true` and
> `userTeams.includes("Fotografia") === true`, and **authorizes them to add and remove
> Fotografia memberships.**

That is the concrete bug. No amount of `TEAM_LEAD` fixes it; it needs the `(department, access)`
pair, which nothing currently returns.

`/team-management/page.tsx:38` has a second, independent widening:
`role.access === UserRole._COORDINATOR || role.role_name === "Coordenador"` — an `OR` on the role
**name**, so a role deliberately demoted to `access='member'` but still called "Coordenador"
counts as coordinator.

`api/user/update/[userId]:27` has a third: `.toLowerCase().includes("fotografia")` is a substring
match on a department name that any admin can rename or create.

### 1.2 `getUser` is on the hot path and already does more work than anyone thinks

`serverCheckRoles` → `getUser` runs on **every guarded page and API route**. `getUser`
(`src/utils/db/userQueries.ts:60-121`) issues:

1. `SELECT * FROM neiist.get_user($1::VARCHAR(50))`
2. `SELECT * FROM neiist.get_all_memberships() WHERE user_istid = $1 AND active = TRUE`
3. `N` parallel `get_department_role_order` calls, one per distinct department (the #119 N+1 fix).

Step 2 is worse than it reads. `get_all_memberships()` is a set-returning **plpgsql** function
(`schema.sql:978`) — an optimisation barrier. The outer `WHERE user_istid = $1` **cannot** be
pushed into it, so Postgres materialises `membership ⋈ users ⋈ departments`, sorts it by
`u.name, d.department_type, department_name, role_name`, and *then* keeps one person's rows.
A full scan and sort of the membership table, on every guarded request.

**This is the key to the design: the data per-team authorization needs is already being
fetched on every request. It is only missing the `access` column, and it is being fetched the
most expensive way possible.**

### 1.3 Adding a value to `neiist.user_access_enum` — measured, not assumed

Run against the real `postgres:15.19`, inside a transaction that was rolled back:

```
BEGIN;
ALTER TYPE neiist.user_access_enum ADD VALUE IF NOT EXISTS 'team_lead';   -- ALTER TYPE  (works)
SELECT 'team_lead'::neiist.user_access_enum;
  ERROR:  unsafe use of new value "team_lead" of enum type neiist.user_access_enum
  HINT:   New enum values must be committed before they can be used.
ROLLBACK;                                                  -- value is gone again
```

So, for `scripts/migrate.mts` (which wraps each *file* in one transaction,
`database-migrations.md` §2):

- `ALTER TYPE … ADD VALUE` **does not** need `-- migrate:no-transaction` on PG ≥ 12. It runs
  fine, and it rolls back cleanly if the file fails.
- But **nothing else in that file may reference `'team_lead'`.** Also measured: a
  `LANGUAGE sql` function body referencing it fails at `CREATE` (the body is parsed);
  a `LANGUAGE plpgsql` body succeeds (the body is only text until runtime).
- `IF NOT EXISTS` makes it idempotent, and creates a trap: a file that adds the value *and*
  uses it would **fail on first run and succeed on retry**. Do not write one.

Therefore: the `ADD VALUE` gets **a file of its own**, and the runner's per-file transaction
boundary is what makes the next file's use of it legal.

### 1.4 A second defect found while writing the test for AC #4

AC #4 is "a member with `left_at` set loses access". Testing it exposed this, reproduced in a
rolled-back transaction:

```
SELECT neiist.add_team_member('istZZTEST1','Fotografia','Membro');   -- ok
SELECT neiist.remove_team_member('istZZTEST1','Fotografia','Membro');
  ERROR: new row for relation "membership" violates check constraint "valid_member_dates"
  DETAIL: Failing row contains (istZZTEST1, Fotografia, Membro, 2026-08-21, 2026-08-21).
```

`valid_member_dates` is `CHECK (to_date IS NULL OR to_date > from_date)` (`schema.sql:129`), and
`remove_team_member` sets `to_date = CURRENT_DATE`. **Adding someone to a team and removing them
the same day is impossible.** `removeTeamMember` swallows the error and returns `false`, so the
UI shows a generic 500. The same `SET to_date = CURRENT_DATE` appears in `remove_team`,
`remove_department`, `remove_admin_body` and `remove_valid_department_role` — all five are hit.

### 1.5 Everything else that has to move when a `UserRole` is added

Roles are a **flat set**, not a hierarchy (`permissions.ts:14-19`, and the pinning test at
`permissions.test.ts:116`). `_TEAM_LEAD` therefore implies **nothing** — not even `_MEMBER`.
Every list that enumerates roles must gain it explicitly or a team lead is silently locked out:

- `src/types/user.ts:42` `mapRoleToUserRole` — **the dangerous one.** Its `default` returns
  `_GUEST`, so without a `case "team_lead"` a lead with no other role becomes a guest.
- `src/proxy.ts:87-103` — `guestRoutes` (`/profile`, `/my-orders`, `/shop/cart`, …),
  `memberRoutes` (`/orders`), `coordRoutes` (`/team-management`, `/photo-management`).
  Miss `guestRoutes` and a team lead cannot open their own profile.
- `ROLE_LABELS: Record<UserRole, string>` (`permissions.ts:167`) — a compile error until
  labelled. This one is caught by `tsc`; the two above are not.
- `src/schemas/admin.ts:8`, `src/utils/db/userQueries.ts:399`, `src/types/memberships.ts:9`,
  `src/components/admin/RolesSearchFilter.tsx:315` — the four places the access levels are
  written out for the admin UI, so the level is assignable at all.
- `src/lib/auth/permissions.test.ts:31` `EXPECTED_POLICY` — by design, a policy change must be
  written down twice.

---

## 2. Approach

### 2.1 The model: extend, do not duplicate

- **A "team"** is `neiist.departments` where `department_type = 'team'`. No new table.
- **"Ana is in Fotografia"** is a row in `neiist.membership`. No new table.
- **"Afonso leads Fotografia"** is a `valid_department_roles` row for `('Fotografia', <role>)`
  whose `access` is the new `'team_lead'`. No new column.
- **`left_at`** is `membership.to_date`. Already enforced everywhere.

### 2.2 The authorization API

One new pure function, in the same file family as `can()`:

```ts
// src/types/user.ts — beside UserRole, so User can reference it without a cycle
export interface TeamScope {
  department: string;                          // neiist.departments.name — the PK, exact match
  departmentType: "team" | "admin_body";
  roleName: string;
  access: UserRole;                            // what THIS membership grants
}

// src/lib/auth/teamScope.ts
export interface TeamAuthorization {
  roles: readonly UserRole[];                  // as serverCheckRoles resolved them
  scopes: readonly TeamScope[];                // one entry per ACTIVE membership
}

export function canForTeam(
  authz: TeamAuthorization,
  permission: TeamScopedPermission,
  department: string
): boolean;
```

Semantics, stated precisely because this is the part that can widen access:

```
scoped  = authz.scopes.filter(s => s.department === department)
                      .map(s => s.access)
                      .filter(r => authz.roles.includes(r))      // <- the intersection
orgWide = authz.roles.filter(r => ORG_WIDE_ACCESS.includes(r))   // ORG_WIDE_ACCESS = [_ADMIN]

return can(orgWide, permission) || can(scoped, permission)
```

Three deliberate properties:

1. **`canForTeam` can never grant more than `can`.** Both operands are subsets of `authz.roles`,
   so `canForTeam(a, p, d) ⟹ can(a.roles, p)`, *by construction*. This is the safety invariant,
   and §5 tests it exhaustively over every permission × role. Adding a team-scoped check to a
   route can therefore only ever narrow it.
2. **The `authz.roles.includes(r)` intersection is not redundant.** `mapDbUserToUser` applies
   `devOverrideRole` (`userUtils.ts:47`), which *replaces* the role set in development.
   Without the intersection, `DEV_ISTID=ist1234[MEMBER]` would fail to demote a real admin on
   team-scoped routes — the override would be inert exactly where it is used to test policy.
3. **`_ADMIN` is the only organisation-wide level.** `_COORDINATOR` is evaluated **only within
   the department it was granted in**. That matches what `checkMembershipPermission` already
   intends, and it is what closes §1.1.

### 2.3 Team-scoped permissions are a separate, type-distinct kind

Rather than reusing `members.manage` in both a global and a scoped sense — which is how you end
up with two competing authorization stories — two new entries, with a naming convention:

```ts
"members.manage.team":        [_ADMIN, _COORDINATOR, _TEAM_LEAD],
"members.photos.manage.team": [_ADMIN, _COORDINATOR, _TEAM_LEAD],
```

and a type split so the compiler enforces which helper may evaluate which:

```ts
export const TEAM_SCOPED_PERMISSIONS = ["members.manage.team", "members.photos.manage.team"] as const;
export type TeamScopedPermission = (typeof TEAM_SCOPED_PERMISSIONS)[number];
export type GlobalPermission     = Exclude<Permission, TeamScopedPermission>;

can(roles, p: GlobalPermission)                          // unchanged behaviour
canForTeam(authz, p: TeamScopedPermission, department)   // the only way to reach a .team permission
```

`serverCheckPermission` / `requirePermission` narrow to `GlobalPermission`. Passing
`"members.manage.team"` to `serverCheckPermission` then **fails to compile**, which is the point:
a `.team` permission cannot be accidentally evaluated without a team.

`members.manage` itself stays `[_ADMIN, _COORDINATOR]` — `_TEAM_LEAD` gets **no** global
permission that `_MEMBER` does not already have. Its extra power exists only through `canForTeam`.

### 2.4 The guards, mirroring the existing trio exactly

| existing | new | used by |
|---|---|---|
| `serverCheckPermission(p)` | `serverCheckTeamPermission(p, department)` | API routes whose department is in the path/query |
| `requirePermission(p)` | `requireTeamPermission(p, department)` | Server Components |
| `withValidation(schema, { permission }, h)` | `withValidation(schema, { teamPermission, team: (parsed) => … }, h)` | API routes whose department is **in the body** |

The `withValidation` variant is what keeps #147 intact where it can be kept. The wrapper will:

1. `serverCheckRoles([])` — reject an **unauthenticated** caller with 401 *before* `req.json()`.
   This is the exact leak #147 fixed (an anonymous `POST /api/shop/discounts` receiving the full
   Zod shape) and it stays fixed.
2. parse the body,
3. `canForTeam(...)` on the department the body names → 403.

**Trade-off, stated rather than hidden:** an *authenticated* caller who is not authorized for
that team can still see Zod's field-level detail. That is unavoidable when the authorization
subject is inside the body, and it is a much smaller disclosure than #147's (a signed-in núcleo
member learning the shape of a members payload). Recorded in the decision log.

### 2.5 Resolving "which teams is this user in, right now" — zero extra queries

New SQL function, deliberately a **mirror of `get_user`'s own filters** so the scope set and the
role set can never disagree:

```sql
CREATE OR REPLACE FUNCTION neiist.get_user_team_scopes(u_istid VARCHAR(50))
RETURNS TABLE (department_name VARCHAR(30), department_type VARCHAR(20),
               role_name VARCHAR(40), access TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT m.department_name, d.department_type, m.role_name, vdr.access::TEXT
  FROM neiist.membership m
  JOIN neiist.departments d ON d.name = m.department_name
  JOIN neiist.valid_department_roles vdr
    ON vdr.department_name = m.department_name AND vdr.role_name = m.role_name
  WHERE m.user_istid = u_istid
    AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)     -- identical to get_user
    AND vdr.active = TRUE                                   -- identical to get_user
  ORDER BY d.department_type, m.department_name, m.role_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

Notes that matter:
- `d.active` is **deliberately not** filtered on, because `get_user` does not. Adding it would
  make `scopes` stricter than `roles` and break the §2.2 invariant's exactness. It is redundant
  anyway: `remove_department` deactivates the roles and stamps `to_date`.
- `access` is returned as `TEXT`, not the enum, so a future enum value needs no node-pg type
  handling and lands in `mapRoleToUserRole` — whose `default` is `_GUEST`, i.e. fail-closed.
- The `ORDER BY` reproduces `get_all_memberships`'s ordering minus `u.name` (constant for one
  user). This preserves `getUser`'s `memberships[0]?.roleName` fallback for `positionName`.
- Served by `idx_membership_active` (`user_istid, to_date` WHERE `to_date IS NULL`).

`getUser` then **replaces** its `get_all_memberships()` call with this one and hangs the result
on the returned `User` as `scopes`. Net effect:

- one full-table scan + sort removed from the hottest path in the application;
- `serverCheckTeamPermission` reads `check.user.scopes` — **no extra round trip anywhere**;
- `getUser` stops building a `Membership[]` whose `from_date` / `to_date` / `user_name` it never
  reads.

`User.scopes` is optional (`getAllUsers` does not populate it). `serverCheckTeamPermission` uses
`check.user?.scopes ?? []`, which denies, and logs `console.error` if it is missing — that would
be a bug, not a state. **`User.scopes` reaching the client via `/api/auth/userdata` is a UI hint
only and is never a boundary**; the server always re-reads from `getUser` within the request.

### 2.6 Rejected alternatives

- **`neiist.teams` / `neiist.team_members` as #128 specifies** — §0. `neiist.teams` already
  exists, and a second membership table forks the truth.
- **Adding a column to `neiist.get_user`'s `RETURNS TABLE`** — changing the return type needs
  `DROP FUNCTION` + `CREATE`, which drops the `EXECUTE` grant. If `ALTER DEFAULT PRIVILEGES`
  does not cover the migrating role in production, `neiist_app_user` loses `get_user` and **the
  entire site 500s on every authenticated request.** It would also force lock-step edits to
  `add_user` and `update_user`, which both `RETURN QUERY SELECT * FROM neiist.get_user(...)`
  (`schema.sql:508`, `:845`). A new `CREATE OR REPLACE` function has none of that risk.
- **A parallel `getUserTeamScopes` query in `serverCheckRoles`** — a second pool checkout on
  every guarded request, to fetch data `getUser` was already fetching.
- **Making `_TEAM_LEAD` imply `_MEMBER`** — a role hierarchy was explicitly rejected in #156
  (`decision-log.md`, 2026-08-20) as "a behaviour change wearing a refactor's clothes".
- **Flipping the seven teams' "Coordenador" roles from `coordinator` to `team_lead` in a
  migration** — see §4, this must not happen in this story.

---

## 3. Steps

### A — schema and migrations *(human approval required)*

1. [ ] `docker/migrations/007_team_lead_access_level.sql` — **this file contains exactly one
   statement:** `ALTER TYPE neiist.user_access_enum ADD VALUE IF NOT EXISTS 'team_lead';`
   Header comment records the measured PG-15 constraint from §1.3 and states in bold that
   nothing referencing `'team_lead'` may be added to this file.
   It does **not** need `-- migrate:no-transaction`.
2. [ ] `docker/schema.sql:19-24` — append `'team_lead'` **after `'member'`**, last. `ADD VALUE`
   without `BEFORE`/`AFTER` appends, and `yarn db:schema-diff` (#152) compares dumps; inserting
   it alphabetically would make a migrated database differ from a fresh one forever.
3. [ ] `docker/migrations/008_user_team_scopes.sql` — `CREATE OR REPLACE FUNCTION
   neiist.get_user_team_scopes(...)` per §2.5, plus
   `GRANT EXECUTE ON FUNCTION neiist.get_user_team_scopes(VARCHAR(50)) TO neiist_app_user;`
   (the house pattern — see `schema.sql:3302-3304`). Idempotent by `CREATE OR REPLACE`.
4. [ ] `docker/schema.sql` — same function, placed next to `get_all_memberships` (~`:1010`);
   the `GRANT` beside the existing ones at `:3302`.
5. [ ] `docker/migrations/009_membership_same_day_leave.sql` — relax the §1.4 constraint:
   ```sql
   ALTER TABLE neiist.membership DROP CONSTRAINT IF EXISTS valid_member_dates;
   ALTER TABLE neiist.membership ADD  CONSTRAINT valid_member_dates
     CHECK (to_date IS NULL OR to_date >= from_date);
   ```
   Idempotent (drop-then-add). No `NOT VALID` needed — this **relaxes**, so every row that
   passed `>` passes `>=`. Access is not widened: `active` is still
   `to_date IS NULL OR to_date > CURRENT_DATE`, so a same-day leave is inactive immediately.
   Separate file so a reviewer can drop it from the PR without touching 007/008.
6. [ ] `docker/schema.sql:129` — the same relaxed `CHECK`.

### B — types and the permission catalogue

7. [ ] `src/types/user.ts` — add `_TEAM_LEAD = "team_lead"` to `UserRole`; add
   `case "team_lead": return UserRole._TEAM_LEAD;` to `mapRoleToUserRole` (**without this a
   team lead silently becomes `_GUEST`**); add the `TeamScope` interface; add
   `scopes?: readonly TeamScope[]` to `User` with the "UI hint, never a boundary" comment.
   `TeamScope` lives here, not in `lib/auth/`, to avoid a cycle with `User`.
8. [ ] `src/lib/auth/permissions.ts` — add `members.manage.team` and
   `members.photos.manage.team` (`[_ADMIN, _COORDINATOR, _TEAM_LEAD]`); add `_TEAM_LEAD` to
   `users.profile.update`, `activities.viewInternal`, `shop.orders.viewAll` (exact `_MEMBER`
   parity — a lead is a member first, and the flat set means it must be said); export
   `TEAM_SCOPED_PERMISSIONS`, `TeamScopedPermission`, `GlobalPermission`; add
   `PERMISSION_LABELS` ("Gerir participações da própria equipa" / "Gerir fotografias da própria
   equipa") and `ROLE_LABELS[_TEAM_LEAD] = "Líder de Equipa"`.
9. [ ] `src/lib/auth/teamScope.ts` (new) — `ORG_WIDE_ACCESS`, `canForTeam` per §2.2, plus
   `teamsWhere(authz, permission): string[]` (every department the permission holds for), which
   is what `/team-management` needs.
10. [ ] `src/lib/auth/teams.ts` (new) — `export const PHOTO_TEAM = "Fotografia";` with a comment
    that this is a `neiist.departments.name` **primary key value**, matched exactly, and that
    renaming the department in the admin UI silently breaks the photo guard. §5 adds a test that
    fails if the department stops existing.

### C — data layer

11. [ ] `src/utils/db/userQueries.ts` — add `getUserTeamScopes(istid)` calling
    `SELECT * FROM neiist.get_user_team_scopes($1::VARCHAR(50))` (**`::VARCHAR(50)`, never
    `VARCHAR(10)`** — CLAUDE.md §4), mapping `access` through `mapRoleToUserRole`.
12. [ ] `src/utils/db/userQueries.ts:66-71` — `getUser` calls `getUserTeamScopes` instead of
    `get_all_memberships()`; derives `uniqueDepartments` and the `positionName` fallback from
    the scope rows; returns `{ ...mapDbUserToUser(user), positionName, scopes }`.
    Behaviour note to put in the diff: a membership whose `valid_department_roles` row is
    `active = FALSE` no longer contributes to `positionName`. That matches `roles`, which has
    always filtered it out, and is the intended reading of a deactivated role.

### D — the guards

13. [ ] `src/utils/permissionUtils.ts` — narrow `serverCheckPermission` / `requirePermission` to
    `GlobalPermission`; add `serverCheckTeamPermission(permission, department)` and
    `requireTeamPermission(permission, department)`, both built on `serverCheckRoles([])` so
    there is still exactly one authentication path.
14. [ ] `src/utils/security/validationUtils.ts` — make `ValidationAuth` generic in the parsed
    type and add the `{ teamPermission, team: (parsed: T) => string }` variant per §2.4. The
    two existing variants and all five current call sites are unchanged.

### E — the call sites that become team-scoped *(and only these)*

15. [ ] `src/schemas/admin.ts` — add `membershipMutationSchema`
    (`istid`, `departmentName`, `roleName`, all `.min(1)`); add `"team_lead"` to
    `departmentRoleAccessSchema`.
16. [ ] `src/app/api/admin/memberships/route.ts` — **delete `checkMembershipPermission`
    entirely.** `POST`/`DELETE` become
    `withValidation(membershipMutationSchema, { teamPermission: "members.manage.team", team: (p) => p.departmentName }, …)`.
    This is the §1.1 fix. `GET` keeps `serverCheckPermission("members.manage")` — narrowing the
    read would break `/team-management` for coordinators and is a separate decision (§7).
17. [ ] `src/app/api/user/update/[userId]/route.ts:25-27` — `isPhotoCoord` becomes
    `canForTeam({ roles, scopes }, "members.photos.manage.team", PHOTO_TEAM)`.
    Exact match replaces the substring match.
18. [ ] `src/app/photo-management/page.tsx:17` —
    `requireTeamPermission("members.photos.manage.team", PHOTO_TEAM)` instead of
    `requirePermission("members.photos.manage")`. Today **any** coordinator, of any team, can
    manage every member's photo from this page while the API half checks Fotografia; the two
    halves currently disagree.
19. [ ] `src/app/team-management/page.tsx:22-45` — replace the JWT read, the
    `getAllValidDepartmentRoles()` call and the JS derivation with
    `teamsWhere(check, "members.manage.team")` off the `requirePermission` result. Removes the
    `role_name === "Coordenador"` widening and one full-table query from the page.
20. [ ] `src/components/layout/navbar/UserMenu.tsx:63-64` — the photo-management menu entry uses
    `userData.scopes` and exact match. UI hint only; step 18 is the boundary.
21. [ ] `src/proxy.ts:87-103` — add `UserRole._TEAM_LEAD` to the allowed lists for
    `guestRoutes`, `memberRoutes` **and** `coordRoutes`. Missing `guestRoutes` locks a team lead
    out of `/profile`. `/photo-management` is in `coordRoutes`, so a team lead reaches the proxy
    layer and is then correctly refused by step 18 — the two-layer model working as intended.

### F — making the level assignable through the existing UI (no new screen)

22. [ ] `src/utils/db/userQueries.ts:399` — `DepartmentRoleAccess` gains `"team_lead"`.
23. [ ] `src/types/memberships.ts:9` — `Role.access` gains `"team_lead"`.
24. [ ] `src/components/admin/RolesSearchFilter.tsx:315` — add
    `<option value="team_lead">Líder de Equipa</option>`.
    With 15/22/23 done, `/departments-management` (the #157/#158 screen) can already set any
    department role to `team_lead`, and the permission matrix renders the new column from the
    derived `ROLE_PERMISSIONS`. AC #2 is met with no new UI.

### G — tests (§5)

25. [ ] `src/lib/auth/teamScope.test.ts` — pure.
26. [ ] `src/utils/db/teamScopes.test.ts` — against the real database.
27. [ ] `src/lib/auth/permissions.test.ts` — extend `EXPECTED_POLICY` with the two new
    permissions and every `_TEAM_LEAD` grant, deliberately, per that file's contract.

### H — memory

28. [ ] `docs/ai-workflow/problem-registry.md` — the §1.1 cross-team flatten defect and the
    §1.4 same-day-leave constraint, both with the reproduction transcript.
29. [ ] `docs/ai-workflow/decision-log.md` — three rows: extend departments/membership rather
    than build `teams`/`team_members`; `_ADMIN` is the only organisation-wide access level;
    the §2.4 Zod-detail trade-off for body-derived team authorization.
30. [ ] `CLAUDE.md` §8 + `AGENTS.md` — a short "per-team authorization" paragraph: `canForTeam`
    is the only way to answer a team question, `.team` permissions are type-separated, and
    `User.scopes` on the client is a hint.
31. [ ] `docs/ai-workflow/project-status.md` — #128 done, with the #128-premise correction
    recorded so Phase 1 does not re-propose `neiist.teams`.

---

## 4. Out of scope — explicitly

- **No `neiist.teams` / `neiist.team_members` tables.** §0.
- **No change to any existing `valid_department_roles.access` value.** In particular the seven
  teams' "Coordenador" roles keep `access='coordinator'` and are **not** flipped to
  `'team_lead'` by a migration. That flip is the real narrowing (a Fotografia coordinator would
  lose `members.manage`, `users.directory.read` and `users.directory.write` globally), it needs
  a named human decision about who currently relies on those, and it is unsafe during a
  blue/green deploy: `deploy_prod.sh` migrates **before** restarting, so the *previous* release
  would briefly read `team_lead` and `mapRoleToUserRole` would map it to `_GUEST`. Assignment
  happens through the admin UI after the new release is live. Its own story.
- **No transactions.** §0 — the membership mutations are single-statement.
- **No new tables of any kind**, no `internal_events`, no `requirements`. Phases 1–3.
- **No scoping of shop, orders, activities or `/users-management`.** Phase 0 establishes the
  mechanism on the two places that already hand-roll it plus their two pages. Converting the
  whole surface is how a foundation story turns into a rewrite.
- **`/api/admin/memberships` GET stays global**, and `/team-management` still passes the full
  `getAllUsers()` directory to a client component. Both are reads the caller is already entitled
  to under `users.directory.read`; narrowing them is a separate, visible decision.
- **`positionName`'s `normalize()` accent-stripping** (`userQueries.ts:78-83`) is left alone.
  Department **names** are matched exactly by `canForTeam`; that helper matches *role* names for
  display ordering and is not an authorization path.

### Noticed but out of scope — board candidates

- `addCollaborator` (`userQueries.ts:158-176`) loops `add_valid_department_role` +
  `add_team_member` per team, each in its own statement, with `catch {}` around the first.
  A partial failure leaves a user in some teams and not others. Genuine `withTransaction` work.
- `addMember` (`:135-155`) auto-creates a department, a team and a role inside a `try {} catch {}`
  when they are missing — it can invent departments as a side effect of adding a member.
- `getUsersByAccess` (`userQueries.ts:~380`) selects a `campus` column that is not in
  `get_users_by_access`'s `RETURNS TABLE`; it must be throwing and being swallowed.
- `neiist.get_all_memberships()` is still an optimisation barrier for `/team-management`,
  `/photo-management` and `/about-us`, which each pull the whole table.

---

## 5. Verification

`yarn type:check`, `yarn lint`, `yarn format:check`, `yarn build` are the floor, not the proof.

### 5.1 Migrations, in this order, against the live local database

1. `yarn db:migrate:status` → 007/008/009 pending.
2. **Reproduce first** (`database-migrations.md` §4): the §1.4 transcript, and
   `SELECT enum_range(NULL::neiist.user_access_enum)` showing four values.
3. `yarn db:migrate` → applies.
4. Same two commands showing five values and a successful same-day add+remove.
5. `yarn db:migrate` **again** → "Nothing to apply", proving idempotence and that no checksum
   drifted.
6. Deliberately write a throwaway 4th file that both adds the enum value *and* uses it; confirm
   it fails with `unsafe use of new value`; delete it. This is the §1.3 trap, proven once so the
   comment in 007 is believed.

### 5.2 Unit tests — `src/lib/auth/teamScope.test.ts`

- **The safety invariant, exhaustively.** For every `TeamScopedPermission` × every subset of a
  fixture scope set × every department: `canForTeam(a, p, d) ⟹ can(a.roles, p)`. This is the
  assertion that makes "adding a team check cannot widen a route" a fact rather than a claim.
- **The §1.1 regression, written as the exact scenario**: `scopes = [{Fotografia, Membro,
  _MEMBER}, {Divulgação, Coordenador, _COORDINATOR}]`, `roles = [_MEMBER, _COORDINATOR]`
  → `canForTeam(…, "members.manage.team", "Fotografia") === false`,
  `… "Divulgação") === true`.
- **Exact matching**: `"Divulgacao"`, `"divulgação"`, `"Controlo e Qualidade"` and `"fotografia"`
  must all be `false` against `"Divulgação"` / `"Controlo & Qualidade"` / `"Fotografia"`.
  This is the `.includes("fotografia")` regression.
- **`_ADMIN` from Direção** grants every team.
- **Empty scopes**, `undefined` roles → `false` for everything.
- **`_TEAM_LEAD` of A** holds `members.manage.team` for A and not for B, and holds **no** global
  permission `_MEMBER` lacks (assert against `ROLE_PERMISSIONS`).
- **Dev-override intersection**: `roles = [_MEMBER]` with a scope carrying `_ADMIN` → `false`.

### 5.3 Database tests — `src/utils/db/teamScopes.test.ts`

Same shape as `departmentRoles.test.ts`: an owner `Client` from `MIGRATION_DATABASE_URL` for
fixtures, the exported function for the code under test, `ZZ Test%` names, full `afterEach`
cleanup.

- Two memberships in two departments at two access levels → exactly two scopes, correctly paired.
- **AC #4**: stamp `to_date = CURRENT_DATE` → the scope disappears **and** `getUser().roles`
  drops the level, in the same assertion, proving the two views agree.
- `valid_department_roles.active = FALSE` → the scope disappears.
- **`getUser` still agrees with itself**: for a fixture user, every `scope.access` is a member of
  `user.roles`. This is the runtime half of the §2.2 invariant, and it is what catches anyone
  editing one SQL filter and not the other.
- `PHOTO_TEAM` resolves: `SELECT 1 FROM neiist.departments WHERE name = 'Fotografia' AND active`
  returns a row. Fails loudly the day someone renames the department.
- The §1.4 fix: `add_team_member` then `remove_team_member` in one day succeeds, and the
  membership is inactive immediately afterwards.

### 5.4 Mutation — the guards are only trusted if breaking them fails a test

Per the standing practice (`decision-log.md`, 2026-08-19: "`Promise.all` is not a concurrency
test"). Each of these is applied, the suite is run, the failure is recorded in the PR body, and
the mutation is reverted:

| mutation | must fail |
|---|---|
| drop `s.department === department` from `canForTeam` | the §1.1 regression test |
| drop `.filter(r => authz.roles.includes(r))` | the dev-override test |
| `ORG_WIDE_ACCESS = [_ADMIN, _COORDINATOR]` | the §1.1 regression test |
| compare departments with `.toLowerCase().includes(...)` | the exact-match tests |
| drop `(m.to_date IS NULL OR m.to_date > CURRENT_DATE)` from `get_user_team_scopes` | the AC-#4 test |
| drop `vdr.active = TRUE` | the inactive-role test |
| remove `case "team_lead"` from `mapRoleToUserRole` | a `_TEAM_LEAD` grant test |

A mutation that fails **nothing** means the test is decorative and gets rewritten.

### 5.5 Manual, at the API level, per the issue's own instruction

With `DEV_ISTID` overrides and `curl`, against the dev database, for a user who is
Membro of Fotografia **and** Coordenador of Divulgação:

1. `POST /api/admin/memberships {"departmentName":"Divulgação",…}` → 200.
2. `POST /api/admin/memberships {"departmentName":"Fotografia",…}` → **403**. Before this
   change it is 200. This is the headline result.
3. `PUT /api/user/update/<someone-else>` with a `photo` field, as a Contacto coordinator → the
   photo is not written.
4. `GET /photo-management` as a Contacto coordinator → `/unauthorized`.
5. As an unauthenticated caller, `POST /api/admin/memberships` with a malformed body → **401**,
   with no Zod detail. Confirms #147 survives step 14.
6. Assign `team_lead` to a Fotografia role through `/departments-management`, log that user in,
   and confirm: `/profile` loads (proxy step 21), `/team-management` shows **only** Fotografia,
   and `/photo-management` is refused for a lead of any other team.

### 5.6 Before merging

Run `yarn db:schema-diff "<production URL>"` (#152) — a **human** task, it needs production
credentials. Steps 1–6 rewrite `neiist.membership`'s CHECK constraint and add an enum value on a
database whose actual schema is still unmeasured (`database-migrations.md` §5). Every migration
here is idempotent, so this is a confidence check rather than a blocker — but the membership
constraint is the first one this project has *replaced* on a table that holds real rows.

---

## 6. Risks, ranked

1. **A route is converted to `canForTeam` and the department string does not match the
   `departments.name` PK.** Silent, total denial for that team, looking like a permissions bug.
   Mitigations: exact-match tests over the real accented/ampersand names (§5.2); the
   `PHOTO_TEAM`-exists test (§5.3); only four call sites converted.
2. **`_TEAM_LEAD` is missed in one of the flat-set enumerations.** `ROLE_LABELS` is caught by
   `tsc`; `mapRoleToUserRole` and the three `proxy.ts` lists are **not**, and the failure is a
   team lead locked out of `/profile` with no error anywhere. Mitigations: steps 7 and 21 are
   separate checklist items; §5.4 mutates `mapRoleToUserRole`; §5.5 step 6 exercises a real
   `team_lead` login end to end.
3. **Someone assigns `team_lead` in production before the new release is live**, or during the
   blue/green window. `deploy_prod.sh` migrates before restarting, so the old release maps
   `team_lead` → `_GUEST`. A user whose *only* access was that level is locked out until the
   restart. Fails **closed**, not open — but it is a real outage for that person. Mitigation:
   §4 forbids any migration from assigning the level; assignment is a post-deploy UI action.
4. **The `getUser` rewrite (step 12) changes `positionName` for someone.** It runs on every
   guarded page, so a mistake here is site-wide. The behaviour delta is precisely: memberships
   whose role is `active = FALSE` no longer contribute. Mitigations: the `ORDER BY` is
   reproduced deliberately (§2.5); a test asserts `positionName` for a fixture user with an
   inactive role before and after.
5. **Narrowing `/photo-management` (step 18) removes access from someone who uses it today.**
   The dev seed has nobody in Fotografia, so this can only be checked against production data.
   Mitigation: before merging, list who currently satisfies the old rule
   (`coordinator` anywhere **and** any Fotografia membership) and confirm each still satisfies
   the new one; if not, the fix is a `valid_department_roles` row, not a looser guard.
6. **Relaxing `valid_member_dates` (step 5) permits zero-day membership rows.** By design; they
   are inactive the moment they are written, because `active` tests `to_date > CURRENT_DATE`.
   No widening. Called out only so a reviewer does not have to work it out.
7. **`User.scopes` is mistaken for a boundary by a future author**, because it is present on the
   client. Mitigations: the doc comment on the field, the `CLAUDE.md` §8 paragraph, and the fact
   that the only helper that consumes scopes on the server takes them from `getUser` inside the
   request.
8. **`withValidation`'s new variant leaks Zod detail to an authenticated-but-unauthorized
   caller.** Accepted and recorded (§2.4); unauthenticated callers are still refused before
   `req.json()`.

---

## 7. Approvals needed

Per CLAUDE.md §7 and §9, **all four categories that need a human are touched**:

- **Schema** — `docker/schema.sql` and three files in `docker/migrations/`. Steps 1–6.
- **Auth / permissions** — a new `UserRole`, two new permissions, a new authorization primitive,
  and four converted call sites. Steps 7–21.
- **Payments** — not touched. `shop.*` permissions are unchanged except that `_TEAM_LEAD` is
  added to `shop.orders.viewAll` for `_MEMBER` parity; no shop route becomes team-scoped.
- **Dependencies** — none added.

Two decisions I have made inside this plan and want confirmed rather than assumed:

1. **`_ADMIN` is the only organisation-wide access level.** `_COORDINATOR` counts only within
   the department that granted it. This is what fixes §1.1, and it is a narrowing.
2. **`_TEAM_LEAD` gets exactly `_MEMBER`'s global permissions**, plus the two `.team` ones.
   It is not a "coordinator minus". If the intent is that a team lead should also see the user
   directory or manage roles within their team, say so now — it is one line in the table plus
   one line in `EXPECTED_POLICY`, and much cheaper before the level is assigned to anyone.
