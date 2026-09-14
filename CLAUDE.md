# CLAUDE.md — NEIIST Website

Primary context file for Claude Code in this repository. Read this before touching anything.

> `AGENTS.md` mirrors this file for other agent runtimes. If you change a rule here that is
> also stated there, change it in both places.

---

## 0. Where this repository is, right now

**2026-09-14 — the fork was reset to upstream and a new phase started.**

This checkout used to carry ~130 commits of fork-only work (a members-only workspace, a
requerimentos workflow, Zod validation, transactions, a migration runner, team-scoped
permissions). The Dev-Team coordinator has seen that work and is porting what he wants of it
into the organisation repo himself. Rather than keep maintaining a fork that had drifted 705
files from upstream, `main` was reset to `upstream/main` at **v3.0.0**.

**The old work is not lost, and it is not a base to build on either:**

| Where | What |
|---|---|
| tag `archive/fase-1` | The fork's `main` as of 2026-09-14, before the reset |
| branch `archive/old-fork` | Same commit, as a branch |
| ~72 branches on `origin` | Every feature branch of the old phase, untouched |

Treat that archive as **read-only history**. Do not cherry-pick from it opportunistically, do
not resurrect its plans, and do not assume any of its abstractions exist here — most do not.
If something from it is genuinely worth rebuilding, it gets re-proposed against *this* code,
on its own merits, as new work.

Three documents survived the reset because they record things the code never did:
`docs/ai-workflow/how-neiist-works.md` (how the núcleo actually operates, from the product
owner), `requerimentos-plan.md` and `event-lifecycle-plan.md` (product reasoning). They are
**product context, not architecture**; the implementation sketches inside them describe a
codebase that no longer exists.

---

## 1. What this project is

**NEIIST Website** — the web platform of NEIIST (Núcleo Estudantil de Informática do IST),
the Computer Science student association at Instituto Superior Técnico, Universidade de Lisboa.

It serves real students and handles **real money** (merch shop with SumUp card payments) and
**real personal data** (student records, CVs, photos, emails). Production software, not a toy.

| | |
|---|---|
| Version | 3.0.0 |
| Framework | Next.js 16.3.4 (App Router) + React 19.2.8 |
| Language | TypeScript 6, `strict: true` |
| Node | **24.14.0** (`.nvmrc`) |
| Package manager | **pnpm 12.3.4** — pinned in `package.json#packageManager` |
| Repo layout | pnpm workspace: the app at the root, `packages/ui` beside it |
| Design system | `@neiist/ui` — `packages/ui`, with CSS tokens and a Vite playground |
| Database | PostgreSQL 15, **raw SQL via `pg` — no ORM**, 80 SQL functions in `docker/schema.sql` |
| Validation | hand-rolled helpers in `src/utils/apiValidationUtils.ts` — **no Zod** |
| Styling | CSS Modules in `src/styles/`, tokens from `@neiist/ui/tokens.css`, no Tailwind |
| i18n | `src/app/[locale]/…` with `pt` / `en` dictionaries in `src/i18n/locales/` |
| Notifications | `sonner` toasts |
| Realtime | `pg_notify` → `src/lib/dbBroadcaster.ts` → SSE, used by the voting system |
| Deploy | build on GitHub Actions → tarball over SSH → PM2 blue/green |
| Releases | release-please, driven by Conventional Commits |
| Repo model | a **fork** of `neiist-dev/neiist-website`, currently level with it |

### Fork topology — read this carefully

- `origin` → `github.com/tomasmbrito/neiist-website` — **the user's fork. All work happens here.**
- `upstream` → `github.com/neiist-dev/neiist-website` — the organisation repo.

**Hard rule: never push, never open a PR, and never merge anything to `upstream`.**
`upstream` is fetch-only. You may read it, diff against it, and cherry-pick *from* it.
Pushing to `origin` and opening PRs on `origin` is allowed and expected.

`gh pr create` **defaults to the parent repo on a fork.** Always pass
`--repo tomasmbrito/neiist-website` explicitly. A hook enforces this.

