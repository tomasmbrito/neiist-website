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

---

## Internal events (#129, Phase 1) — 2026-08-23

The first Notion material in the database. Five tables under `neiist.internal_events`, read and
written only through `src/utils/db/eventQueries.ts`.

**Two invariants, both structural rather than conventional:**

1. **No row-returning function reads `internal_events` without a department parameter or
   `WHERE is_public`.** Pinned by a test that introspects `pg_proc`, because the mistake it guards
   against is a function that *does not exist yet* — someone adding `get_all_events()` for a
   dashboard and forgetting the filter. That passes every behavioural test, since the function is
   new. Verified by writing the leaky function and watching the test name it.
2. **Every read and write is keyed by event id AND department.** An id is the one thing a client
   fully controls, so a mismatched pair returns nothing at the query rather than relying on the
   route to compare owners afterwards.

Authorization is `canForTeam`, never a bespoke check. Two permissions, not one: members may call
their team's **meetings** (matching what Notion allows today), coordinators run **events**, and
publishing is a third permission again. All three are on `GRANTABLE_TEAM_PERMISSIONS` — decided
2026-08-23, with the accepted consequence that **a published event outlives the grant that created
it**.

The multi-table write is one plpgsql function rather than `withTransaction`: a single call is
already one implicit transaction, and it never has to defend against the ~58 query functions that
still `catch { return null }`.

**Slice C (2026-08-23)** made `/activities` read the database. Two readers were added, and they
are the two shapes the introspection guard permits:

- `get_public_internal_events()` — no department, and therefore `WHERE is_public` is its **entire
  authorization**, since anyone can call it. It also excludes `kind = 'meeting'`: not a security
  control, but nothing wants a coordination meeting on the students' calendar and the mistake is
  one checkbox away.
- `get_member_internal_events(istid)` — scoped through `get_user_team_scopes`, so grants work with
  no code mentioning them.

The two public sources are merged in the **adapter**, not in SQL: the Notion sync deletes rows it
does not recognise, and a UNION view would put workspace events in its path. Workspace ids are
prefixed `workspace-` because `neiist.activities` ids are Notion page ids.

`src/utils/notion/internalEvents.ts` (#127) is deleted — superseded, and narrower now by design.
The Notion → `activities` sync stays until Phase 10 (#137). Google Calendar (slice D) is untouched.
