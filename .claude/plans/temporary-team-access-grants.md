# Plan: temporary, delegable team access grants (#184)

> **Status: implemented and reviewed — PR #194.** The plan below is as written before any code
> existed; it is kept intact because the reasoning is the useful part. What the security review
> then found is recorded at the bottom under "Corrections from security review", rather than by
> editing the plan to look as if it had been right all along.

**Status: proposal. Needs human approval before implementation** — it adds a table and a
migration (`CLAUDE.md` §2.7, §4a) and it changes authorization (`CLAUDE.md` §9).

---

## Goal

When this is done, a board member can lend someone access to a team they do not belong to, for a
bounded period and with a written reason; the coordinator of that person's own team can pass the
same access to one of their own members, once, no further and no longer; and both accesses stop
working by themselves when they expire, with no cron job and no session invalidation. Every guard
already in the workspace — `requireNeiistMember`, `requireTeamWorkspace`, `visibleWorkspaceTeams`,
`canForTeam` — honours the grant without a single call-site change, and the whole thing costs zero
extra queries on the guarded-request path. Who had access, when, granted by whom and why, is a row
that is never deleted.

---

## Context — what was read, and what it means for this

### The pieces that already exist (do not rebuild)

| Thing | Where | Note |
|---|---|---|
| `TEAM_PERMISSION_ROLES`, `TeamPermission` | `src/lib/auth/permissions.ts:195-214` | three permissions today: `team.members.manage`, `team.workspace.view`, `team.content.edit` |
| `TeamAccess = { departmentName, access }` | `src/lib/auth/permissions.ts:217` | constructed **only** by `getUserTeamScopes` in production code; the ~10 literals are all in tests |
| `ORGANISATION_WIDE = [_ADMIN]` | `src/lib/auth/permissions.ts:225` | `canForTeam` and `mayAssignAccess` both short-circuit `true` on it |
| `canForTeam` | `permissions.ts:240-266` | org-wide, else exact `departmentName` match against scopes |
| `accessRank` / `ACCESS_RANK` | `permissions.ts:278-288` | `guest 0 · member 1 · shop_manager 1 · coordinator 2 · admin 3` |
| `mayAssignAccess` | `permissions.ts:302-319` | "at least coordinator **in that department**, and at least the target's rank" |
| `isNeiistMember` | `permissions.ts:336-338` | `scopes.length > 0` |
| `visibleWorkspaceTeams` | `permissions.ts:350-366` | derived from scopes; org-wide sees all |
| `getWorkspaceSession` / `requireNeiistMember` / `requireTeamWorkspace` | `src/utils/permissionUtils.ts:126-180` | scopes are re-read **per request** |
| `getUserTeamScopes` | `src/utils/db/userQueries.ts:577-589` | one `db_query`, one SQL function |
| `neiist.get_user_team_scopes` | `docker/migrations/008_*.sql:38-64`, `docker/schema.sql:3406-3432` | `sql STABLE SECURITY DEFINER`, memberships only |
| `neiist.get_department_role_access` | `008_*.sql:73-87` | precedent for a small `SECURITY DEFINER` helper |
| Custom SQLSTATEs + mapping | `src/utils/db/errorMapper.ts:15-45` | `NEI01`–`NEI07` taken; `throwIfRoleDbError` is the pattern |
| Last-admin guard in SQL | `docker/migrations/004_*.sql:75-119` | precedent: security invariant enforced by `RAISE … USING ERRCODE` |
| Migration runner | `scripts/migrate.mts` | one file = one transaction; append-only; four rules in `CLAUDE.md` §4a |
| Workspace pages | `src/app/workspace/layout.tsx`, `page.tsx`, `[team]/page.tsx` | `[team]/page.tsx:34` already computes `mayEdit` from `team.content.edit` |
| Workspace CSS | `src/styles/pages/Workspace.module.css` | `.section`, `.sectionTitle`, `.memberList`, `.member`, `.empty`, `.card` |
| UI primitives | `src/components/ui/{Button,Input,Select,Modal}.tsx` | |

### Facts that change the shape of the work

