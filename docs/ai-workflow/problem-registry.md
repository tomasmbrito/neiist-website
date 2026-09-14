# Problem registry

Bugs that cost real time to diagnose: **symptom**, **root cause**, **fix**, and the
**regression guard** (or the honest admission that there isn't one — this repo has no tests).

A bug that took an hour to diagnose and is not written down will cost an hour again.

This registry starts at the 2026-09-14 reset onto upstream v3.0.0. Entries from the previous
phase live in the archived fork (tag `archive/fase-1`) and describe code that no longer exists.

---

## Known-open, carried from the reset

These are real defects in the current code. None is fixed; none has a guard.

### The Notion webhook fails open

- **Symptom.** With the verification-token environment variable unset, every unsigned POST to
  `/api/calendar/notion-webhook` is accepted and processed.
- **Root cause.** `src/app/api/calendar/notion-webhook/route.ts:119` guards the signature check
  behind `if (verificationToken)`. A missing configuration value disables authentication rather
  than failing closed.
- **Fix.** Reject when the token is absent. An unconfigured webhook should be inert, not open.
- **Guard.** None possible today — no test runner.

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
