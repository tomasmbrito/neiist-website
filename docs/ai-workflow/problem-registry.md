# Problem Registry

Bugs, issues, and unexpected problems encountered during development.
Each entry records root cause and fix for future reference.

| ID | Date | Problem | Root Cause | Fix | Regression Test? |
|----|------|---------|-----------|-----|-----------------|
| P001 | 2026-07-24 | `npm install` fails with ERESOLVE | Conflicting peer deps between eslint packages | Use `yarn install` instead (project uses Yarn) | N/A — workflow |
| P002 | 2026-07-24 | TypeScript errors for `react-markdown` and `node-cron` | Missing type declarations, node_modules not fully installed | Run `yarn install` to resolve all dependencies | `yarn type:check` |

### Google Auth Override & `base64url` Middleware Crash
- **Date**: 2026-07-24
- **Problem**: Users logging in with Google would successfully authenticate, but when navigating to protected routes (like `/profile`), they were automatically redirected and re-authenticated with Fenix.
- **Root Cause**: The Next.js `middleware.ts` was using the browser `atob()` function to decode JWT payloads in the `session` cookie. Because JWT payloads use `base64url` encoding (which includes `-` and `_`), `atob()` threw an exception. This exception was caught, `isAuthenticated` was evaluated as `false`, and the user was redirected to the Fenix login route (`/api/auth/login`).
- **Fix**: Updated `decodeJWTPayload` in `src/utils/authUtils.ts` to replace `-` with `+` and `_` with `/` (converting `base64url` to `base64`) before calling `atob()`. Also added explicit try-catch and debug info in the Google callback to surface backend exceptions in the URL (`/?error=internal_server_error&msg=...`).

### `yarn build` requires production secrets and a live database
- **Date**: 2026-08-11
- **Problem**: `yarn build` fails on a clean checkout with `Missing env: GOOGLE_CLIENT_SECRET_JSON` (first at `/api/user/sweats-contest`, then `/api/user/cv-bank`) and attempts a real Postgres connection during page-data collection.
- **Root cause**: several route handlers construct their Google Drive / pg clients at **module scope**. Next.js evaluates module scope while collecting page data at build time, so building requires credentials that only production has.
- **Fix**: not yet applied. Construct these clients lazily inside the handler. Tracked in #84.
- **Consequence**: `yarn build` cannot be used as a PR quality gate until this is fixed — handing a PR-triggered workflow real Google credentials would be exfiltratable. Use `type:check` + `lint` + `format:check` on PRs in the meantime.
- **Regression test?** None — no test runner exists (#52).

### `COMMIT` on an aborted transaction succeeds silently — so `catch { return null }` will eat a rollback

- **Date**: 2026-08-12
- **Problem**: latent, found while planning #80 rather than in production — but it would have made
  the first transaction written in this repo silently lose data.
- **Root cause**: two behaviours combining.
  1. Almost every function in `src/utils/db/*` follows the house pattern
     `try { ... } catch (e) { console.error(e); return null; }`.
  2. **Postgres lets you `COMMIT` an already-aborted transaction. It returns the command tag
     `ROLLBACK` and raises no error.**

  So inside a `withTransaction`: a statement fails → Postgres aborts the transaction → the `catch`
  swallows it and returns `null` → the callback does not throw → `withTransaction` runs `COMMIT` →
  Postgres discards everything and reports success. The caller sees a successful no-op.
- **Proven, not argued** (live dev database):

  ```
  BEGIN; CREATE TEMP TABLE probe(id INT PRIMARY KEY); INSERT INTO probe VALUES (1);
  INSERT INTO probe VALUES (1);   -- ERROR: duplicate key ... probe_pkey
  COMMIT;                         -- tag returned: ROLLBACK, no exception
  -- probe table gone; nothing was written; no error ever reached the client.
  ```

- **Fix**: applied in #80, in two layers.
  1. `createDiscountCode` now returns `null` **only** on SQLSTATE `23505` (the collision-retry
     signal) and rethrows everything else. The five product/variant functions never had a
     `try/catch`, so they were already safe.
  2. **`withTransaction` inspects the command tag that `COMMIT` returns and throws if it is
     `ROLLBACK`.** This is the layer that matters, because the other ~58 query functions in
     `src/utils/db/*` still swallow: if one of them is ever threaded into a transaction, the
     transaction now fails loudly instead of returning success with the writes discarded.
- **Verified**: without the tag check, `withTransaction` returned `"looked fine"` while the
  update vanished. With it, the same script gets
  `Transaction was already aborted at COMMIT, so every write in it was discarded`.
- **Why it is worth writing down**: the failure is invisible from the application side, and the
  instinct when adding transactions is to trust the existing query functions. It is the same shape
  as the `::VARCHAR(10)` truncation — the database silently does something reasonable-looking
  instead of erroring.
- **Regression test?** None committed — no test runner (#52). Verified with a throwaway script
  that compiled `dbClient.ts` standalone (it imports only `pg` and `node:async_hooks`) and ran it
  against the dev database: 10 assertions covering rollback, commit, the swallowed-error case, the
  `AsyncLocalStorage` tripwire and pool reuse. **This is the first thing to port to Vitest** — the
  script proves the behaviour once, a test would prove it on every change.