1. **Scopes are re-read from the database on every guarded request.** `getWorkspaceSession`
   (`permissionUtils.ts:131-142`) reads the cookie, calls `getUser`, then `getUserTeamScopes`. The
   JWT (`src/utils/authUtils.ts:6-11`) carries `istid`, `roles`, `name`, `email` — **not scopes**.
   So anything that enters `get_user_team_scopes` is picked up on the next request, and anything
   that leaves it stops working on the next request. Expiry needs no invalidation machinery.
2. **`proxy.ts:26` lists `/workspace` but cannot see teams** — it only has JWT global roles. It is
   an optimisation, per its own comment. Grants require no change there.
3. **`_ADMIN` is organisation-wide.** A grant carrying `access = 'admin'` would therefore be a
   *global* grant wearing a team-scoped grant's clothes — `canForTeam` short-circuits on it for
   every team. This is not hypothetical: it is exactly the mechanism of #189.
4. **#189 is still open and was decided the other way in `docker/migrations/009_*.sql:13-15`** —
   `Dev-Team / Coordenador` is still seeded organisation-wide `admin`. **While that holds, this
   feature is a no-op for its own motivating example**: the Dev-Team coordinator already reads
   `/workspace/Eventos` without any grant, and the SQL root-grant check below would classify them
   as "the board". #184 is the mechanism that makes demoting them to `coordinator` acceptable;
   it should land first, then #189 applied, and only then is the feature demonstrable.
5. **The prior sketch (`.claude/plans/neiist-workspace-access-model.md` §5.3) is still right in
   outline and incomplete in three specific ways** now that the workspace has actually shipped:
   it did not consider that unioning grants into scopes also widens `mayAssignAccess` and
   `team.members.manage`; it did not forbid `admin`-level grants; and it did not say what
   "the delegator's own team" means when the grant's department and the delegator's department are
   *different* departments. Those three are the substance of this plan.

---

## Approach

### 1. Where grants enter the pipeline — union them inside `get_user_team_scopes`

**Chosen: union.** `neiist.get_user_team_scopes` returns `memberships ∪ active grants`, in one
SQL function, one round trip.

The argument for it is the failure mode of the alternative. If grants are a second concept the
guards consult separately, then every guard — the three that exist now and every one written for
#129, #130, #131 — must *remember* to consult it. Forgetting produces a caller who is silently
denied today and, the moment someone "fixes" that by adding the second lookup in one place and not
another, a boundary that answers the same question two ways. That is precisely the shape of #97,
#117 and #180: a rule written twice, disagreeing. Unioning at the source means `canForTeam`,
`visibleWorkspaceTeams`, `isNeiistMember`, `requireTeamWorkspace` and the workspace nav are all
correct by construction, with **zero call-site changes**.

The argument against it is real and must be paid for: the union widens *everything* that reads
scopes, including two things it should not.

- `mayAssignAccess` (`permissions.ts:302-319`) computes the caller's rank from scopes. A
  coordinator-level grant on Eventos would let the grantee assign **permanent** Eventos
  memberships — turning a two-week loan into the power to restructure someone else's team.
- `canForTeam(..., "team.members.manage", ...)` would likewise pass.

**The payment: `TeamAccess` gains a required `source: "membership" | "grant"` discriminator**, and

- `mayAssignAccess` filters to `source === "membership"` before ranking. A borrowed authority
  cannot be handed on as a permanent one.
- `canForTeam` accepts a `source === "grant"` scope **only** for permissions in a new explicit
  allowlist `GRANTABLE_TEAM_PERMISSIONS = ["team.workspace.view", "team.content.edit"]`.
  Default-deny: a team permission added later (`team.sensitive.view`, `team.tasks.edit`) is not
  grantable until someone writes it down, and the failure mode of forgetting is "the grantee is
  refused", not "the grantee got more than intended".

`source` is **required**, not optional. Optional would mean a future construction site that omits
it silently gets membership semantics — the wide answer. Required makes the compiler enumerate
every site; today that is `getUserTeamScopes` plus ~10 literals in
`src/lib/auth/teamPermissions.test.ts`, `permissions.test.ts` and `teamScopes.test.ts`.

**Global roles are deliberately untouched.** `getUser().roles` still comes from memberships only,
so a grant never widens the global `can()`, never reaches `/users-management`, and never satisfies
`serverCheckPermission`. A grantee gets the *team's workspace*, not the site's admin area. This
also means `/api/admin/memberships` (which gates on global `members.manage` first,
`route.ts:29`) is unreachable for a grantee regardless — the `mayAssignAccess` fix above is the
second layer, not the only one.