**New in this phase: stay close to upstream.** The whole point of the reset was to stop
carrying divergence. Prefer small, focused branches that could plausibly be contributed
upstream over large parallel rewrites. When upstream moves, rebase onto it rather than
accumulating a second architecture.

---

## 2. Non-negotiable rules

1. **Never** read, print, edit, or commit secrets — environment files, service-account key
   files, OAuth client secrets, token caches, private keys and certificates, PATs, passwords,
   connection strings, API keys. The example environment file is the only place environment
   variables get documented, and only with placeholders.
2. **Never** push to `upstream`. Never open or merge a PR against `neiist-dev/*`.
3. **Never** commit directly to `origin/main`. Work on a branch, open a PR on the fork.
4. **Always** run `pnpm type:check`, `pnpm lint` and `pnpm format:check` before claiming work
   is done. "It should compile" is not evidence. Paste the actual result.
5. **Never** report a task complete when a gate failed. Say what failed, with the output.
6. **Never** weaken a check to make it pass — no `any`, no `@ts-expect-error`, no
   `eslint-disable`, no deleted assertion, to get green. Fix the cause or report the blocker.
7. **Human approval required** before: database schema changes (`docker/schema.sql`),
   auth/permission changes, SumUp/payment changes, adding or upgrading dependencies, and
   anything touching production.
8. **Never run `pnpm db:reset` on the developer's database.** It drops the `neiist_db` volume:
   imported data, demo data and the logged-in account all go, and none of it is recoverable
   from this repository. This was done by accident on 2026-08-27 and destroyed a completed
   Notion import.

   To check that `docker/schema.sql` builds, use a **throwaway database** — it proves the same
   thing and costs nothing:

   ```bash
   docker exec -i neiist_db psql -U admin -d postgres -q \
     -c "DROP DATABASE IF EXISTS schemacheck WITH (FORCE);" -c "CREATE DATABASE schemacheck;"
   docker cp docker/schema.sql neiist_db:/tmp/s.sql
   docker exec neiist_db psql -U admin -d schemacheck -q -f /tmp/s.sql 2>&1 | grep -i ERROR
   docker exec -i neiist_db psql -U admin -d postgres -q -c "DROP DATABASE schemacheck WITH (FORCE);"
   ```

   Use `psql -f`, never `psql < file`: reading from **stdin** prints `ERROR:` with no `psql:`
   prefix, so a grep for `^psql.*ERROR` silently matches nothing and a broken file looks clean.
   That cost an hour on 2026-08-26.

If a step needs a secret or a production infra change → **stop and ask.**

---

## 3. Commands

Node must be **24.14.0**. `nvm use` reads `.nvmrc`. pnpm is pinned via `packageManager`;
if corepack cannot launch it (older corepack versions look for `bin/pnpm.cjs`, but pnpm 12
ships `bin/pnpm.mjs`), install it directly: `npm i -g --force pnpm@12.3.4`.

```bash
pnpm install --frozen-lockfile   # install (workspace-aware; also builds packages/ui deps)
pnpm dev                         # docker postgres + next dev --turbopack
pnpm build                       # production build
pnpm next typegen                # generate route types — CI does this before type:check
pnpm type:check                  # tsc --noEmit                       <- gate
pnpm lint                        # eslint (config in config/eslint/)  <- gate
pnpm format:check                # prettier --check                   <- gate
pnpm format                      # prettier --write
pnpm db:seed                     # seed the local database
pnpm db:reset                    # DESTRUCTIVE — see rule 8
pnpm setup                       # scripts/setup.sh — first-time environment setup
pnpm --filter @neiist/ui dev     # Vite playground for the design system
```

**Baseline as of the reset (2026-09-14): `type:check`, `lint` and `format:check` are all
clean on a fresh checkout.** If you see errors your change did not cause, say so rather than
silently fixing scope creep.

### There are no tests

No test runner, no test files, no test job in CI. **Do not claim coverage that does not
exist**, and do not write a test that asserts a mock still behaves the way you mocked it.
Introducing a runner is a dependency change → needs approval (§9). If you fix a concurrency
or data-integrity bug, say plainly that no gate can catch a regression of it.

