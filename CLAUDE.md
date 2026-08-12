# CLAUDE.md — NEIIST Website

Primary context file for Claude Code in this repository. Read this before touching anything.

> `AGENTS.md` is the equivalent file for other agent runtimes (Antigravity/Gemini). If you
> change a rule here that is also stated there, change it in both places.

---

## 1. What this project is

**NEIIST Website** — the web platform of NEIIST (Núcleo Estudantil de Informática do IST),
the Computer Science student association at Instituto Superior Técnico, Universidade de Lisboa.

It serves real students and handles **real money** (merch shop with SumUp card payments) and
**real personal data** (student records, CVs, emails). Treat it as production software, not a
toy project.

| | |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript 6, `strict: true` |
| Database | PostgreSQL 15, **raw SQL via `pg` pool — no ORM** |
| Validation | Zod 4 (`src/schemas/`) |
| Styling | CSS Modules in `src/styles/`, no Tailwind |
| Notifications | `sonner` toasts |
| Package manager | **Yarn** (see §8 — this is contested with upstream) |
| Deploy | SSH + PM2 blue/green via GitHub Actions |
| Repo model | This is a **fork** of `neiist-dev/neiist-website` |

### Fork topology — read this carefully

- `origin` → `github.com/tomasmbrito/neiist-website` — **the user's fork. All work happens here.**
- `upstream` → `github.com/neiist-dev/neiist-website` — the organisation repo.

**Hard rule: never push, never open a PR, and never merge anything to `upstream`.**
`upstream` is fetch-only. You may read it, diff against it, and cherry-pick *from* it.
Pushing to `origin` and opening/merging PRs on `origin` is allowed and expected.

The fork has diverged substantially and intentionally: it carries refactors (repository
pattern, domain errors, Zod validation, UI primitives) that upstream does not have. When
syncing from upstream, **the fork's version is often the better one**. Never blind-merge.
See `.claude/skills/upstream-sync/SKILL.md`.

---

## 2. Non-negotiable rules

1. **Never** read, print, edit, or commit secrets: `.env`, `.env.*` (except `.env.example`),
   `docker/.env`, `google-key.json`, `client_secret.json`, `token.json`, `*.pem`, `*.key`,
   PATs, passwords, connection strings, API keys.
   `.env.example` is the only place environment variables get documented, with placeholders.
2. **Never** push to `upstream`. Never open or merge a PR against `neiist-dev/*`.
3. **Never** commit directly to `origin/main`. Work on a branch, open a PR on the fork.
4. **Always** run `yarn type:check` and `yarn lint` before claiming work is done. "It should
   compile" is not evidence. Paste the actual result.
5. **Never** report a task complete when a gate failed. Say what failed, with the output.
6. **Never** weaken a check to make it pass — no `any`, no `@ts-expect-error`, no
   `eslint-disable`, no deleted assertion, to get green. Fix the cause or report the blocker.
7. **Human approval required** before: database schema changes (`docker/schema.sql`,
   `docker/migrations/`), auth/permission changes, SumUp/payment changes, adding or upgrading
   dependencies, and anything touching production.

If a step needs a secret or a production infra change → **stop and ask.**

---

## 3. Commands

```bash
yarn dev            # starts docker postgres + next dev (turbopack)
yarn build          # production build
yarn type:check     # tsc --noEmit          <- gate
yarn lint           # eslint                <- gate
yarn format:check   # prettier --check      <- gate
yarn format         # prettier --write
yarn db:reset       # DESTRUCTIVE: drops the local db volume and re-seeds
```

Baseline as of the last full audit: `type:check` clean, `lint` clean.
If you see errors that your change did not cause, say so rather than silently fixing scope creep.

There is **no test command, because there are no tests.** This is the single largest quality
gap in the repository. Do not pretend otherwise, and do not write a test file that no runner
executes.

---

## 4. Architecture map

```
src/
├── app/                  Next.js App Router
│   ├── api/              43 route handlers (route.ts)
│   └── */page.tsx        pages; error.tsx boundaries on shop/admin/profile/activities
├── components/           React components, grouped by domain
│   ├── ui/               primitives: Button, Input, Select, Modal  <- prefer these
│   ├── shop/             largest + most complex area
│   ├── admin/, activities/, homepage/, about-us/, layout/, dinner/
├── lib/
│   └── errors/                 domain error classes + apiErrorHandler
├── schemas/              Zod request schemas
├── utils/
│   ├── db/               the data layer — see §4
│   │   ├── dbClient.ts       the pool + db_query
│   │   ├── errorMapper.ts    DB error -> domain error
│   │   ├── userQueries.ts    users, memberships, departments, teams, roles
│   │   ├── eventQueries.ts   activities calendar
│   │   └── shopQueries.ts    products, variants, discounts, orders, categories
│   ├── shop/             order finalization, discounts, auto-cancel, status
│   ├── security/         validation, rate limiting, CSP
│   └── authUtils.ts, googleCalendar.ts, emailUtils.ts, sumupUtils.ts
├── context/              UserContext, ShopContext
├── types/                shared TypeScript types
├── styles/               CSS modules, mirrors the components/ tree
└── proxy.ts              route protection (was middleware.ts — renamed for Next 16)
```

