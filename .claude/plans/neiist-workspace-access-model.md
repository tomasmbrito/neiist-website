# Plan: the NEIIST members' workspace and its access model

**Supersedes the access-model half of `.claude/plans/phase-0-team-scoping.md`**, which planned
per-team scoping for the *existing* admin screens. The requirements below are larger: a
members-only workspace whose every page is scoped by team, with delegation and expiry.

**Status: proposal.** Every claim marked *verified* was checked against the running database.

---

## 1. The requirements, restated

From Tomás, 2026-08-22:

1. Team membership decides page access. Choose a team's members → they get that team's pages.
2. **The workspace is for NEIIST members only.** Someone who logs in but is not a member must
   not see any of it. *"It would be a big security problem."*
3. A Visuais member sees Visuais pages; a C&Q member sees C&Q pages. Several teams → the union.
4. A **coordinator** of a team has more power over that team's pages than its members.
   Coordinators are set by the board, and **a team may have more than one**.
5. **Board members** have full access everywhere, more than coordinators, administer permissions,
   and reach sensitive material.
6. **Controlled, temporary Dev-Team access.** The board can grant a Dev-Team person access to
   another team's page to fix a bug, and the Dev-Team coordinator can pass that to one of their
   own members. Temporary.
7. Membership and coordinator changes show on the public teams page.
8. Frontend and backend excellent, consistent with the rest of the site.

---

## 2. What already exists — verified, do not rebuild

