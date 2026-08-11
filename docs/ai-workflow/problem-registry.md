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
