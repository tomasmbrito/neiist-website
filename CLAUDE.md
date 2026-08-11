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
│   ├── db/
│   │   ├── connection.ts       pg Pool singleton
│   │   └── repositories/       user | shop | team | event  <- the target pattern
│   └── errors/                 domain error classes + apiErrorHandler
├── schemas/              Zod request schemas
├── utils/
│   ├── dbUtils.ts        LEGACY god object, ~1065 lines  <- being dismantled
│   ├── shop/             order finalization, discounts, auto-cancel, status
│   ├── security/         validation, rate limiting, CSP
│   └── authUtils.ts, googleCalendar.ts, emailUtils.ts, sumupUtils.ts
├── context/              UserContext, ShopContext
├── types/                shared TypeScript types
├── styles/               CSS modules, mirrors the components/ tree
└── middleware.ts         route protection
```

### The data layer is forked in two — read this before touching any query

This is the single most important thing to understand about this codebase, and it is not what
it looks like.

`src/lib/db/repositories/*.repository.ts` looks like a completed repository-pattern migration.
**It is entirely dead code.** Verified: **55 files import `@/utils/dbUtils`; zero files import
anything under `@/lib/db`.** The only cross-reference is one repository importing another.

So there are two parallel implementations of ~63 database functions:

| | `src/utils/dbUtils.ts` | `src/lib/db/repositories/*` |
|---|---|---|
| Lines | ~1065 | ~1030 across 4 files |
| Call sites | 55 | **0** |
| Pool | its own `new Pool()`, no HMR guard | `connection.ts`, HMR-safe |
| Schema targeted | `docker/schema.sql` (istid `VARCHAR` PK) | `docker/migrations/001_user_uuid.sql` (UUID PK) |

**The two halves target different database schemas.** The repositories were written against a
UUID identity migration that `docker-compose.yml` never applies. Wiring a repository up today
would throw `22P02 invalid input syntax for type uuid` against the live schema.

Consequences for you:
- **Do not assume a repository method works.** None of them have ever run.
- **Do not "just switch a call site over"** to a repository as a drive-by. It will break.
- Some repository versions contain *fixes* the dbUtils version lacks (an N+1 fix in `getUser`,
  a correct `getOrderByNumber`); some contain *bugs* dbUtils lacks (wrong column names). Diff
  the specific function before trusting either side.
- Resolving this — pick istid or UUID, then delete one half — is the highest-leverage
  architectural decision available. It is tracked on the board and needs a human decision.

Until it is resolved: **change `dbUtils.ts` when fixing live behaviour** (that is the code that
runs), and say so explicitly rather than silently editing the dead half.

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

Record things that future sessions cannot re-derive from the code:

- `docs/ai-workflow/problem-registry.md` — bugs: symptom, root cause, fix, regression guard.
- `docs/ai-workflow/decision-log.md` — decisions: what, alternatives, why.
- `docs/ai-workflow/architecture-notes.md` — current architectural state.

Update these when you learn something surprising. A bug that took an hour to diagnose and
is not written down will cost an hour again.

---

## 8. Known state and open questions

Things you should know before proposing work, so you don't "discover" them as new:

- **Open security issues.** A full audit found unauthenticated payment confirmation, an
  unauthenticated file upload, and an unauthenticated write into `.env`, among others. They are
  tracked as P0 board items. Treat anything under `api/shop/sumup/**`,
  `api/shop/uploads`, and `api/calendar/notion-webhook` as known-vulnerable until fixed.
- **Middleware authorizes from an *unverified* JWT** (`decodeJWTPayload` base64-decodes without
  checking the signature) and several server pages fetch privileged data without their own
  role check. Never rely on middleware as the only authorization layer — add
  `serverCheckRoles` in the page/route too.
- **No transactions exist anywhere.** `db_query` is `pool.query()`, so there is no way to
  express one. Every multi-statement operation in TypeScript is non-atomic by construction.
  The only atomicity comes from logic that happens to live entirely inside a `plpgsql` function.
- **No tests, no CI gates.** `.github/workflows/` only deploys. `deploy-staging.yml` fires on
  every push to `main` with no typecheck, lint, or build gate in front of it.
- **Two lockfiles**: `yarn.lock` and `package-lock.json` are both committed. Only one package
  manager can be authoritative. Upstream has since moved to **pnpm** — this needs a decision.
- **`node-cron` is in `devDependencies`** but imported by `src/lib/autoCancelScheduler.ts` at
  runtime — a `--production` install would crash at boot.
- **`src/utils/dbUtils.ts`** is still ~1065 lines and is the code that actually runs (see §4).
- **`xlsx`** is installed from a SheetJS CDN tarball URL, not the npm registry — it is outside
  normal audit/lockfile integrity tooling.
- **Uploaded product images go to `public/products`**, which is gitignored and lives inside the
  build directory — blue/green deploys can lose them.
- **Upstream has features the fork lacks**: a pg_notify/SSE voting system, Google service
  accounts loaded from env instead of JSON files, dinner-page work, and security dependency
  bumps. See `.claude/skills/upstream-sync/SKILL.md` before merging any of it.

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