| Requirement | Already there |
|---|---|
| Teams | `neiist.departments` where `department_type='team'`. All seven seeded and active. `neiist.teams` **also already exists** as a detail table. |
| Membership with history | `neiist.membership(user_istid, department_name, role_name, from_date, to_date)`. |
| Role → access level | `neiist.valid_department_roles(department_name, role_name, access)`. |
| **Several coordinators per team** | Verified: two users hold `Coordenador` of Visuais simultaneously. The PK is `(user_istid, department_name, role_name)`, so this needs **no schema change**. |
| Per-team access resolution | `neiist.get_user_team_scopes` + `canForTeam` (#180, on `fix/team-scoped-authorization`). |
| Editing membership on the site | `/users-management`, `/team-management`, `/api/admin/memberships`. |
| Permission catalogue | `src/lib/auth/permissions.ts` (#156), with the equivalence test that makes a policy change deliberate. |

**Requirement 4's "more than one coordinator" is already satisfied.** Requirement 1 and 3 are
satisfied at the *data* layer; what is missing is the workspace that consumes it.

---

## 3. The security boundary that does not exist yet

> A logged-in non-member must see nothing.

This is **not** the same question as "is authenticated", and today nothing asks it. Verified:

```
Técnico student, no team   roles={}  teams={}  team scopes: 0 rows
External Google user       roles={}            team scopes: 0 rows
```

Both currently resolve to `_GUEST`, and `_GUEST` can already reach `/profile`, `/my-orders`,
`/shop/*` — correctly, those are for customers. The workspace must ask a stricter question:

```ts
isNeiistMember(scopes) === scopes.length > 0
```

**One gate, checked server-side before any workspace data is fetched**, in the same shape as
#127: authorize, *then* load. Filtering after loading puts members' data in a non-member's
response and trusts the client not to render it.

`ext_` users can never satisfy it: an external account has no membership row, and nothing in the
signup path creates one.

---

## 4. A discrepancy to settle before building — the board is not fully `admin`

Requirement 5 says board members have full access. The seeded data disagrees:

```
Direção: Presidente=admin  Vice-Presidente=admin  Vogal=admin
         Diretora de Atividades (Alameda)=coordinator
         Diretor de Atividades (Taguspark)=coordinator
         Diretora SINFO=member        Tesoureiro=member
```

So **the treasurer would be locked out of the finance pages**, and the SINFO director out of
everything. That is a data question, not a code question, and it must be answered before
"board" means anything in code.

Two options:

- **(a) Make all Direção roles `admin`.** Simple, matches "board members have full access".
  Also gives the treasurer permission administration, which is more than requirement 5 asks.
- **(b) Introduce a `board` access level** distinct from `admin`: full read/write across teams
  and sensitive material, but *not* necessarily permission administration.

**Recommendation: (a) for now**, because it matches the stated intent and the núcleo is small
enough that the distinction between "board" and "site administrator" is not yet real. Revisit if
the board grows or if someone wants a non-technical treasurer without permission powers.

**This needs Tomás's answer.** It is one `UPDATE` either way; getting it wrong silently denies
the treasurer.

---

## 5. The access model

### 5.1 Principals

```
non-member         logged in, no active membership          NOTHING in the workspace
member of T        access='member' in T                     T's pages, read + participate
coordinator of T   access='coordinator' in T                T's pages, manage
board              organisation-wide access                 everything, + permissions, + sensitive
delegate           a temporary grant (§5.3)                 exactly what the grant says, until it expires
```

Roles remain a **flat set**, per `hasRequiredRole`. `canForTeam` already encodes "organisation-wide
qualifies anywhere; otherwise you must hold the level *in that team*".

### 5.2 Permissions are named, never inferred from a role at the call site

Extending `TEAM_PERMISSION_ROLES`:

```
team.workspace.view      member, coordinator      see the team's workspace
team.content.edit        coordinator              edit the team's pages
team.members.manage      coordinator              add/remove members (already exists)
team.sensitive.view      —                        board only; never granted by team membership
```

`team.sensitive.view` deliberately has **no** team-level grant: sensitive material is a board
concern, so it cannot be reached by becoming a coordinator of a team.

### 5.3 Temporary delegated access — requirement 6

The interesting requirement, and the one most easily built insecurely.

```sql
neiist.team_access_grants (
  id                BIGSERIAL PRIMARY KEY,
  grantee_istid     VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  department_name   VARCHAR(30) NOT NULL REFERENCES neiist.departments(name),
  access            neiist.user_access_enum NOT NULL,
  granted_by_istid  VARCHAR(50) NOT NULL REFERENCES neiist.users(istid),
  parent_grant_id   BIGINT REFERENCES neiist.team_access_grants(id),
  reason            TEXT NOT NULL,
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  CONSTRAINT grant_expires_after_grant CHECK (expires_at > granted_at)
);
```

**Invariants, enforced in SQL rather than in the route** — the route is not the only caller, and
this is the part where a mistake hands someone another team's data:

1. A **root** grant (`parent_grant_id IS NULL`) may be created only by a caller with
   organisation-wide access. The board is the only source of new authority.
2. A **delegated** grant requires: an active parent; the delegator is the parent's grantee; the
   grantee is a **current member of the delegator's own team**; `expires_at <= parent.expires_at`;
   and `access` no higher than the parent's.
3. **Depth is capped at one.** The parent must itself be a root grant. Board → Dev-Team
   coordinator → Dev-Team member, and no further. Longer chains stop being auditable.
4. `expires_at` is **required**. There is no permanent grant; permanence is what membership is
   for.
5. Revocation is `revoked_at`, never `DELETE` — the record of who had access and when is the
   point.

Effective scopes become `permanent memberships ∪ active grants`, resolved in one query so the hot
path stays one round trip.

**Why not reuse #159 (per-member permission overrides):** #159 is global and permanent;
this is team-scoped, time-boxed and delegable. When #159 lands they should share this table
rather than adding a second.

### 5.4 What this does *not* do

No per-*page* grants. A grant is scoped to a **team**, and pages belong to teams. Per-page
grants multiply the surface for no gain that requirement 6 actually asks for — the example given
was "look at the Eventos team calendar", which is team-scoped.

---

## 6. The workspace itself

```
/workspace                    lands here; lists only the teams you belong to
/workspace/[team]             that team's hub
/workspace/[team]/…           pages added by later phases (#129 events, #130 tasks, …)
```

- A Server Component layout at `/workspace` performs **both** checks: `isNeiistMember`, then
  `canForTeam("team.workspace.view", team)` for the specific team. Non-members get
  `/unauthorized`, exactly as `requireRoles` does today.
- `proxy.ts` gains `/workspace` as a protected prefix — an optimisation, **not** the boundary,
  per `CLAUDE.md` §8. Note the trap that caught `/shop/manage` (#97) and `/shop/pos` (#117): a
  privileged path nested under a public prefix falls through unless a rule claims it.
- Styling reuses the existing CSS-module conventions and the `ui/` primitives. No new design
  system: the workspace should look like the rest of the site, because it is the rest of the site.

### 6.1 The public teams page — requirement 7

`/about-us` already renders memberships grouped by department and role, and already reflects
changes because it reads `get_all_memberships()` live. **Requirement 7 is therefore mostly
satisfied**; what it needs is for coordinators to be visibly distinguished, which is a rendering
change, not a data one.

---

## 7. Delivery order

| # | Step | Why here |
|---|---|---|
| 1 | **#180 + #181** (done, awaiting review) | Everything below builds on `canForTeam`; shipping the escalation fix first also stops a live bug. |
| 2 | Settle §4 (which Direção roles are `admin`) | One `UPDATE`, but "board" is meaningless in code until it is answered. |
| 3 | `isNeiistMember` + the `/workspace` shell with one real page | The security boundary, provable end to end, before any content exists to leak. |
| 4 | `team_access_grants` + effective-scope resolution | Requirement 6. Independent of what the pages contain. |
| 5 | Admin UI for grants and coordinators | Requirement 4 and 6's operational half. |
| 6 | Coordinator badge on `/about-us` | Requirement 7. |
| 7 | Phase 1+ content (#129 events, #130 tasks …) | Now has a home and a guard. |

Steps 3 and 4 are where the security is; 5–7 are surface.

---

## 8. Testing

Per this repo's practice, an authorization guard is **proven by mutation** — break it
deliberately and show the test fails. Non-negotiable cases:

- A logged-in non-member receives 403/redirect from every workspace route, and **nothing in the
  response body**.
- An `ext_` Google user is a non-member.
- A Visuais member is refused C&Q, and vice versa; a member of both gets both.
- A coordinator of A is refused coordinator powers in B (the #180 shape, re-asserted per page).
- An expired grant is inert; a revoked grant is inert.
- A delegated grant cannot outlive its parent, cannot exceed its access, and cannot be delegated
  again.
- A non-board caller cannot create a root grant.

---

## 9. Risks

**R1 — the workspace leaks by omission.** The failure mode is a new page added later without the
guard. Mitigation: the check lives in the `/workspace` **layout**, so a new page inherits it, and
a page that needs a *different* team asks explicitly.

**R2 — grants become permanent in practice.** People extend rather than let expire. Mitigation:
`expires_at` required, a default measured in days, and the admin screen listing active grants
oldest-first so they are visible.

**R3 — `get_user_team_scopes` on the hot path.** It runs per guarded request. It is indexed
(`idx_membership_active`, `idx_membership_department_role`) and returns a handful of rows.
Adding grants must not turn it into a second query — resolve both in one.

**R4 — the board discrepancy (§4) ships unnoticed** and the treasurer is locked out. Mitigation:
answer it in step 2, before the workspace exists.

**R5 — deploying any of this against an unmeasured production schema.** #152 is still unanswered.
`yarn db:schema-diff` exists and takes one command.