*Rejected: a separate `getUserActiveGrants()` consulted by the guards.* One extra query on the hot
path, and it violates the issue's own acceptance criterion, for the sole benefit of not having to
add a discriminator. *Also rejected: per-page grants* — the issue settles this, and pages belong to
teams.

### 2. Expiry — time-based, plus revocation, and it is automatic

`expires_at TIMESTAMPTZ NOT NULL`, `CHECK (expires_at > granted_at)`. There is no permanent grant;
permanence is what membership is for.

**At the moment of expiry, nothing happens — and that is the design.** Because scopes are re-read
per request (fact 1 above), the first request after `expires_at` simply comes back with fewer
scopes; `requireTeamWorkspace` redirects to `/unauthorized`. No session is invalidated because no
session carries the grant. Three caveats to state in the code comments:

- An **already-rendered** page in the grantee's browser keeps its DOM, and Next's client router
  cache can serve a previously fetched RSC payload for a client-side navigation. Nothing new is
  fetched, and every API route re-checks. This is the same property the rest of the site already
  has for role changes; it is not a new hole, and the fix if it ever matters is `revalidate`, not
  session surgery.
- The **JWT is stale for up to a day** (`authUtils.ts:14`) but carries no scopes, so it cannot
  keep a grant alive.
- **Revocation is also needed**, because "wait for it to expire" is not an answer to "this person
  should not be in there right now". `revoked_at` + `revoked_by_istid` + `revoke_reason`, never
  `DELETE`.

Grants also die when their **parent** dies: a delegated grant is only active while its root grant
is active. Enforced in the **read** path (the effective-scope query joins the parent and checks it)
so it cannot drift, *and* mirrored on write (revoking a root stamps its children in the same
`UPDATE`) so the audit trail reads correctly. The read path is the authority.

### 3. What SQL must enforce, and why not the route

Same reasoning as #146 and #158's last-admin guard, plus one this repo has written down twice:
**~58 of ~64 query functions still `catch { return null }`** (`CLAUDE.md` §8). A guard that lives
in a TypeScript route and reports failure by a falsy return is a guard that can be swallowed. A
`RAISE … USING ERRCODE` cannot be.

All grant creation goes through **`neiist.create_team_access_grant(...)`**, `SECURITY DEFINER`,
which derives the granter's authority **from the database**, never from an argument. The route
passes the caller's istid and nothing else about who they are.

| # | Invariant | Code |
|---|---|---|
| 1 | Root grant (`parent_grant_id IS NULL`) requires the granter to hold a **current membership whose role grants `admin`** — the SQL mirror of `ORGANISATION_WIDE`. The board is the only source of new authority. | `NEI08` |
| 2 | Delegated grant requires: parent exists, parent is **active** (not revoked, not expired), `parent.grantee_istid = granter`, **same `department_name` as the parent**, `access` rank ≤ parent's, `expires_at ≤ parent.expires_at`. | `NEI09` |
| 3 | Depth capped at one: `parent.parent_grant_id IS NULL`. Board → coordinator → member, no further. | `NEI09` |
| 4 | Delegated grantee must be a current member of a department in which the **delegator holds a current membership with `coordinator`-or-higher access**. "His own team", stated exactly. Membership-derived on both sides — a grant cannot bootstrap a delegation chain. | `NEI10` |
| 5 | `access <> 'admin'`. An admin grant is organisation-wide (fact 3) and would be a global grant in disguise. | `NEI11` |
| 6 | `expires_at > NOW()` and `expires_at <= NOW() + INTERVAL '90 days'`. | `NEI11` |
| 7 | `reason` is non-empty after `btrim`. | `NEI11` |
| 8 | Target department must exist, be `active`, and be `department_type = 'team'`. Admin bodies (Direção, MAG) are not lendable. | `NEI11` |
| 9 | Grantee must exist **and hold at least one current membership**. Keeps `isNeiistMember` honest — without it a grant would make a non-member into a workspace member, which is the boundary #183 exists to hold. | `NEI11` |
| 10 | Grantee ≠ granter. | `NEI11` |

