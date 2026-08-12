# Architecture Notes

Key architectural patterns and conventions in the NEIIST Website codebase.

## Database Access Pattern
- Single `pg.Pool` instance in `src/utils/dbUtils.ts` — **the only data layer** since
  2026-08-12, when the dead `src/lib/db/repositories/*` half was deleted (see the decision log).
- **Identity is `istid`** (`VARCHAR(10)` primary key). There is no UUID migration.
- All queries use parameterized SQL (`$1, $2, ...`).
- DB rows are mapped to TypeScript interfaces via mapper functions.
- Schema is defined in `docker/schema.sql` under the `neiist` schema.
- Schema uses a dedicated `neiist_app_user` role for application access.
- **No transactions.** `db_query` wraps `pool.query()`, so nothing can issue `BEGIN`. Any
  atomicity comes from logic living entirely inside a `plpgsql` function. Multi-table writes
  in TypeScript (orders, payments, stock, discounts) are non-atomic by construction.
- Planned: adopt the upstream `src/utils/db/{dbClient,errorMapper,*Queries}.ts` split rather
  than growing `dbUtils.ts` further. That split does not add transactions either.

## Authentication and authorization
- Fenix OAuth flow via `src/utils/authUtils.ts`; callback at `/api/auth/callback`.
- Session is a signed JWT in a cookie.
- **Two independent layers, by design:**
  1. `src/middleware.ts` — verifies the signature with `verifyJwtEdge` (jose, Edge-safe) and
     applies route rules. Rules are consulted most-privileged first, *before* the public prefix
     match, so a privileged path nested under a public one is not swallowed.
  2. `requireRoles()` / `serverCheckRoles()` in `src/utils/permissionUtils.ts`, called by each
     privileged page and route **before** any data fetch.
- Middleware is an optimisation, never the only boundary. Both `/shop/manage` and `/shop/pos`
  were reachable publicly because they relied on it alone.
- Known defect: `serverCheckRoles` has a blanket `catch` that swallows Next's
  `DynamicServerError` control signal (#111).

## Deployment
- Blue/green deployment via PM2 on production server.
- GitHub Actions workflows trigger on release (prod) or push to staging branch.
- SSH-based deployment scripts in `scripts/`.

## Key Integration Points
- **Notion API**: Calendar events sync (`@notionhq/client`).
- **Google Calendar**: Service account integration (`googleapis`).
- **Google Drive**: File uploads (CVs, sweats photos).
- **SumUp**: Payment processing for shop.
- **Nodemailer**: Email sending via SMTP.
