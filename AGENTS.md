# AGENTS.md — NEIIST Website

> Context file for agent runtimes other than Claude Code (Antigravity, Gemini, Codex, …).
> **`CLAUDE.md` is the long form and the source of truth.** This file is the condensed
> mirror: the facts you cannot get wrong. If you change a rule here, change it there too.

## 1. Project overview

**NEIIST Website** — the web platform of NEIIST (Núcleo Estudantil de Informática do IST),
the Computer Science student association at Instituto Superior Técnico, Lisboa. It handles
**real money** (SumUp payments) and **real personal data**. Production software.

- **Version** 3.0.0 · **Next.js 16.3.4** (App Router) + **React 19.2.8** + **TypeScript 6** (strict)
- **Node 24.14.0** (`.nvmrc`) · **pnpm 12.3.4** (pinned in `package.json#packageManager`)
- **pnpm workspace**: the app at the root, the `@neiist/ui` design system in `packages/ui`
- **PostgreSQL 15**, raw SQL through `pg` — **no ORM**, 80 SQL functions in `docker/schema.sql`
- **i18n**: every user-facing page lives under `src/app/[locale]/`; strings in `src/i18n/locales/{pt,en}.json`
- **No Zod**, **no tests**, **no transactions**, **no migration runner** — see §4
- Deploy: build on GitHub Actions → tarball over SSH → PM2 blue/green. Releases by release-please.

### 2026-09-14 — the fork was reset

`main` was reset to `upstream/main` at v3.0.0, discarding ~130 commits of fork-only work. That
work is archived at tag `archive/fase-1`, branch `archive/old-fork`, and ~72 branches on
`origin`. **Treat the archive as read-only history.** Do not assume any of its abstractions
exist here — a members-only workspace, Zod schemas, `withTransaction`, `docker/migrations/`
and team-scoped permissions all belonged to it and are gone.

## 2. Non-negotiable rules

1. **Never** read, print, edit, or commit secrets — environment files, service-account keys,
   OAuth client secrets, token caches, private keys, PATs, passwords, connection strings,
   API keys. Never create an environment file with real values; the example file takes
   placeholders only.
2. **Never** push, open a PR, or merge to `upstream` (`neiist-dev/neiist-website`). It is
   fetch-only. All work goes to `origin` (`tomasmbrito/neiist-website`).
   `gh pr create` defaults to the parent repo on a fork — always pass
   `--repo tomasmbrito/neiist-website`.
3. **Never** commit directly to `origin/main`. Branch, then PR on the fork.
4. **Always** run `pnpm type:check`, `pnpm lint` and `pnpm format:check` before claiming work
   is done, and paste the real output. "It should compile" is not evidence.
5. **Never** report a task complete when a gate failed. Say what failed, with the output.
6. **Never** weaken a check to make it pass — no `any`, no `@ts-expect-error`, no
   `eslint-disable`, no deleted assertion. Fix the cause or report the blocker.
7. **Never run `pnpm db:reset`** on the developer's database — it drops the volume and the
   data is not recoverable from this repo. To validate `docker/schema.sql`, build a throwaway
   database instead (recipe in `CLAUDE.md` §2.8), and use `psql -f`, never `psql < file`.
8. **Never** deploy or run destructive commands without explicit human approval.

## 3. Commands

```bash
pnpm install --frozen-lockfile
pnpm dev                    # docker postgres + next dev --turbopack
pnpm build
pnpm next typegen           # CI runs this before type:check (next-env.d.ts is gitignored)
pnpm type:check             # gate
pnpm lint                   # gate
pnpm format:check           # gate
pnpm --filter @neiist/ui dev    # design-system playground
```

Baseline on a fresh checkout: all three gates clean. CI runs only those three — **there is no
build job and no test job**, so `pnpm build` is your responsibility.

**`pnpm build` needs a live database.** `src/app/[locale]/shop/[id]/page.tsx` has a
`generateStaticParams()` that queries Postgres, so with nothing on port 5432 the build dies with
`Failed to collect page data for /[locale]/shop/[id]` — an environment failure, not a code bug.
CI has no build job for this reason; `deploy-prod.yml` builds through an **SSH tunnel to the
production database**, which also means a release reads live production rows at build time.

## 4. What does not exist (do not claim otherwise)

- **No tests and no test runner.** Do not claim coverage. Adding one needs approval.
- **No `withTransaction` helper** — but atomicity lives in `plpgsql` and mostly it is there.
  Every repository function is a single SQL call, and the 80 functions in `docker/schema.sql`
  each run in their own transaction. `neiist.new_order` takes `FOR UPDATE` locks before checking
  stock, so **order placement and stock decrement are not racy** — do not claim otherwise. The
  real gap is TypeScript sequencing two SQL calls, as `finalizePaidOrder` does. Keep multi-step
  writes inside one SQL function.
- **No migration path.** `docker/schema.sql` runs only on an empty data directory; there is no
  `docker/migrations/` and no `psql` step in either deploy script. Editing `schema.sql` does
  **not** change production, whose real schema is unmeasured.
- **No Zod.** Validation is hand-rolled in `src/utils/apiValidationUtils.ts`.

## 5. Where things live

```
src/app/[locale]/   25 pages (locale-scoped)      src/app/api/   43 route handlers (not locale-scoped)
src/lib/auth.ts     requireUser / requireRoles    src/proxy.ts   edge: rate limit, JWT, routing, headers
src/lib/db/connection.ts   the pg pool + db_query
src/lib/db/repositories/   user · team · shop · event · voting   <- the data layer
src/lib/security/          jwt · permissions · routePermissions · rateLimit* · securityHeaders
src/lib/google/            calendar · drive · serviceAccount
src/utils/shop/            order finalization, discounts, auto-cancel, status
packages/ui/src/components  the design system — check here before writing a primitive
config/                    eslint · prettier · lint-staged · commitlint configs
docs/ai-workflow/          project memory (how-neiist-works.md first)
```

**Authorization is two-layered and must stay that way**: `src/proxy.ts` on the Edge *and*
`requireRoles()` inside each privileged page. The proxy is an optimisation, not a boundary.
Roles are a flat hierarchy in `src/types/user.ts`: admin 100 > coordinator 80 >
shop_manager 60 > member 40 > guest 0.

## 6. Conventions

- Parameterised SQL only (`$1, $2`). String interpolation into SQL is a blocking defect.
- Reuse `@neiist/ui` before writing any primitive. Colours come from its CSS tokens.
- Server Components by default; `'use client'` only for hooks/browser APIs/event handlers,
  pushed as far down the tree as possible.
- New user-facing copy goes into **both** `pt.json` and `en.json`. Portuguese first.
- No `any` — use `unknown` + narrowing. Types in `src/types/`.
- Filenames are lint-enforced: PascalCase in `components/`, camelCase in `app/api/`.
- `console.log` is a lint error; `console.warn` / `console.error` are allowed.
- **Conventional Commits**, enforced by commitlint via husky and consumed by release-please.
  `!` or `BREAKING CHANGE:` cuts a major release — mean it. Do not use `--no-verify`.

## 7. Stop and ask a human when

a secret or production credential is needed · the change touches `docker/schema.sql`, auth,
permissions or SumUp · a dependency must be added or upgraded (a test runner and Zod both
count) · a push to `upstream` or a production deploy would be involved · the work has grown
beyond what was agreed · the change would re-introduce a large fork-only architecture ·
or two reasonable readings of the request would produce materially different work.