Revocation goes through **`neiist.revoke_team_access_grant(actor, grant_id, reason)`**: permitted
to the granter, to anyone organisation-wide, or to the grantee themselves (giving it back).
Anything else raises `NEI12`.

Rank comparison needs **`neiist.access_rank(neiist.user_access_enum) RETURNS INT`**, because the
enum's own ordinal ordering (`admin, coordinator, shop_manager, member` —
`docker/schema.sql:19-24`) is *descending* authority and puts `shop_manager` above `member`, which
`ACCESS_RANK` deliberately does not (`permissions.ts:278-284`). This is a duplicated policy table
in two languages; a test pins them together (see Verification).

### 4. Does `mayAssignAccess` express the delegation rule? No.

It answers "may X hand out a role of rank R **in department D**", where D is both the department
supplying X's authority and the department receiving the role — one department, two uses
(`permissions.ts:310-312`). Delegation involves **two different departments**: the delegator's
authority comes from Dev-Team, the grant is for Eventos. `mayAssignAccess(roles, scopes, "Eventos",
…)` would look for the delegator's rank *in Eventos*, find only the grant-derived scope, and — once
the `source` filter above is in place — return `false`. It is not merely insufficient; it is the
wrong question.

So: **add a sibling, do not stretch `mayAssignAccess`.**

```
mayDelegateGrant(granterScopes, granteeScopes, grantScope, targetAccess) -> boolean
```

where `grantScope` is the delegator's own active grant. It asserts: the delegator holds
`coordinator`-or-higher via **membership** in some department `D_own`; the grantee holds a
membership in that same `D_own`; `accessRank(targetAccess) <= accessRank(grantScope.access)`; and
`targetAccess !== _ADMIN`. `accessRank` is reused unchanged. This is the TypeScript mirror of
invariants 2/4/5 — the API's fast, friendly answer; SQL remains the authority.

### 5. Audit — record now, do not build #160

#160 (permission audit log) is open, separate, and must not be blocked by this. The grants table
**is** the audit record for grants: `granted_by_istid`, `reason`, `granted_at`, `expires_at`,
`revoked_at`, `revoked_by_istid`, `revoke_reason`, and rows are never deleted. Two cheap things
make #160 a pure addition later:

- **Name the actions now** in a comment on the table: `grant.create`, `grant.revoke` — the exact
  `action` strings #160's `permission_audit_log.action` will use, so the log and the table agree
  without a rename.
- **Record `revoked_by_istid` and `revoke_reason` from day one**, so #160 never has to backfill an
  actor it cannot reconstruct.

Nothing else. No log table, no triggers.

### 6. UI

`/workspace/[team]` gains one section, **"Acessos temporários"**, below "Equipa". Same CSS module,
same primitives, Portuguese copy. Three states, decided server-side from the session:

- **Board (organisation-wide)** — sees the active grants for this team and a form to create one:
  person, level (`Membro` / `Coordenador`; `Administrador` absent by construction), expiry date,
  reason. This is the natural home: the board already sees every team page, and the team being lent
  is the object of the action.
- **A grantee whose grant on this team is a root grant** — sees "Delegar a um membro da minha
  equipa", with the picker restricted to members of their own team(s), and expiry defaulted and
  capped to their own `expires_at`.
- **Everyone else** — sees the list read-only if there is one, or nothing at all.

`/workspace/page.tsx` gains a line on the card for a granted team: *"Acesso temporário até
{data}"*, so a live grant is visible to its holder rather than discovered. That is the cheap half
of the "grants become permanent in practice" mitigation.

Component: `src/components/workspace/TeamAccessGrants.tsx` (`'use client'` for the form only, per
`CLAUDE.md` §5). The list itself is rendered by the Server Component page.

### 7. Smallest change that solves it

This is not a small change — it is a table, a replaced hot-path function, a discriminator through
the permission helpers, one API route and one component. It is the smallest change that solves the
*stated* problem, because the requirement is a new kind of authority with an expiry, and there is
nothing in the schema today that can carry one. The parts deliberately **not** enlarged: no new
permission names, no role hierarchy, no per-page grants, no audit-log infrastructure.

---

## Steps

Ordered so the tree compiles between steps.

