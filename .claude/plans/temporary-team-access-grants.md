# Temporary, delegable team access grants (#184)

**Status: implemented, PR pending.** This file was reconstructed after the original was lost;
it records the decisions, which is the part future sessions need.

## Goal

The board lends someone access to a team they are not in. A team's coordinator can pass their own
loan on to one of their own members. Both expire.

> "the members from the dev team should also have some kind of controlled access by the board …
> we should be able to give temporary permission to him to have access to this page, and he should
> also be able to give access to a member of his team"

## The central decision: union grants into `get_user_team_scopes`

Grants are returned by the same function memberships come from, so `canForTeam`,
`visibleWorkspaceTeams`, `isNeiistMember`, `requireTeamWorkspace` and every guard written for
#129/#130/#131 honour them **by construction**, with zero call-site changes.

*Rejected: a separate `getUserActiveGrants()` the guards consult.* Every guard would have to
remember it. Forgetting produces a caller silently denied, and the eventual "fix" adds the second
lookup in one place and not another — a rule written twice, disagreeing. That is the exact shape
of #97, #117 and #180.

**The price, which is most of the work:** the union widens everything that reads scopes, including
two things it must not.

| paid with | why |
|---|---|
| required `source: "membership" \| "grant"` on `TeamAccess` | optional would give a future construction site membership semantics by default — the *wide* answer. Required made the compiler enumerate all 14 sites. |
| `GRANTABLE_TEAM_PERMISSIONS` allowlist in `canForTeam` | default-deny. A team permission added later is not grantable until written down, so forgetting refuses the grantee rather than over-serving them. |
| `mayAssignAccess` filters to `source === "membership"` | otherwise a two-week loan becomes the power to create memberships that outlive it. |
| `mayDelegateGrant`, a new sibling | delegation spans **two** departments (authority from Divulgação, grant for Fotografia); `mayAssignAccess` models one department used twice, so it is the wrong question, not merely insufficient. |

**Global roles are untouched.** `getUser().roles` still derives from memberships only, so a grant
never widens `can()`, never reaches `/users-management`, never satisfies `serverCheckPermission`.

## Invariants, all in SQL

Enforced in `neiist.create_team_access_grant` / `revoke_team_access_grant`, not the route, because
~58 of ~64 query functions still `catch { return null }` — a guard reporting failure by a falsy
return can be swallowed. The granter's authority is derived **inside** the function from the
database; the route passes an istid and never asserts what that person is.

| # | Invariant | Code |
|---|---|---|
| 1 | Root grant requires an `admin`-granting membership **in a non-team department**. | NEI08 |
| 2 | Delegation: parent exists, is live, is yours, same department, rank ≤ parent, expiry ≤ parent. | NEI09 |
| 3 | Depth capped at one. | NEI09 |
| 4 | Delegatee must be a member of a department the delegator coordinates **by membership**. | NEI10 |
| 5 | Never `admin` — it is `ORGANISATION_WIDE`, so it would be a global grant in disguise. | NEI11 |
| 6 | Expiry in the future, at most 90 days out. | NEI11 |
| 7 | Non-blank reason. | NEI11 |
| 8 | Target must be an active department with `department_type = 'team'`. | NEI11 |
| 9 | Grantee must hold a current membership — **checked on INSERT *and* on read**. | NEI11 |
| 10 | Grantee ≠ granter. | NEI11 |

## Decisions taken with the product owner (2026-08-22)

- **90-day maximum, 14-day default.** The cap is what stops "temporary" being permanent.
- **Teams only.** Admin bodies hold the board's own material.
- **`coordinator`-or-higher to delegate**, matching `mayAssignAccess`'s existing floor.

## Corrections from security review

Both HIGH findings were real and are fixed, with a mutation-proven test each:

1. **Invariant 9 was INSERT-time only**, so a grant kept working after the grantee left the
   núcleo — `isNeiistMember` is `scopes.length > 0`, so an ex-member kept another team's workspace
   for up to 90 days. Now also enforced on the read path, because that is the only place that can
   react to a membership ending.
2. **"Only the board" was false against the seed.** The check was `access = 'admin'`, and
   `Dev-Team / Coordenador` is deliberately `admin` (#189) — so one team's coordinator could mint
   grants on every other team. Now requires `department_type <> 'team'` on the granting membership.

Also fixed: a membership oracle in the route (authorization now precedes the database), a
concurrency window letting a delegated grant outlive its parent's revocation (`FOR SHARE`),
`is_grant_active` declared IMMUTABLE while reading `NOW()`, `access_rank` failing open on an
unmapped enum value, NEI01 returning 500, and the receiving team's coordinator being unable to
revoke an outsider on their own team.

## Out of scope

#160 (audit log — the table is the record and the action names are reserved), #159 (per-member
overrides), per-page grants, notifications, and any scheduled purge (expired rows are inert and
they are the record).
