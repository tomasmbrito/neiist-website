# NEIIST Website — Handoff

**Written 2026-08-22.** Read this after `CLAUDE.md`. It exists so a new session can pick the work
up without re-deriving the last few weeks from git log.

`CLAUDE.md` is still the authority on rules (fork topology, gates, what needs human approval).
This file is the authority on **where the work currently stands and what to do next.**

---

## 1. What this project is, in one paragraph

The web platform of NEIIST, the Computer Science student association at Instituto Superior
Técnico. It is a **fork** (`tomasmbrito/neiist-website`) of the organisation's repo
(`neiist-dev/neiist-website`), and it has diverged deliberately — the fork carries a permission
catalogue, domain errors, Zod validation, transactions and a test suite that upstream does not
have. It serves real students, takes **real money** through SumUp, and holds **real personal
data**. Treat it as production software.

**Never push to `upstream`.** Work on a branch off `origin/main`, open a PR on the fork, and
stop there — Tomás merges. That division is deliberate and has held for ~90 commits.

---

## 2. The current big idea: move NEIIST off Notion

NEIIST runs its actual operations in Notion — team pages, events, tasks, requerimentos (a
cross-team approval workflow), recruitment, finance. It is an **operations database with a
workflow**, not a wiki. Epic **#126** is bringing it into the website, and epic **#182** is the
access model that makes that safe.

Read [`notion-to-website-plan.md`](notion-to-website-plan.md) before touching that area, and
[`.claude/plans/neiist-workspace-access-model.md`](../../.claude/plans/neiist-workspace-access-model.md)
for the workspace design.

### The access requirements, as stated by the product owner

These are quoted closely because they are the spec:

1. **Members only.** "This is exclusive for NEIIST members — the other people who login to the
   website but are not NEIIST members should not be able to see these pages, **it would be a big
   security problem**." A Técnico student who logged in to buy a t-shirt is *not* a member.
2. **Team membership decides page access.** "A member of the team Visuais should only have access
   to the pages related to the Visuais team."
3. **Several teams → the union** of their pages.
4. **Coordinators outrank members, within their own team only.** Multiple coordinators per team
   must be possible.