1. [ ] `docker/migrations/010_team_access_grants.sql` — **new migration.** Create
   `neiist.team_access_grants` (`CREATE TABLE IF NOT EXISTS`) with the columns in the issue plus
   `revoked_by_istid VARCHAR(50) REFERENCES neiist.users(istid)` and `revoke_reason TEXT`; the
   `CHECK (expires_at > granted_at)`; `CHECK (access <> 'admin')`; `CHECK (btrim(reason) <> '')`;
   `CHECK (grantee_istid <> granted_by_istid)`. Partial index
   `idx_team_access_grants_active ON (grantee_istid) WHERE revoked_at IS NULL`, plus
   `(parent_grant_id)` and `(department_name)`. Then `neiist.access_rank`,
   `neiist.create_team_access_grant`, `neiist.revoke_team_access_grant`,
   `neiist.get_team_access_grants(department_name)`, all `SECURITY DEFINER` with explicit
   `GRANT EXECUTE … TO neiist_app_user` (the app role has no table privileges by design —
   `schema.sql:11-16`; learned twice already, see `004_*.sql:38-42`).
   **Also in this file**: `DROP FUNCTION IF EXISTS neiist.get_user_team_scopes(VARCHAR(50));` then
   `CREATE FUNCTION` with the new `source TEXT` column, then re-`GRANT EXECUTE`. The drop is
   unavoidable — `RETURNS TABLE` cannot be widened by `CREATE OR REPLACE`, which is exactly the
   trap `008_*.sql:18-21` documents for `get_user`. It is safe **only** because the runner wraps
   the file in one transaction, so no window exists in which the function lacks its grant; say so
   in the header comment. Backward-compatible with the running previous release (`CLAUDE.md` §4a
   rule 3): the old `getUserTeamScopes` does `SELECT *` and maps three named columns, so an extra
   column is ignored.
2. [ ] `docker/schema.sql` — mirror **all** of step 1 as the end state for fresh databases: the
   table next to `neiist.membership` (~line 121), the functions next to `get_user_team_scopes`
   (~line 3406). Both files, same PR, per `CLAUDE.md` §4a rule 1.
3. [ ] `src/lib/auth/permissions.ts` — add `source: "membership" | "grant"` to `TeamAccess`
   (line 217, **required**); add `GRANTABLE_TEAM_PERMISSIONS`; make `canForTeam` (240-266) ignore
   `source === "grant"` scopes for permissions outside it; make `mayAssignAccess` (302-319) filter
   to `source === "membership"` before ranking; add `mayDelegateGrant`. Document each with the
   reasoning above — this file's comments are load-bearing.
4. [ ] `src/lib/auth/teamPermissions.test.ts`, `permissions.test.ts` — add `source` to the scope
   literals (~10 sites). Compile-only churn; no assertions change.
5. [ ] `src/utils/db/userQueries.ts` — `TeamScope` (562-566) gains `source`; `getUserTeamScopes`
   (577-589) maps the new column. **No new query.** Add `createTeamAccessGrant`,
   `revokeTeamAccessGrant`, `getTeamAccessGrants` — these **must let their errors throw** (no
   `catch { return null }`), because the SQLSTATEs are the security answer; see `CLAUDE.md` §8
   rule 2 and `getUserTeamScopes` itself as the in-file precedent.
6. [ ] `src/utils/db/errorMapper.ts` — add `GRANT_SQLSTATE` `NEI08`–`NEI12` and
   `throwIfGrantDbError`, mapping each to `ForbiddenError` / `ValidationError` / `NotFoundError`
   with Portuguese messages. Every code mapped in the same PR — an unmapped code is echoed
   verbatim with a 500 (`errorMapper.ts:10-13`).
7. [ ] `src/schemas/workspace.ts` — **new file.** `createTeamAccessGrantSchema` (grantee istid,
   departmentName, access restricted to `member | coordinator`, `expiresAt` ISO datetime, reason
   min length, optional `parentGrantId`) and `revokeTeamAccessGrantSchema`. Follow
   `src/schemas/admin.ts`.