### CI

`.github/workflows/ci.yml` runs one job on push/PR to `main`: install → `next typegen` →
`format:check` → `lint` → `type:check`. **No build job and no tests.**

### ⚠️ `pnpm build` needs a live database

`src/app/[locale]/shop/[id]/page.tsx:11` has a `generateStaticParams()` that queries Postgres,
so the build reads the database while collecting page data. With nothing on port 5432 it fails
with `Failed to collect page data for /[locale]/shop/[id]` and a `DatabaseError` — **that is an
environment failure, not a code defect.** Start the database first (`pnpm dev` brings the
container up, or run docker compose yourself).

This is also why CI has no build job: `deploy-prod.yml:62-80` builds by **opening an SSH tunnel
to the production database** and pointing `DATABASE_URL` at `127.0.0.1:5432` through a
`neiist_readonly` role. A plain CI runner has no such tunnel. Consequence worth keeping in
mind: **a production deploy reads production data at build time**, so a query added to
`generateStaticParams` runs against live rows during every release.

---

## 4. Architecture map

```
.
├── config/               eslint, prettier, lint-staged, commitlint configs (not at the root)
├── docker/               docker-compose.yml · schema.sql (3670 lines) · init.sql
├── docs/
│   ├── installation.md, contributing.md, code_of_conduct.md   (upstream's)
│   └── ai-workflow/      project memory — see §7
├── packages/ui/          @neiist/ui — design system + Vite playground
├── scripts/              deploy_prod.sh · deploy_staging.sh · seed-db.mts · setup-*.mts
└── src/
    ├── app/
    │   ├── [locale]/     25 pages — every user-facing route is locale-scoped
    │   └── api/          43 route handlers (route.ts) — NOT locale-scoped
    ├── components/       about-us · activities · admin · dinner · homepage · layout
    │                     photo-management · search · shop · team-management · voting
    ├── context/          UserContext, ShopContext
    ├── hooks/            useSearch
    ├── i18n/             i18n-config.ts · dictionaries.ts · locales/{pt,en}.json
    ├── lib/
    │   ├── auth.ts           getAuthenticatedUser · requireUser · requireRoles
    │   ├── db/
    │   │   ├── connection.ts     the pg pool + db_query + graceful shutdown
    │   │   ├── errorMapper.ts    pg error -> domain error
    │   │   └── repositories/     user · team · shop · event · voting
    │   ├── google/           calendar · drive · driveService · serviceAccount
    │   ├── security/         jwt · authSession · permissions · routePermissions
    │   │                     rateLimit* · securityHeaders · cspUtils · botAgents · urlUtils
    │   ├── dbBroadcaster.ts  pg_notify listener -> EventEmitter -> SSE
    │   ├── votingSystem.ts, sumup.ts, email.ts, autoCancelScheduler.ts, mbwayNumbers.ts
    ├── proxy.ts          route protection, rate limiting, locale routing, security headers
    ├── instrumentation.ts  boots the auto-cancel scheduler + seeds special shop categories
    ├── schemas/          currently empty
    ├── styles/           CSS modules, mirrors components/ and pages
    ├── types/            user · shop · events · voting · sumup · fenix · memberships · notion · errors
    └── utils/            apiErrorUtils · apiValidationUtils · calendarUtils · eventsUtils
        └── shop/         order finalization, discounts, auto-cancel, status, export, filters
```

### The data layer

**`src/lib/db/repositories/*` is the data layer**, five modules split by domain:
`user`, `team`, `shop` (485 lines — the biggest), `event`, `voting`.

- `db_query` lives in `connection.ts`. **Nothing else should touch the `pg` pool directly** —
  except `dbBroadcaster.ts`, which deliberately holds its own long-lived `Client` for
  `LISTEN`, because a pooled connection cannot.
- Add a query to the module that owns its domain. If it fits none of them, that is a signal
  to add a sixth module, not to widen an existing one.
- Business logic lives in `src/lib/*` and `src/utils/shop/*`, not in the repositories.