### The data layer — resolved 2026-08-12

**The identity model is `istid`.** Decided in #82 and no longer open.

This repository used to carry two parallel implementations of ~63 database functions:
`src/utils/dbUtils.ts` (which ran) and `src/lib/db/repositories/*` (1,053 lines, **zero call
sites, never executed**), the latter written against a UUID migration that
`docker-compose.yml` never applied.

**That half has been deleted**, along with `docker/migrations/001_user_uuid.sql`. The two real
fixes it contained were ported into `dbUtils.ts` first: the `getUser` N+1 (role orders are now
fetched once per distinct department, in parallel) and `getOrderByNumber` (it passed the order
number into `get_order`'s INT id parameter).

`dbUtils.ts` itself was then split in **#142** (Wave 2), adopting upstream's file boundaries.

What this means now:

- **`src/utils/db/*` is the data layer.** `src/utils/dbUtils.ts` **no longer exists.**
  Do not recreate it, and do not let one of the five files grow back into a god object.
- Add a query to the module that owns its domain. If it fits none of them, that is a signal to
  add a sixth module, not to widen an existing one.
- **`db_query` lives in `dbClient.ts`** and is imported by the other four. Nothing else should
  touch the `pg` pool directly.
- We took upstream's **structure** and kept the fork's **contents**. 62 of 64 export names
  matched; the bodies did not. Upstream's would have regressed two live fixes:
  - **`::VARCHAR(10)` casts** at four `userQueries.ts` call sites. Postgres *truncates* on that
    cast rather than erroring, so a 36-character `ext_<uuid>` istid would silently read and write
    under a 10-character prefix. **Keep `::VARCHAR(50)` everywhere.**
  - **The `getUser` N+1** — upstream still awaits `get_department_role_order` inside the
    membership loop, on the path `serverCheckRoles` runs for every guarded page and route.
- External (Google OAuth) users get a synthetic `istid` inside the existing `VARCHAR(50)`
  column, not a UUID primary key.
- Still open from Wave 2, deliberately: **#143** (reconcile `errorMapper` with upstream's
  message table; fix Portuguese strings missing accents) and `authUtils.ts` → `lib/auth.ts`,
  which carries #111 and is a behaviour change, not a move.

**The split did not introduce transactions** — upstream's `dbClient.ts` is `pool.query()` too,
exactly as predicted. #78/#79/#80/#100 stand on their own and are now **unblocked**.

### Integrations

Fenix OAuth (primary login) · Google OAuth (external users) · SumUp (payments) ·
Notion (calendar sync) · Google Calendar + Drive (service account) · Nodemailer (SMTP).

---

## 5. Code conventions

- **SQL**: parameterised only (`$1, $2`). String interpolation into SQL is a blocking defect.
- **Multi-table writes** (orders, payments, stock, discount redemption) **must be transactional.**
- **API routes**: validate the body with a Zod schema from `src/schemas/`, then let
  `apiErrorHandler` map domain errors to responses. Do not hand-roll status codes per route
  and do not return raw `pg` errors to the client.
- **Server Components are the default.** Add `'use client'` only for hooks, browser APIs, or
  event handlers, and push it as far down the tree as possible.
- **Types**: no `any`. Use `unknown` + narrowing. Types live in `src/types/`.
- **Filenames** are lint-enforced: PascalCase in `components/`, camelCase in `app/api/`,
  kebab/reserved names in `app/`.