8. [ ] `src/app/api/workspace/grants/route.ts` — **new.** `GET` (list for a team), `POST` (create),
   `PATCH` (revoke). Each: `getWorkspaceSession()` → 401 if null; `isNeiistMember` → 403; Zod parse;
   `canForTeam(..., "team.workspace.view", dept)` as the friendly pre-check; then the SQL function,
   whose refusal is authoritative; `throwIfGrantDbError` + `handleApiError`. Do not hand-roll
   status codes (`CLAUDE.md` §5).
9. [ ] `src/components/workspace/TeamAccessGrants.tsx` + styles in
   `src/styles/pages/Workspace.module.css` — the section described in Approach §6, `sonner` toasts
   for success/failure, `ui/` primitives, Portuguese copy.
10. [ ] `src/app/workspace/[team]/page.tsx` — render the section after "Equipa" (~line 62), passing
    the caller's capability flags and the team's active grants, fetched **after** the existing
    `requireTeamWorkspace` guard on line 23. Never before.
11. [ ] `src/app/workspace/page.tsx` — show "Acesso temporário até {data}" on a card whose scope has
    `source === "grant"` (~line 48).
12. [ ] Tests — see Verification.
13. [ ] `docs/ai-workflow/decision-log.md` — record: grants unioned into scopes rather than consulted
    separately; the `source` discriminator and the grantable allowlist; `admin`-level grants
    forbidden; grants restricted to `department_type = 'team'`; the 90-day cap; the
    coordinator-or-higher floor for delegation. `docs/ai-workflow/HANDOFF.md` §4 table — mark #184.

---

## Assumptions resolved in-plan (say so if any is wrong)

- **Maximum grant length: 90 days**, default offered in the UI: **14 days**. Neither is in the
  issue. The cap is what stops a "temporary" grant from being permanent by another name.
- **A delegator must hold `coordinator`-or-higher in their own team**, not merely membership. The
  example is a coordinator, and it matches `mayAssignAccess`'s existing "at least coordinator"
  floor (`permissions.ts:316-318`).
- **A delegated grant is for the parent's department only.** The issue does not say it; it follows
  from "delegate the access he was given", and without it a delegation could target a third team.
- **Grants apply to `department_type = 'team'` only.** The workspace's teams are what the
  requirement talks about; admin bodies hold the board's own material.
- **Grants may not carry `admin`.** Derived from fact 3, not stated in the issue.

---

## Out of scope

- **#160, the audit log.** Only the two forward-compatibility measures in Approach §5.
- **#159, per-member permission overrides.** The issue says #159 should later reuse this table;
  this plan does not build or pre-shape it.
- **#189.** It is data, decided through the roles screen, and it is a *prerequisite for
  demonstrating* this feature, not part of it. Do not change `valid_department_roles` here.
- **Per-page grants**, and any new `TeamPermission` names.
- **Email or notification on grant/expiry.** Worth having; not asked for; and it must not go
  anywhere near `withTransaction` (`CLAUDE.md` §8 rule 3).
- **A scheduled job to purge expired grants.** They are inert and they are the record.
- **Any change to `proxy.ts`, global roles, or `getUser`.**

---

## Risks, ranked

1. **The union widens a guard nobody thought about.** The whole feature is "make more scopes
   appear". Everything downstream of `getUserTeamScopes` is affected at once. Mitigated by the
   `source` discriminator, the grantable allowlist (default-deny), and the fact that global roles
   are untouched — but the reviewer's job on this PR is to enumerate every reader of scopes and
   say what a grant-derived one does there. Today that is `canForTeam`, `mayAssignAccess`,
   `isNeiistMember`, `visibleWorkspaceTeams`, `/workspace/*`, `/api/admin/memberships:42,82`,
   `/api/user/update/[userId]:41`.
2. **`DROP FUNCTION` on the hot path.** `get_user_team_scopes` runs for every workspace request. If
   the migration's `GRANT EXECUTE` were ever separated from the `DROP`/`CREATE`, every guarded page
   would 500 with "permission denied". Mitigated by them being in one file = one transaction, and
   by a post-migration smoke check that a plain member can still open their team.
3. **An `admin`-level grant, if invariant 5 were dropped, is a silent organisation-wide grant** —
   `canForTeam` short-circuits before it ever looks at the department. This is the single most
   dangerous line in the feature; it is a `CHECK` constraint *and* a function guard *and* a Zod
   enum for that reason.