**`istid` is the identity key** — `VARCHAR(10) PRIMARY KEY` in `neiist.users`. The
`::VARCHAR(10)` casts in `user.repository.ts` match the column and are correct *here*. (They
were a defect in the old fork only because that fork added Google OAuth users with synthetic
36-character istids. **This codebase has Fenix OAuth only.** If external login is ever added,
the column and every cast must widen first, or Postgres will silently truncate rather than
error.)

### Transactions: where they exist and where they don't

`grep` for `withTransaction` or `BEGIN` in `src/` returns nothing, and `db_query` takes a
connection from the pool per call — so two calls in the same TypeScript function are not even
guaranteed to share a connection. But that is only half the picture, and the half that is
usually quoted wrongly:

**Atomicity lives in `plpgsql`, and mostly it is there.** Every repository function is a
*single* SQL call (the one exception is `getUser`, which does three reads), and the real work
happens inside the 80 functions in `docker/schema.sql` — each of which runs in its own implicit
transaction. `neiist.new_order` is the model: it takes `FOR UPDATE` locks on the product and
variant rows *before* checking stock, so two people buying the last unit cannot both succeed.
**Do not describe order placement or stock decrement as racy — they are not.**

**The gap is TypeScript sequencing two SQL calls.** `finalizePaidOrder` used to be the live
example — `setOrderState(…, "paid")` then, separately, `updateOrder(…, { payment_reference })` —
until 2026-09-15, when it was folded into one function, `neiist.mark_order_paid`, which also
takes a `FOR UPDATE` lock so two callers racing the same order serialize instead of
double-processing. It is the template to copy, not just the fixed instance: the pattern still
has no general-purpose fix, so the next function that writes two things about the same row in
sequence has the exact same bug until someone gives it the same treatment.

So the rule is: **keep multi-step writes inside one `plpgsql` function.** If you find yourself
calling two repository write functions in a row, that is the bug, and the fix is a SQL function,
not a `withTransaction` helper. This is itself a schema change — needs approval (§9) before
you write it, same as `mark_order_paid` did.

### ⚠️ Schema changes have no path to an existing database

