# Problem registry

Bugs that cost real time to diagnose: **symptom**, **root cause**, **fix**, and the
**regression guard** (or the honest admission that there isn't one — this repo has no tests).

A bug that took an hour to diagnose and is not written down will cost an hour again.

This registry starts at the 2026-09-14 reset onto upstream v3.0.0. Entries from the previous
phase live in the archived fork (tag `archive/fase-1`) and describe code that no longer exists.

---

## Fixed, 2026-09-15 — kept for context

### The Notion webhook failed open

- **Symptom.** With the verification-token environment variable unset, every unsigned POST to
  `/api/calendar/notion-webhook` was accepted and processed.
- **Root cause.** `src/app/api/calendar/notion-webhook/route.ts:119` guarded the signature
  check behind `if (verificationToken)`. A missing configuration value disabled authentication
  rather than failing closed.
- **Fix.** Inverted to a guard clause: no token configured now returns `503` before any
  signature logic runs. See `docs/ai-workflow/audit-2026-09.md` P1-5, PR #278.
- **Guard.** None possible today — no test runner.

### Marking an order paid was two separate writes

- **Symptom.** A crash between the two writes could leave an order marked `paid` with no
  `payment_reference`, unreconcilable against SumUp.
- **Root cause.** `finalizePaidOrder` called `setOrderState(..., "paid")` and, in a separate
  call, `updateOrder(..., { payment_reference })` — two transactions, and the in-memory
  in-flight guard only held within one process, not across blue/green.
- **Fix.** Folded into one `plpgsql` function, `neiist.mark_order_paid`, with a `FOR UPDATE`
  lock. See `docs/ai-workflow/audit-2026-09.md` P2-5, PR #282. This is the pattern to copy for
  any other function found doing the same thing — not a general fix.
- **Guard.** None possible today — no test runner. Verified manually against the real local DB
  (see the PR); not verified through a real SumUp callback, which needs credentials this
  environment doesn't have.

## Known-open, carried from the reset

These are real defects in the current code. None is fixed; none has a guard.

### Deploy pins a Node version that disagrees with `.nvmrc`

- **Symptom.** Latent. `scripts/deploy_prod.sh:3` puts `node/v24.11.1` on PATH; `.nvmrc` pins
  `24.14.0`.
- **Root cause.** The build moved to GitHub Actions (which honours `.nvmrc`) without the server
  script being updated. The server now only runs the artifact, so the mismatch has not bitten —
  but nothing keeps the two in step, and native modules are version-sensitive.
- **Fix.** Read the version from `.nvmrc` in the deploy script instead of hardcoding it.
- **Guard.** None.

---

## Environment traps (not code bugs, but they cost the same hour)

### `psql < file` hides errors — always use `psql -f`

Reading SQL from **stdin** makes `psql` print `ERROR:` with no `psql:` prefix, so the usual
`grep '^psql.*ERROR'` matches nothing and a broken schema file looks clean. Cost an hour on
2026-08-26. The throwaway-database recipe in `CLAUDE.md` §2.8 uses `-f` for this reason.

### `pnpm db:reset` destroys unrecoverable data

It drops the `neiist_db` volume: imported data, demo data and the logged-in account all go, and
none of it can be rebuilt from this repository. Done by accident on 2026-08-27, destroying a
completed Notion import. To validate `docker/schema.sql`, build a throwaway database instead.

### `pnpm build` fails without a database, and the failure looks like a code bug

- **Symptom.** `Build error occurred / Failed to collect page data for /[locale]/shop/[id]`,
  preceded by a `DatabaseError("Ocorreu um erro inesperado na base de dados.", 500)` pointing at
  `src/lib/db/errorMapper.ts:89`. Looks like a broken build; is not.
- **Root cause.** `src/app/[locale]/shop/[id]/page.tsx:11` exports `generateStaticParams()`,
  which queries Postgres. Next runs it while collecting page data, so the build needs a
  reachable database. With Docker down, nothing is on 5432.
- **Fix.** Start the database before building. Not a code change.
- **Worth knowing.** This is why `ci.yml` has no build job. `deploy-prod.yml:62-80` builds by
  opening an **SSH tunnel to the production database** and pointing `DATABASE_URL` at
  `127.0.0.1:5432` through a `neiist_readonly` role. So a production deploy reads live
  production rows at build time — anything added to `generateStaticParams` runs against real
  data during every release.
- **Guard.** None. Verified by hand on 2026-09-14.

### Port 5432 must be free before `pnpm dev`

If another Postgres holds the port, the container starts without publishing its own and the app
silently connects to the *other* database. The symptom is data that is inexplicably wrong or
missing rather than a connection error. Check the port before debugging the data.

### Corepack cannot launch pnpm 12

Corepack (as shipped with Node 24.11.1, and 0.36.0) looks for `bin/pnpm.cjs`; pnpm 12 ships
`bin/pnpm.mjs`. The result is an opaque `MODULE_NOT_FOUND` naming a file inside
`~/.cache/node/corepack/`, which looks like a corrupted download and is not — clearing the cache
and re-downloading changes nothing. Fix: `npm i -g --force pnpm@12.3.4`.

### A live-tested database can carry duplicate function overloads from the archived fork

- **Symptom.** `function neiist.set_order_state(unknown, unknown, unknown) is not unique`
  (Postgres `42725`) when calling a function that plainly exists in `docker/schema.sql` with
  that exact signature. Also seen for `add_product`, `add_valid_department_role`, and
  `update_valid_department_role` (the last of which doesn't exist in current `schema.sql` at
  all — both its overloads were pure leftovers).
- **Root cause.** A different failure mode of the same trap as the two entries above: a local
  database whose data directory predates the 2026-09-14 reset still has function overloads
  from the archived old-fork schema (an optimistic-concurrency `set_order_state` with a 4th
  `p_expected_status` arg, an audit-trailed `add_valid_department_role` with a `u_actor_istid`
  arg, an old 9-arg `add_product` before `order_start`/`estimated_delivery`/`size_guide` were
  added). Unlike the "cannot change return type" case, a **different argument list** doesn't
  conflict with `CREATE OR REPLACE FUNCTION` — Postgres treats it as a distinct overload, so
  applying `schema.sql` standalone adds the new signature *alongside* the stale one instead of
  erroring. The ambiguity only surfaces later, at call time, when Postgres can't pick a best
  candidate.
- **Fix.** Not a code change. Found every duplicate with:
  ```sql
  SELECT n.nspname, p.proname, COUNT(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'neiist' GROUP BY 1,2 HAVING COUNT(*) > 1;
  ```
  then for each, compared `pg_get_function_identity_arguments(oid)` against the signature in
  `docker/schema.sql`, and `DROP FUNCTION` the one that didn't match (or, for
  `update_valid_department_role`, both — it isn't called from `src/` at all). Confirmed via
  `grep` that nothing in `src/` calls the dropped signature before dropping it.
- **Worth knowing.** The systematic table/column diff done for the two entries above does not
  catch this — it only compares column lists, not function overload sets. If a database has
  ever run an older `schema.sql`, run the duplicate-overload query above before trusting that a
  table/column diff alone proves the database is current.
- **Guard.** None. Verified by hand on 2026-09-15 while live-testing PR #281 with a real
  Fenix-authenticated session — `POST /api/shop/orders/:id/pay` was the first call in this
  session to hit the ambiguous `set_order_state`, since the atomic-payment rewrite (#282) that
  replaced it isn't merged to `main` yet.

### The local dev database carried a whole orphaned old-fork recruitment subsystem

- **Symptom.** Creating `neiist.recruitment_editions`/`applications`/`application_teams` for the
  new recruitment feature hit `relation "recruitment_editions" already exists` and, worse,
  `cannot change return type of existing function` for `get_open_recruitment_edition()` — a
  function this session had not written yet.
- **Root cause.** The local dev database predates the 2026-09-14 reset and still carried the
  **entire old-fork recruitment pipeline**: tables `recruitment_applications`,
  `recruitment_application_teams`, `recruitment_application_approvals`,
  `recruitment_decision_notifications`, `recruitment_onboarding`, `interview_slots`,
  `interview_invites`, plus **29 functions** (interview booking, dual-approval, onboarding
  tokens, decision-notification queueing) and 3 triggers, all from the old fork's
  `archive/fase-1:.claude/plans/recruitment-and-onboarding.md`. `recruitment_editions` itself
  also pre-existed, with an old shape missing the `created_by` column this round's design adds.
  None of it is a duplicate-signature case like the earlier finding — these are genuinely
  different tables/functions from a different, larger feature that was fully built in the old
  fork and never removed when the fork was reset onto upstream.
- **Fix.** Not a code change. Verified every old object was unreferenced by current `src/` or
  `docker/schema.sql` (`grep`, both by name and by function body via
  `pg_get_functiondef(oid) ILIKE '%old_table_name%'` to catch functions that reference a table
  without the table's name appearing in the function's own name) and that all the tables were
  empty (`SELECT COUNT(*)`), then dropped the triggers, the 29 functions (signatures generated
  programmatically from `pg_get_function_identity_arguments` to avoid a hand-typed mismatch),
  and the 7 orphaned tables inside one transaction, then `ALTER TABLE ADD COLUMN` for
  `recruitment_editions`. Re-applied this round's schema cleanly afterward — zero errors, zero
  duplicate overloads anywhere in the schema (checked with the query from the entry below).
- **Worth knowing — this is bigger than recruitment.** The same local database also has
  `internal_events`, `tasks`, `requirements`, `event_plans` and their triggers — the rest of the
  old fork's members-only workspace, equally orphaned, equally unreferenced by current code.
  Left alone for now (out of scope for the recruitment work), but the same cleanup — confirm
  unreferenced, confirm empty, drop in dependency order — applies whenever someone touches that
  area next. **A database created before the reset is not just "maybe has stale function
  signatures" (the earlier two entries) — it may have entire orphaned feature subsystems.** Run
  `\dt neiist.*` and eyeball for table names that don't appear in current `docker/schema.sql`
  before trusting a local database is clean.
- **Guard.** None. Verified by hand on 2026-09-16 while building the recruitment schema.
- **Update, same day.** The recruitment subsystem turned out to be the tip of it — see the next
  entry. The local database's whole `internal_events`/`tasks`/`requirements`/`event_plans`
  workspace was also still there, and has now been removed too.

### The local dev database also carried the entire old-fork members-only workspace

- **Symptom.** `comm -13 <(schema.sql tables) <(actual tables)` — comparing every
  `CREATE TABLE` in current `docker/schema.sql` against `pg_tables` for the `neiist` schema —
  listed 18 tables with no definition anywhere in current code:
  `event_attendees`, `event_collaborating_teams`, `event_documents`, `event_locations`,
  `event_plan_collaborators`, `event_plan_externals`, `event_plan_todos`, `event_plans`,
  `event_relations`, `internal_events`, `requirement_brief_fields`, `requirement_checklist`,
  `requirement_deliverables`, `requirements`, `task_assignees`, `tasks`,
  `team_access_grants`, `team_links`.
  65 functions and 5 triggers referenced them.
- **Root cause.** The same class as the entry above, at the scale of the *whole* archived
  members-only workspace (`CLAUDE.md` §0/§8), not just recruitment: events/meetings, the
  requerimentos checklist system, tasks, and per-team link/access-grant tables from
  `archive/fase-1`, never dropped when the local database's data directory carried forward
  across the 2026-09-14 reset.
- **The difference from every other entry here: four of these tables had real data**, not just
  orphaned schema. `internal_events` (14 rows), `event_attendees` (59), `event_locations` (20),
  and `event_collaborating_teams` (4) — every `internal_events` row had a `notion_page_id`,
  meaning this was a genuine historical Notion import (Dev-Team and Direção meeting records),
  not seed/test data. Asked Tomás before touching it rather than assuming it was disposable.
  Exported with `pg_dump --table=...` for all four to
  `~/Downloads/neiist-old-workspace-events-backup-2026-09-16.sql` (kept outside the repo —
  `event_attendees` ties real istids to real people, not something to commit to a fork), row
  counts verified against the dump before deleting anything.
- **Fix.** Not a code change. Confirmed all 18 tables and all 65+5 functions/triggers were
  unreferenced by current `src/`/`docker/` (function bodies searched via
  `pg_get_functiondef(oid) ILIKE '%table_name%'`, table names searched with plain `grep`),
  confirmed which tables had real rows, exported those, then dropped triggers → functions →
  tables (`CASCADE`, since `tasks`/`requirements` had FKs into `internal_events`) inside one
  transaction with `-v ON_ERROR_STOP=1`.
- **Verified.** `comm -13` re-run after cleanup: zero tables left that aren't in
  `docker/schema.sql`. Zero duplicate function overloads anywhere in the schema. Real data
  intact (31 users, 31 memberships, 0 orders — matches pre-cleanup counts). A fresh-database
  build (`schema.sql` + `init.sql`) still succeeds with no new errors. `pnpm dev` + live browser
  check of `/about-us` (renders the renamed teams and their descriptions correctly, confirming
  neither the department rename nor this cleanup regressed anything), `/voting` (correctly
  redirects to Fenix login, proving route protection still works), and `/shop` (loads, no
  console errors).
- **Worth knowing.** `pnpm build` (not `pnpm dev`) failed separately during this check with
  `all generateStaticParams functions must return at least one result` at
  `src/app/[locale]/shop/[id]/page.tsx:11` — **unrelated to this cleanup**, caused by
  `neiist.products` being empty (every test product from earlier sessions was cleaned up per
  this repo's own "leave no test data behind" rule) under `cacheComponents`. A stricter variant
  of the already-documented "`pnpm build` needs a live database" trap below: it needs a
  database with *data in the right shape*, not just a reachable connection. `pnpm dev` doesn't
  hit `generateStaticParams` at all, which is why the live-browser check above still worked.
- **Guard.** None. Verified by hand on 2026-09-16.

### `pnpm build` fails with `DB Broadcaster Connection Error` for a function that exists

A local dev database created before a given function landed in `docker/schema.sql` doesn't
have it — `schema.sql` only runs on an empty data directory (see `CLAUDE.md` §4), so anything
added to it after that database's first boot is invisible locally until applied by hand.
Surfaced as `dbBroadcaster.ts` looping `function neiist.listen_voting_updates() does not
exist` during `pnpm build`/`pnpm dev`, even though that exact function is right there in the
file. Not a code bug — the function needs applying to *this* database once, the same
standalone-`CREATE OR REPLACE FUNCTION` technique documented in `CLAUDE.md` §4 for
`mark_order_paid`.