4. **Delegation chains that outlive their parent.** A child grant read without checking its parent's
   liveness survives the root's revocation. Mitigated by the join in the effective-scope query,
   which is the read path everything uses, and tested by revoking a root and asserting the child
   goes inert on the next read.
5. **Grants become permanent in practice** — extended rather than allowed to lapse. Mitigated by the
   90-day cap, the visible "até {data}" on the workspace card, and the board's list of active
   grants sorted oldest-first.
6. **Production's schema is unmeasured (#152).** This migration creates a new table (safe) but
   `DROP`s and re-`CREATE`s an existing function. Run `yarn db:schema-diff` before applying
   anywhere real, exactly as `008_*.sql:3` says.
7. **Two copies of the rank table** (`ACCESS_RANK` in TypeScript, `neiist.access_rank` in SQL). They
   can drift. Mitigated by a DB-backed test that asserts they agree for every enum value.

---

## Verification

`yarn type:check` and `yarn lint` are the floor, not the evidence.

**Mutation-tested, as the issue requires** — for each invariant: remove it, show the named test
fails, restore. New DB-backed suite `src/utils/db/teamAccessGrants.test.ts`, in the style of
`src/utils/db/teamScopes.test.ts` (owner `pg.Client`, seeded fixtures, cleanup in `afterAll`):

| Invariant | Test |
|---|---|
| 1 | a coordinator (non-admin) creating a root grant raises `NEI08` |
| 2 | delegated grant with `expires_at` after the parent's raises `NEI09`; with higher `access` raises `NEI09`; for a different department raises `NEI09` |
| 2 | delegating from a grant that is revoked, or expired, raises `NEI09` |
| 3 | delegating from a **delegated** grant raises `NEI09` (depth cap) |
| 4 | delegating to someone who is not in the delegator's own team raises `NEI10` |
| 5 | `access = 'admin'` is refused by the `CHECK` **and** by the function |
| 6 | `expires_at` in the past, and beyond 90 days, are refused |
| 8 | a grant on `Direção` (admin body) is refused |
| 9 | a grant to a user with no membership is refused |
| revoke | non-granter, non-admin, non-grantee revoking raises `NEI12` |
| inertness | expired grant → not in `getUserTeamScopes`; revoked grant → not in it |
| cascade | revoking the root → the child disappears from the child's scopes on the next read |
| shape | a live grant appears with `source: "grant"`; a membership with `source: "membership"` |
| rank parity | `neiist.access_rank(v)` equals `accessRank(mapRoleToUserRole(v))` for every enum value |

Pure-logic additions to `src/lib/auth/teamPermissions.test.ts`:

- a grant-derived scope grants `team.workspace.view` and `team.content.edit`, and **not**
  `team.members.manage`;
- `mayAssignAccess` returns `false` for a caller whose only coordinator-level scope is a grant —
  the "borrowed authority cannot be made permanent" case;
- `mayDelegateGrant` refuses a grantee outside the delegator's own team, refuses a higher access,
  refuses `_ADMIN`.

**Manual reproduction of the requirement, end to end** (needs #189 applied first, or a temporary
local demotion of `Dev-Team / Coordenador` to `coordinator`):

1. As Dev-Team coordinator, open `/workspace` → Eventos is **not** listed; `/workspace/Eventos`
   redirects to `/unauthorized`.
2. As a Direção `Presidente`, open `/workspace/Eventos` → grant the coordinator `Membro` for 7 days
   with a reason.
3. Reload as the coordinator → Eventos appears with "Acesso temporário até …"; the page opens.
   Confirm `/users-management` and "adicionar membro" on Eventos remain **refused**.
4. As the coordinator, delegate to a Dev-Team member with an expiry inside the parent's → that
   member gets in. Try to delegate to someone outside Dev-Team → refused. Try to delegate further
   from the child → refused.
5. `UPDATE neiist.team_access_grants SET expires_at = NOW() - INTERVAL '1 minute'` on the root →
   reload → **both** the coordinator and the delegate are out on the next request, no logout.
6. Revoke instead of expiring → same result, and the row still reads back with actor and reason.

---

## Approvals needed

- **Schema change** — new table `neiist.team_access_grants`, new functions, and a `DROP`/`CREATE`
  of `neiist.get_user_team_scopes`, in `docker/migrations/010_*` + `docker/schema.sql`.
  `CLAUDE.md` §2.7 and §9.