`docker/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, which Postgres runs **only
on an empty data directory**. There is no `docker/migrations/`, no migration runner, and
neither deploy script has a `psql` step.

**`docker/schema.sql` describes what a *new* database gets. It has never described
production.** Production's real schema is `schema.sql` as of whenever that volume was created,
plus anything typed into a `psql` session since — it is unmeasured.

So: editing `schema.sql` changes nothing in production, and a `CREATE OR REPLACE` applied by
hand will silently overwrite whatever is really there. Any schema work needs a human in the
loop and a plan for how it actually reaches the server.

**One narrow exception worth knowing, not a general licence.** Every function in this file is
`CREATE OR REPLACE FUNCTION` — idempotent, touches no table, no data. A *new or changed
function* (not a table/column/constraint change) can be applied standalone by running just that
one block through `psql`, safely re-runnable, without needing the rest of `schema.sql` or a
fresh database. This is how `neiist.mark_order_paid` was verified: applied and exercised
directly against the real local dev database, never touching `pnpm db:reset`. It is still a
human decision to run that DDL against production — this only means the mechanism to do so is
simple (`psql -f` on the one function's block) once a human says yes, not that the yes is
implied.

### Authorization is two-layered, and must stay that way

1. **`src/proxy.ts`** — runs on the Edge for every request: bot blocking, rate limiting
   (`rateLimitRules.ts`), locale resolution, JWT verification with Web Crypto
   (`verifyJWTWebCrypto`), route matching against `routePermissions.ts`, security headers.
2. **`requireRoles()` / `requireUser()` from `src/lib/auth.ts`** — called by each privileged
   page before it fetches. 17 of the 25 pages do this.

**Never rely on the proxy alone** — it is an optimisation, not a boundary. Note the classic
trap: a privileged path nested under a public prefix (`/shop/manage` under `/shop`) falls
through to the public match unless a rule claims it. `routePermissions.ts` lists
`/shop/manage` and `/shop/pos` explicitly for exactly this reason — keep it that way when
adding routes.

The role model is a **flat hierarchy** in `src/types/user.ts`:
`admin 100 > coordinator 80 > shop_manager 60 > member 40 > guest 0`. Department-scoped
questions go through `canManageDepartment()` in `lib/security/permissions.ts`, which reads
`neiist.valid_department_roles` — **board access is data, not a hardcoded role list.**

### Integrations

Fenix OAuth (the only login) · SumUp (payments, incl. physical card readers) ·
Notion (calendar sync, with a webhook) · Google Calendar + Drive (service account) ·
Nodemailer (SMTP).

---

## 5. Code conventions

- **SQL**: parameterised only (`$1, $2`). String interpolation into SQL is a blocking defect.
- **Use `@neiist/ui` first.** Before writing a Button, Modal, Tabs, Card, Field, Avatar,
  Tooltip, Skeleton, Alert or DateInput, check `packages/ui/src/components` — it is almost
  certainly there. Run the playground (`pnpm --filter @neiist/ui dev`) to see them.
- **Colours come from tokens** (`@neiist/ui/tokens.css`), never hardcoded hex in a CSS module.
- **API routes**: validate with the helpers in `src/utils/apiValidationUtils.ts`
  (`validateId`, `validateIstId`, `isValidEmail`, …) and map errors through
  `src/utils/apiErrorUtils.ts`. Do not return raw `pg` errors to the client. There is no Zod —
  do not introduce it without approval (§9).
- **Server Components are the default.** Add `'use client'` only for hooks, browser APIs or
  event handlers, and push it as far down the tree as possible. Upstream did a deliberate
  RSC/client split in v3.0.0 — do not undo it by hoisting `'use client'` to a page.
- **Every user-facing page lives under `src/app/[locale]/`** and takes its strings from
  `src/i18n/locales/{pt,en}.json`. **New copy must be added to both files.** API routes are
  not locale-scoped.
- **Types**: no `any`. Use `unknown` + narrowing. Types live in `src/types/`.
- **Filenames** are lint-enforced (`eslint-plugin-validate-filename`): PascalCase in
  `components/`, camelCase in `app/api/`, kebab/reserved names in `app/`.
- **`console.log` is an error**; `console.warn` / `console.error` are allowed.
- **User-facing copy is Portuguese first**, English as the second locale. Match surrounding
  text; do not silently translate existing UI.
- **Commits**: Conventional Commits, enforced by commitlint via husky, and release-please
  builds the changelog and version from them. `feat:` / `fix:` / `refactor:` / `chore:` /
  `docs:` / `perf:` / `ci:`. A `!` or `BREAKING CHANGE:` triggers a major release — mean it.
- Husky runs `lint-staged` on commit; do not bypass it with `--no-verify`.

---

## 6. The agent workflow

This repo ships a multi-agent pipeline in `.claude/agents/`. The intended flow for any
non-trivial change:

```
  /ship <task>
      │
      ├─ 1. planner            research + written plan          (read-only)
      │        ↓  human approves the plan
      ├─ 2. implementer        writes the code                  (scoped to the plan)
      ├─ 3. quality-reviewer   ─┐
      │  4. security-reviewer   ├─ run in parallel, read-only, report findings
      │  5. test-engineer      ─┘
      │        ↓  implementer fixes what they found
      └─ 6. delivery           gates → branch → commit → PR → board update