- **Line length 100** (ESLint `max-len`).
- **`console.log` is an error**; `console.warn` / `console.error` are allowed.
- **User-facing copy is Portuguese.** Match surrounding text; do not translate the UI to English.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`).
  Upstream enforces this with commitlint and drives releases from it.

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
  This keeps the reviewer honest and the diff attributable.
- **Reviewers are read-only** — no Edit/Write. This is enforced by their `tools:` frontmatter.
- **A reviewer that finds nothing says so.** Do not invent findings to look useful.
- **The plan is a file** (`.claude/plans/<slug>.md`), not a chat message, so every subagent
  can read the same context.
- Skip the pipeline for genuinely trivial changes (a typo, a one-line copy fix). Judgement.

Supporting skills live in `.claude/skills/`, slash commands in `.claude/commands/`, and
enforcement hooks in `.claude/hooks/`.

---

## 7. Project memory

**Start here for current state: [`docs/ai-workflow/project-status.md`](docs/ai-workflow/project-status.md)**
— what has shipped, what is open, which decisions are waiting on a human, and what to do next.

Record things that future sessions cannot re-derive from the code:

- `docs/ai-workflow/problem-registry.md` — bugs: symptom, root cause, fix, regression guard.
- `docs/ai-workflow/decision-log.md` — decisions: what, alternatives, why.
- `docs/ai-workflow/architecture-notes.md` — current architectural state.

Update these when you learn something surprising. A bug that took an hour to diagnose and
is not written down will cost an hour again.

---

## 8. Known state and open questions

Things you should know before proposing work, so you don't "discover" them as new:

- **Authorization is now two-layered, and must stay that way.** Middleware verifies JWT
  signatures (#101, `verifyJwtEdge`) and every privileged page calls `requireRoles()` before
  fetching (#116). **Never rely on middleware alone** — it is an optimisation, not a boundary.
  Note the trap that caught `/shop/manage` (#97) and `/shop/pos` (#117): a privileged path
  nested under a public prefix falls through to the public match unless a rule claims it.
- **`serverCheckRoles` swallows Next's `DynamicServerError`** — its blanket `catch` eats the
  signal Next uses to mark a route dynamic. That is why pages needed `force-dynamic`. Tracked
  in #111; needs approval as auth code.
- **No transactions exist anywhere.** `db_query` is `pool.query()`, so there is no way to
  express one. Every multi-statement operation in TypeScript is non-atomic by construction.
  The only atomicity comes from logic that happens to live entirely inside a `plpgsql` function.
  Adopting the upstream data layer did **not** change this — confirmed in #142.
- **There is a CI gate now** (`.github/workflows/ci.yml`: type-check, lint, format, build) and
  it passes. It failed on every run from #106 until #109 because `next-env.d.ts` is gitignored
  and absent from a fresh checkout — see #110. `deploy-staging.yml` still fires on every push
  to `main`. **There are still no tests and no test runner** (#52).
- **`/activities` renders against Notion.** An empty events table triggers a sync during
  render; it is now guarded (#118), but the page still depends on a third party at request time.
- **`xlsx`** is installed from a SheetJS CDN tarball URL, not the npm registry — it is outside
  normal audit/lockfile integrity tooling.
- **Uploaded product images go to `public/products`**, which is gitignored and lives inside the
  build directory — blue/green deploys can lose them.
- **Upstream has features the fork lacks**: a pg_notify/SSE voting system, Google service
  accounts loaded from env instead of credential files on disk, dinner-page work, and security
  dependency bumps. The two *structural* divergences are now closed — `middleware.ts` →
  `proxy.ts` (#139) and the `dbUtils.ts` split (#142). `authUtils.ts` → `lib/auth.ts` remains.
  **Read [`docs/ai-workflow/upstream-sync-plan.md`](docs/ai-workflow/upstream-sync-plan.md)
  before adopting any of it** — it has the measured 42-file collision surface and the wave
  ordering. Their version is not automatically the better one: their Notion webhook fails open
  when `VERIFICATION_TOKEN` is unset, which this fork already fixed in #96; their `proxy.ts`
  verifies JWTs with Node crypto in an Edge-runtime file and omits `/shop/pos` from its route
  lists; and their `userQueries.ts` would truncate external istids.
- **NEIIST's operations live in Notion, and moving them here is now a planned epic (#126).**
  It is an operations database with a cross-team approval workflow, not a wiki. Read
  [`docs/ai-workflow/notion-to-website-plan.md`](docs/ai-workflow/notion-to-website-plan.md)
  before touching anything in that area. It is **blocked on order integrity, #52 and #111** —
  every operation in it is a multi-table write.
- **`yarn dev` needs port 5432 free.** If another Postgres holds it, the container starts
  without publishing its port and the app silently connects elsewhere. `scripts/dev-db-check.sh`
  now fails loudly; override with `POSTGRES_PORT` and keep `DATABASE_URL` in step (#105).

---

## 9. When to stop and ask

Proceed autonomously when: the plan is approved, the change is inside it, you are editing
application code, or you are running read-only/non-destructive commands.

**Stop and ask a human** when:
- a secret or production credential is needed,
- the change touches `docker/schema.sql` or `docker/migrations/`,
- the change touches auth, permissions, or SumUp payments,
- a dependency must be added or upgraded,
- a push to `upstream` or a production deploy would be involved,
- the work has grown beyond the approved scope,
- or two reasonable readings of the request would produce materially different work.