- **Authorization change** — this alters how effective access is computed for every workspace
  guard. `CLAUDE.md` §2.7 and §9.
- **Product decisions** listed under "Assumptions resolved in-plan": the 90-day cap and 14-day
  default, the coordinator-or-higher delegation floor, teams-only, no `admin` grants.
- **Sequencing**: confirm that **#189 is applied before or alongside this**, otherwise the feature
  cannot be demonstrated for the case that motivated it (fact 4).
- No new dependencies. No payment or PII surface touched beyond the team rosters the workspace
  already shows.

---

## Noticed but out of scope

- `src/app/api/admin/memberships/route.ts:42` and `:82` call `getUserTeamScopes` **twice** in one
  POST — the second with a comment explaining the choice. Harmless, and one more scope read once
  grants land. Board item, not this PR.
- `src/app/workspace/[team]/page.tsx:45` renders `myAccess ? ROLE_LABELS[myAccess] : "Direção"` —
  the fallback assumes the only scope-less viewer is the board. It stays true after this change
  (a grantee has a scope), but it is an assumption written as a string literal.
- `src/utils/db/userQueries.ts:517` `getAllMemberships` still `catch { return [] }` and is called
  by the team page; a failed read renders an **empty team**, indistinguishable from a real one.

---

## Corrections from security review

The plan was implemented as written. Review then found two **High** issues in it, both real, both
now fixed with a mutation-proven test each. Recorded here because each was a gap in the *design*,
not a slip in the coding.

**1. Invariant 9 was specified as an INSERT-time check, and that is not sufficient.**
"The grantee must hold a current membership" was enforced only when the grant was created.
Offboarding happens later: end someone's membership and the grant branch of `get_user_team_scopes`
still returned a scope on its own, so `isNeiistMember` — `scopes.length > 0` — stayed **true for an
ex-member**, handing them another team's internal workspace for up to 90 more days with nothing in
the admin UI showing why. The predicate now also runs on the **read path**, which is the only place
that can react to a membership ending — an event the grants table never sees.

**2. Invariant 1 said "the board", but `access = 'admin'` does not mean "the board".**
`Dev-Team / Coordenador` is deliberately seeded `admin` (#189), so one team's coordinator satisfied
"only the board may create new authority" and could mint 90-day grants on every other team, revoke
anyone's, and seed a delegation chain into a team they have no relationship with. The check now
requires the granting membership to be in a department whose `department_type` is not `'team'`.

Also corrected, all from the same review:

| finding | fix |
|---|---|
| POST was a membership oracle — shape validated before authority, so any logged-in student could read "is X a member" off the status code | the route refuses non-members before the database sees anything |
| a delegated grant could outlive its parent's revocation under READ COMMITTED | the parent read takes `FOR SHARE`, serialising against the revoke's `FOR UPDATE` |
| `is_grant_active` declared `IMMUTABLE` while reading `NOW()` | `STABLE` — the one predicate the whole expiry model rests on must not be constant-folded |
| `access_rank` had no `ELSE`, so a future enum value makes the delegation ceiling `NULL > x`, i.e. false | `ELSE 0`, so it fails closed |
| NEI01 unmapped: a nonexistent grant id returned 500 with the raw message while a forbidden one returned 403 | mapped to 404; grant-id enumeration closed |
| the receiving team's own coordinator could not revoke an outsider on their own team | added to the SQL clause, and the Revogar button now mirrors it |
| `mayDelegateGrant` was exported, tested, and never called | it is the route's pre-check now, so the helper is live rather than rotting |

### One mutation that mattered

Removing the coordinator-or-higher condition from the SQL delegation check **failed no test**,
because every other delegation case in the suite also differed by department. The case that
isolates it — a plain member of a team delegating to another member of that *same* team — did not
exist. It does now.

### Still open, deliberately

- No `SET search_path` on the new `SECURITY DEFINER` functions. Not a regression (all 76 existing
  ones omit it) but worth a repo-wide change.
- No cap on how many children one root grant may spawn.
- Grant reasons are readable by everyone who can open the team's workspace. The placeholder now
  says so rather than hiding it.