```

Rules that make it work:
- **Reviewers never fix.** They report `file:line` + failure scenario. The implementer fixes.
- **Reviewers are read-only** — enforced by their `tools:` frontmatter.
- **A reviewer that finds nothing says so.** Do not invent findings to look useful.
- **The plan is a file** (`.claude/plans/<slug>.md`), not a chat message, so every subagent
  reads the same context.
- Skip the pipeline for genuinely trivial changes (a typo, a one-line copy fix). Judgement.

Supporting skills live in `.claude/skills/`, slash commands in `.claude/commands/`, and
enforcement hooks in `.claude/hooks/`.

---

## 7. Project memory

Record things that future sessions cannot re-derive from the code. `docs/ai-workflow/`:

- `how-neiist-works.md` — how the núcleo actually operates, straight from the product owner.
  **Read this before designing any feature that touches how the association runs.** It
  survived the reset because it is about NEIIST, not about code.
- `requerimentos-plan.md`, `event-lifecycle-plan.md` — product reasoning carried over from the
  previous phase. The *product* analysis holds; the *implementation* sections describe a
  codebase that no longer exists. Read them for the "what" and "why", never the "how".
- `problem-registry.md` — bugs: symptom, root cause, fix, regression guard. *(start it)*
- `decision-log.md` — decisions: what, alternatives considered, why. *(start it)*

A bug that took an hour to diagnose and is not written down will cost an hour again.

---

## 8. Known state — read before proposing work

So you do not "discover" these as new:

- **No tests, no `withTransaction` helper, no migration path.** Each is covered above; each is
  a real gap, not an oversight to fix casually. All three are the kind of change that needs the
  coordinator's buy-in, because they are structural and this fork no longer wants to diverge
  alone. (The Notion webhook, listed here until 2026-09-15, is now fixed — see
  `docs/ai-workflow/audit-2026-09.md`. The general absence of a transaction helper is not; only
  the one live example that used to be cited in §4, `finalizePaidOrder`'s two-write payment
  flow, was fixed, by moving that specific logic into one SQL function.)
- **CSP nonces are not viable without giving up Cache Components.** This app has
  `cacheComponents: true`, which Next's own docs confirm *is* Partial Prerendering — and Next's
  CSP docs are explicit that nonce-based CSP requires every page to render fully dynamically,
  incompatible with PPR. Confirmed against a real `pnpm build`: all 25 pages render `◐`
  (Partial Prerender). `script-src 'unsafe-inline'` stays until someone decides to trade PPR
  away for a strict CSP — that decision is not implied by "fix the CSP", ask first. Full
  writeup in `docs/ai-workflow/audit-2026-09.md` (P2-7).
- **`scripts/deploy_prod.sh:3` hardcodes `node/v24.11.1` on PATH** while `.nvmrc` pins
  `24.14.0`. The build now happens on GitHub Actions (which honours `.nvmrc`), so the server
  only runs the artifact — but the versions disagree and nobody has reconciled them.
- **Uploads live in `data/`**, which is gitignored and symlinked on the server to
  `/home/neiist/shared/data` by the deploy script, so blue/green no longer loses them. Served
  through `api/shop/photo/[filename]` and `api/user/photo/[userId]`, not statically.
- **`xlsx` is installed from a SheetJS CDN tarball URL**, not the npm registry — it sits
  outside normal audit and lockfile-integrity tooling.
- **`pnpm dev` needs port 5432 free.** If another Postgres holds it, the container starts
  without publishing its port and the app silently connects elsewhere. Check before debugging
  "impossible" data.
- **`next-env.d.ts` is gitignored**, so a fresh checkout lacks it. CI runs `pnpm next typegen`
  before `type:check` for this reason — if you add a workflow, keep that step.
- **`instrumentation.ts` runs on every server boot** and writes to the database
  (`seedSpecialCategories`). Anything added there runs on both blue and green during a deploy.
- **The GitHub Kanban board is `tomasmbrito/projects/1`** and was cleared on 2026-09-14 along
  with the fork's 49 open issues. It starts empty for this phase. See
  `.claude/skills/project-board/SKILL.md` for the field IDs.

---

## 9. When to stop and ask

Proceed autonomously when: the plan is approved, the change is inside it, you are editing
application code, or you are running read-only/non-destructive commands.

**Stop and ask a human** when:
- a secret or production credential is needed,
- the change touches `docker/schema.sql`,
- the change touches auth, permissions, or SumUp payments,
- a dependency must be added or upgraded — **including a test runner or Zod**,
- a push to `upstream` or a production deploy would be involved,
- the work has grown beyond the approved scope,
- the change would re-introduce a large fork-only architecture (see §0),
- or two reasonable readings of the request would produce materially different work.