5. **Board members have full access** and set everyone else's permissions.
6. **Dev-Team gets temporary, controlled access**, granted by the board, and the Dev-Team
   coordinator can delegate it to one of their own members. (#184 — not built yet.)
7. Changes reflect on the public teams page. Same visual style as the rest of the site.

### The Direção nuance — important, and counter-intuitive

Direção is **not uniform**, and this was confirmed explicitly:

| Role | Access today | Why |
|---|---|---|
| Presidente, Vice-Presidente, Vogal | `admin` | full access, and they set everyone else's |
| Diretor de Atividades (TagusPark, Alameda) | `coordinator` | |
| **Diretor da SINFO** | `member` | heads a *secção autónoma* — "it's like she isn't even part of NEIIST" |
| **Tesoureiro** | `member` | "treated like he isn't even a member of NEIIST almost (he just has the role)" |

**The last two are intended, not a bug.** An earlier session flagged "the treasurer would be
locked out of the finance pages" as a defect; it is not. Do not "fix" it.

A **Marketing director** is expected soon and will probably need board-level access. That is why
access is **data**, per (department, role) in `neiist.valid_department_roles`, editable through
the API — and must never become a hardcoded list of role names. This is recorded as the #185
decision in [`decision-log.md`](decision-log.md).

---

## 3. What has been built (recent, and load-bearing)

Roughly 90 commits ahead of upstream. The parts a new session most needs to know:

### Authorization — now three concepts, do not confuse them

1. **Global permissions** — `src/lib/auth/permissions.ts`. `PERMISSION_ROLES` is the single
   source of truth; `ROLE_PERMISSIONS` is *derived* from it. Roles are a **flat set** and
   `hasRequiredRole` is an intersection — **there is no hierarchy**, `_ADMIN` does not "contain"
   `_MEMBER`. Use `can()` / `serverCheckPermission()` / `requirePermission()`.
2. **Team-scoped permissions** — `TEAM_PERMISSION_ROLES` + `canForTeam()`, added in #180. A
   *deliberately separate type*, so that asking a team question through the global `can()` fails
   to compile. Being a coordinator of one team must never carry into another.
3. **Membership** — `isNeiistMember(scopes)`, i.e. `scopes.length > 0`. This is **not** "is
   logged in", and that distinction is the entire workspace boundary.

Two layers everywhere: `src/proxy.ts` (middleware) is an **optimisation**, the page/route guard
is the **boundary**. Never rely on middleware alone. Note the trap that caught `/shop/manage`
(#97) and `/shop/pos` (#117): **a path claimed by no rule falls through to the public match**, so
every new protected prefix must be added to `proxy.ts` explicitly.

### The workspace (#183 — PR #188, awaiting merge)

`/workspace` and `/workspace/[team]`. Three layers: `proxy.ts` claims the prefix, the **layout**
guards the segment (so a new page is protected when created, not when someone remembers), and
**each page** re-guards (layouts do not re-run on client navigation, and the layout cannot tell
Visuais from Dev-Team). The guard runs **before any data is fetched**.

Verified in a browser across four sessions: anonymous → login; logged-in non-member →
`/unauthorized` **with no team names in the response**; Dev-Team member sees Dev-Team only;
Visuais member sees Visuais only; board admin sees all. Encoding, case, traversal and
trailing-space evasions all refused.

### Data layer

`src/utils/db/*` — five modules; `src/utils/dbUtils.ts` **no longer exists**, do not recreate it.
`db_query` and `withTransaction` live in `dbClient.ts`; nothing else touches the `pg` pool.

**Transactions exist but almost nothing uses them.** Three rules: thread the `Querier` `q` into
every query inside; a function used with `q` must let errors **throw** (only ~6 of ~64 do — the
rest `catch { return null }`, which inside a transaction silently discards writes); and **no
email/SumUp/network calls inside** the callback.

`neiist_app_user` has **no table privileges** by design — a new function touching tables directly
needs `SECURITY DEFINER`, or it fails with `aclcheck_error`.

### Migrations (#148) — this did not exist before

`scripts/migrate.mts` runs `docker/migrations/NNN_*.sql` in order, each in one transaction with
its `neiist.schema_migrations` row, under a session advisory lock, refusing checksum drift.
**Before this, there was no migration path at all** — not in the fork, not upstream. Schema
changes still need human approval (`CLAUDE.md` §2.7).

`yarn db:schema-diff "<url>"` (#152 tooling) compares a target database against `docker/schema.sql`
in a throwaway container. **It only ever reads the target.**

### Tests — they exist now

**Vitest, 210 tests, wired into CI.** There was no runner at all before. The standard for anything
touching concurrency or security is **mutation testing**: break the guard, prove the test fails,
restore. `Promise.all` is *not* a concurrency test — an early attempt passed against a function
with both guards removed. Hold a transaction open on a dedicated `pg.Client` instead.

DB-backed suites need Postgres; pure-logic suites do not.

---

## 3a. Notion → website: where it stands

The one table to look at. **"Foundation"** is the access model everything else needs; **"Content"**
is the actual Notion material, none of which has moved yet.

### Foundation — the access model (epic #182)

| | What | State |
|---|---|---|
| #180 | Team-scoped authorization (`canForTeam`) — a coordinator of one team is not one everywhere | ✅ merged |
| #181 | A member added today can be removed today | ✅ merged |
| #183 | The members-only boundary and `/workspace` shell | ✅ merged |
| #185 | Decision: board access is per-role **data**, not a hardcoded list | ✅ decided |
| #158 | Roles UI — change a role's access level without a deploy | ✅ merged |
| #189 | Mesa da Assembleia Geral is not organisation-wide admin | ✅ merged |
| #187 | Profile photo write hardened (shared with product uploads) | ✅ merged (half) |
| #184 | Temporary, delegable team access grants | ✅ merged |
| #193 | P0 — any coordinator could promote their own role to `admin` | ✅ merged |

**The access model is complete and epic #182 is closed.** Everything after this builds on it
rather than extending it. Four things to know before you touch it:

- **Membership is `scopes.length > 0`, not "is logged in".** A Técnico student who bought a
  t-shirt and an external Google account both authenticate fine and both hold zero scopes.
- **`canForTeam` is a separate type from `can()` on purpose**, so a team question cannot be
  answered globally — that mistake was #180.
- **Board access is data**, per (department, role), editable without a deploy (#185).
- **Grants union into `get_user_team_scopes`**, so every guard honours them by construction. The
  price is the required `source` discriminator and the default-deny `GRANTABLE_TEAM_PERMISSIONS`
  allowlist; without those, a two-week loan would have become permanent authority.

### Content — the actual Notion migration (epic #126)

| | What | State |
|---|---|---|
| #127 | Read-only Notion-backed events view | ✅ merged |
| #128 | Phase 0 — teams and team membership | ✅ superseded by #182 |
| #129 | Phase 1 — events and meetings | ✅ merged — all four slices |
| #130 | Phase 2 — tasks and the member dashboard | ✅ merged (#211) |
| #131 | Phase 3 — requerimentos (cross-team approval) | ⬜ blocked on order integrity |
| #132 | Phase 4 — forms engine for C&Q inscrições | ⬜ not started |
| #138 | Phase 5 — sponsorship outreach | ⬜ not started |
| #133 | Phase 6 — event finance ledger | ⬜ not started |
| #134 | Phase 7 — recruitment pipeline | 🔵 **slices A + dual approval in review** |
| #135 | Phase 8 — venue scouting | ⬜ not started |
| #136 | Phase 9 — fold Sweats Verdes into the shop | ⬜ not started |
| #137 | Phase 10 — retire Notion | ⬜ last |
| #210 | Import the existing Notion events and meetings | 🟢 **unblocked by #219, ready** |
| #219 | Events: collaborating teams + per-event visibility | 🔵 in review (#221) |

**Content has started moving.** `/workspace/[team]` no longer shows a placeholder: it lists the
team's events and meetings, and each opens a detail page with agenda, minutes, attendance,
document links and related events. Everything else in the table above is still untouched.

#129 was sliced into four PRs, because it is far too big for one. **All four are merged.**

| slice | what | state |
|---|---|---|
| A | events + meetings, team-scoped, in the workspace | ✅ merged (#198) |
| B | agenda, minutes, attendance, documents, relations | ✅ merged |
| C | `is_public` drives `/activities` — read from the database, not Notion | ✅ merged |
| D | public events reach members' Google Calendars | ✅ merged (half — see below) |

**Slice C landed the visible win: `/activities` no longer calls Notion at request time.** Public
workspace events appear on the students' calendar, and the members-only panel reads the database
scoped to the caller's own teams — narrower than the Notion view it replaced, which showed every
team's internal events to any member.

`src/utils/notion/internalEvents.ts` is deleted. The Notion → `neiist.activities` sync **stays**:
it still holds events created before the migration, and retiring it is Phase 10 (#137), not this.

**Slice D is deliberately half of what the issue sketched.** Public workspace events now reach
members' Google Calendars, satisfying "public events appear on Google Calendar". The other half —
internal meetings to a per-team calendar — is **blocked on #202**: those calendars are created
with the Google API's public ACL scope (`scope: { type: "default" }`), so writing an internal
meeting to one is the exact leak #202 exists to stop. That half needs the ACL decision first.

### Supporting, deliberately deferred

| | What | Why deferred |
|---|---|---|
| #159 | Per-member permission overrides | Should reuse the `team_access_grants` table from #184 |
| #160 | Audit log | The grants table already records grant/revoke; #160 is a pure addition |
| #152 | Measure production schema drift | Do before migrations touch the order functions |
| #187 | Should members manage their own photo? | Product question — ask Fotografia |

---

## 4. State right now

**Everything in the access model (epic #182) is merged and the epic is closed.** So is #129
(events and meetings, all four slices) and #130 (tasks and the member dashboard). What is open
is the recruitment pipeline and the events model that the Notion import waits on.

### Open PRs — all three mergeable, all independent of each other

| PR | What | Migration |
|---|---|---|
| #229 | #210 — the Notion events import | 025 |
| #230 | #224 + #225 — onboarding page and per-team WhatsApp links | 026 |

Merge order does not matter between them. #214, #215, #220, #221, #222, #226, #227 and #228
are merged — including the build fix, so `main` compiles again.
### #134 — the recruitment pipeline

**Complete, pending merges.**

| slice | what | state |
|---|---|---|
| A | public application form, per-team review | ✅ merged (#215) |
| — | #217 dual approval + board membership as data | ✅ merged (#215) |
| B | #213 `@neiist.pt` address generation | ✅ merged (#214) |
| C | #223 acceptance / rejection emails, exactly once | ✅ merged (#226) |
| — | #218 interview availability and booking | ✅ merged (#227) |
| D | #224 the onboarding page the token leads to | 🔵 PR #230 |
| E | #225 per-team WhatsApp links | 🔵 PR #230 |
### Waiting on a human

| # | What | Why it needs you |
|---|---|---|
| #202 | The personal calendar sync publishes internal meetings to a **world-readable** calendar | The leak is fixed; the ACL decision (public calendar vs. login-gated) is a product call |
| #141 | Rotate the exposed shared account credential | Needs a person with the account |
| #152 | Measure production schema drift | Needs production access; do it before migrations touch the order functions |
| — | Should **Tesoureiro** and **Diretora SINFO** be on the board for recruitment sign-off? | Both sit on the Direção formally and both are graded `member` on purpose (#185). Not seeded — one checkbox in Gestão de Cargos either way. |

### Supporting, deliberately deferred

| | What | Why deferred |
|---|---|---|
| #159 | Per-member permission overrides | Should reuse the `team_access_grants` table from #184 |
| #160 | Audit log | The grants table already records grant/revoke; #160 is a pure addition |
| #187 | Should members manage their own photo? | Product question — ask Fotografia |
| #212 | Workspace tidy-up: split the query modules, adopt the UI primitives | Do it once the recruitment slices stop moving these files |

---

## 5. Suggested next steps, in order

1. **Merge #215, then #222.** That is the gate on everything else in recruitment.
2. **#210 — import the Notion events and meetings.** Unblocked by #219: the import needs
   collaborating teams (24 of the 52 Notion events have no single owning team) and the four
   visibility levels (16 are public and would otherwise duplicate `/activities`).
3. **Slice C** — the acceptance/rejection emails. Only after #222.
4. **#218** — interview scheduling. Can run in parallel with C.
5. **#111 / #153** — `layout.tsx:40-49` swallows `DynamicServerError` the same way
   `serverCheckRoles` did. Auth-adjacent, so it needs approval.
6. **#202** — the ACL decision, then the other half of #129 slice D (internal meetings to a
   per-team calendar) becomes possible.

Do **not** start #131 (requerimentos) yet — every operation in it is a multi-table write, so it
depends on order integrity and transactions being threaded properly.

---

## 6. Traps that have already cost time

- **`--limit 100` on the project board silently truncates.** The board passed 100 items; the
  newest issues are exactly the ones that vanish, and `item-edit` then claims an item is "NOT ON
  BOARD". Use `--limit 300`. (Fixed in the skill file.)
- **Port 5432.** A non-Docker Postgres on the machine takes it, the container then starts without
  publishing, and the app connects elsewhere. `scripts/dev-db-check.sh` fails loudly now (#105).
  Override with `POSTGRES_PORT` and keep `DATABASE_URL` in step. **As of this writing a Homebrew
  `postgresql@14` holds 5432, and the dev container is on 5433.**
- **Never `catch`-all around Next control flow.** `redirect()`, `notFound()` and
  `DynamicServerError` are *thrown*; swallowing them cancels the framework (#111).
- **`::VARCHAR(10)` casts silently truncate** — Postgres truncates on that cast rather than
  erroring, so a 36-char `ext_<uuid>` istid would read and write under a 10-char prefix. Keep
  `::VARCHAR(50)`.
- **Verify a text replacement actually matched.** A Python `.replace()` with no assert failed
  silently and a fix did not land; it was caught only because a test still passed.
- **Upstream's version is not automatically better.** Their Notion webhook fails open, their
  `proxy.ts` omits `/shop/pos`, and their `userQueries.ts` would truncate external istids.

---

## 7. Where the memory lives

- [`project-status.md`](project-status.md) — shipped / open / waiting on a human.
- [`problem-registry.md`](problem-registry.md) — bugs: symptom, root cause, fix, guard.
- [`decision-log.md`](decision-log.md) — decisions and their rejected alternatives.
- [`architecture-notes.md`](architecture-notes.md) — architectural state.
- [`upstream-sync-plan.md`](upstream-sync-plan.md) — the 42-file collision surface.
- `.claude/agents/`, `.claude/skills/`, `.claude/plans/` — the agent pipeline.

If something took an hour to work out and is not written down, it will cost an hour again.
