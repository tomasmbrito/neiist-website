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
- **Regression test?** **Yes, as of #52 (PR #150)** — `src/utils/db/dbClient.test.ts`. The
  throwaway script described above was ported rather than replaced. Confirmed to actually guard:
  removing the aborted-`COMMIT` tag check turns `5 passed` into `1 failed | 4 passed`, and the
  failing test is the swallowed-error one.

---

## The database had no migration path — and never had one (#146, PR #148)

- **Symptom**: none, which is the point. A schema fix could be written, reviewed, merged, and
  never take effect on any database that already had data.
- **Root cause**: `docker/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, which
  Postgres runs **only when the data directory is empty**. Neither `deploy_prod.sh` nor
  `deploy_staging.sh` contained a `psql` step, a migration runner, or any database step at all.
  `docker/migrations/001_user_uuid.sql` was mounted nowhere and was deleted unapplied in #119.
- **Scope**: `docker/schema.sql` has been edited in **53 commits**. The same hole exists in
  `upstream/main`, so it is not a fork regression — neither side ever had one.
- **Consequence, still open**: `docker/schema.sql` describes what a *new* database gets. **It has
  never described production**, and production's real schema is unmeasured — it is whatever the
  file looked like when that volume was created plus anything typed into a `psql` session since.
- **Fix**: PR #148. `scripts/migrate.mts`, `docker/migrations/`, `neiist.schema_migrations`, and a
  migration step in both deploy scripts, after the build and before the restart.
- **Verified**: against a local database that predated the `schema.sql` edit — deliberately, since
  that is the situation production is in. `add_user(..., ARRAY['MEIC-A','MEIC-A'])` failed with
  `duplicate key ... user_courses_pkey` before, returned `{MEIC-A}` after one `yarn db:migrate`.
  Guard rails each exercised: checksum drift refused, a failing migration rolled back and not
  recorded, the advisory lock made a second runner wait, and both the missing-schema and
  missing-connection-string guards fired.
- **Why it is worth writing down**: the plan for #78/#79/#100 spent a section asking "who applies
  DDL to production?" and could not answer it. The answer was *nobody, ever*. A question a plan
  cannot answer about its own deployment is usually pointing at a missing mechanism, not a
  missing person.

---

## A blanket `catch` cancels the framework's control flow (#111, PR #149)

- **Symptom**: four pages needed `export const dynamic = "force-dynamic"` to render correctly,
  with no obvious reason why Next would not work it out.
- **Root cause**: Next signals control flow by **throwing** — `cookies()` outside a request scope
  throws `DynamicServerError` to mark a route dynamic, `redirect()` throws `NEXT_REDIRECT`,
  `notFound()` throws `NEXT_NOT_FOUND`, all carrying a `digest`. `serverCheckRoles` wrapped its
  body in a blanket `catch` that turned every throw into a 500 response. The signal never reached
  Next, so the route stayed a prerender candidate.
- **Fix**: re-throw anything carrying a string `digest` before the 500 fallback.
- **Verified by building with no database reachable** (the #106/#109 invariant), with a control:

  ```
  all four force-dynamic removed, with the fix -> FAILS on /shop
  three removed, with the fix                  -> PASSES, three routes now f (Dynamic)
  three removed, WITHOUT the fix               -> FAILS on /dinner    <- the control
  ```

  `/shop` keeps its directive because it is the only one that never touches the session: its
  only dynamism is a database read, which Next does not treat as a signal.
- **Still present, deliberately**: `src/app/layout.tsx:40-49` has the identical defect.
- **Why it is worth writing down**: "log and return a default" is normally good defensive style.
  In a framework that signals by throwing, it is a bug — and a silent one, because the fallback
  value is plausible. Any blanket `catch` in a Server Component path is now suspect.

---

## Bulk "Marcar como Pago" had never worked (#154, PR #161)

- **Symptom**: selecting orders and pressing "Marcar como Pago" did nothing, reported as
  `toast.warning("Aviso")` with no explanation.
- **Root cause**: `OrdersTable.tsx:474` PATCHes `{"status":"paid"}`;
  `src/app/api/shop/orders/[id]/route.ts:225` rejects `paid` outright, because a payment must go
  through `POST /pay` (the only path that records the reference, runs the after-purchase action
  and sends the receipt). Every order in the selection 400'd.
- **Why it mattered more than it looked**: it is the load-bearing button of the in-person payment
  flow. A SumUp payment finalizes itself; an in-person one waits for a manager. So managers were
  marking orders paid one at a time through the single-order overlay.
- **Second defect in the same flow**: `/pay` required `paymentReference` unconditionally, and
  `orderFinalization.ts` required one unless `payment_method === "cash"` — which rejected
  `in-person`, `mbway` and `transfer`, i.e. every manually-confirmed method. The endpoint rejected
  exactly the case it existed to serve.
- **Fix**: bulk routes to `POST /pay`; the reference is required only for the SumUp-backed
  methods, decided in SQL so every caller inherits one rule; the toast reports
  changed / already-in-state / rejected.
- **Why it is worth writing down**: it was invisible because the failure path was a generic
  warning toast. A bulk operation that reports one word for every outcome hides its own bugs —
  and this one hid for the entire life of the feature.
- **Regression test?** Yes — `src/utils/db/orderPayment.test.ts` covers the reference rule per
  payment method. The **UI** path is still unverified; a shop manager should press the button
  before a stand relies on it.

---

## `Promise.all` is not a concurrency test (found while writing #79's guard)

- **Symptom**: a new test named "gives exactly one winner when two callers finalize concurrently"
  passed. It also passed against a `finalize_paid_order` deliberately stripped of **both** the
  row lock and the conditional `UPDATE ... AND status = 'pending'` — i.e. against the original
  check-then-act defect it was written to catch.
- **Root cause**: `Promise.all([f(), f()])` issues two pool queries about a millisecond apart.
  The unguarded window between the status read and the write is microseconds wide, so the two
  never overlap. The test exercised sequential calls while reading like a race.
- **Fix**: hold a transaction open on a dedicated `pg.Client`, issue the second call while the
  first still holds the lock, and assert the second has **not settled** after 300 ms. That version
  fails against the broken function with `expected true to be false`.
- **Second finding, same investigation**: the first two mutation attempts could not break the test
  because atomicity there has **three** overlapping guards — the row lock, the status check, and
  the conditional `UPDATE`. Removing any one leaves the other two. Good defence in depth, and a
  trap for naive mutation testing.
- **Third finding**: the #100 cap race test had the same weakness for a different reason. It used
  a `limited`-stock fixture, and `new_order` takes `FOR UPDATE` on the product row for exactly
  that case (`schema.sql:2264-2267`), so the row lock serialised the test and the advisory lock
  was never exercised. Switching the fixture to `on_demand` — which is what jantar de curso, the
  only capped kind, actually is — made it a real guard.
- **Why it is worth writing down**: **a concurrency test that has never failed is not a guard.**
  Every one added since is checked by deliberately breaking the thing it protects, and the result
  is recorded in the PR. This is the practice, not a one-off.

## A client component pulled the `pg` driver into the browser bundle (2026-08-26)

**Symptom.** `yarn build` failed on `main` with seven `Module not found: Can't resolve 'dns'` and
`'fs'` errors, every one of them inside `node_modules/pg`. The only pointer to the actual cause was
a single filename in an otherwise unrelated list: `src/components/workspace/TeamEvents.tsx`.

**Root cause.** `TeamEvents` is a `"use client"` component. It imported `EVENT_VISIBILITY` and
`VISIBILITY_LABELS` — plain constants — from `src/utils/db/eventQueries.ts`. A `type` import is
erased at compile time; a **value** import is not. That one line pulled the whole module into the
browser bundle, and with it `db_query`, `pg`, and `pg`'s `dns` and `fs` requires. Introduced in
#219 and merged in #221.

**Why it was not obvious.** The two shapes are indistinguishable at a glance:

```ts
import { EVENT_VISIBILITY, type EventVisibility } from "@/utils/db/eventQueries";
//       ^^^^^^^^^^^^^^^^ bundles the data layer  ^^^^^^^^^^^^^^^^^^^ erased
```

**Fix.** Constants that both sides need live in `src/types/` — here `eventVisibility.ts`, which
imports nothing. `eventQueries` re-exports them so server code keeps one import.

**Regression guard.** `src/lib/clientBundle.test.ts` walks every file under `components/`, `app/`
and `context/` carrying a `"use client"` directive and fails on any non-`type` import of
`@/utils/db/*`. It also tests its own matcher against the four import shapes it must tell apart, so
a matcher that silently matched nothing cannot pass forever. Verified by reintroducing the original
import: the test fails.

**Lesson.** A rule in CLAUDE.md would not have caught this, because the shape that causes it reads
exactly like the shape that does not. Build failures that name only `node_modules` files are almost
always a bundling boundary being crossed — read the one `./src/...` line in the list first.
## A mutation that did not compile read as a surviving mutant (2026-08-27)

**Symptom.** Two mutations against migration 027 reported SURVIVED — the tests passed with the
guard removed — which would normally mean the tests are worthless. One of them was real. The other
was not.

**Root cause.** The mutation harness pipes the mutated migration into `psql -q -f` and then runs
the suite. It did not check whether the mutant *applied*. The M3 mutation deleted a CTE and left a
trailing comma before `SELECT`, so the migration failed with a syntax error, the function was never
replaced, and the suite ran against the **original**. Every test passed, and the report said the
guard was untested.

**Why this is worse than a plain false negative.** A broken mutant is indistinguishable from a
surviving one in the output, and it points the wrong way: it says "your test does not cover this",
which invites weakening or deleting a guard that was fine. The failure mode of a verification tool
is more dangerous than the failure mode of the thing it verifies.

**Fix.** The harness now captures psql's stderr and reports `MUTANT DID NOT APPLY` instead of a
test result when the mutated SQL errors. With the mutation rewritten to be syntactically valid, M3
died immediately.

**The genuine survivor it was hiding alongside.** M2 — dropping `AND e.visibility = 'members'` from
the promote — was real, and mattered: `members` is not just any visibility there, it is the specific
downgrade #210 applies to a page that was public in Notion. An event marked `teams` is internal on
purpose, and promoting it because a stale `activities` row shares its Notion id publishes an
internal event to every student.

**Lesson.** Verify the verifier. A mutation result is only evidence if the mutant actually ran —
check that the mutated code loaded before believing that a test failed to catch it.

## The app role read tables directly, and no test could see it (2026-08-27)

**Symptom.** `/workspace` returned 500 with `permission denied for table membership` for every
user, while all 566 tests passed.

**Root cause.** `docker/schema.sql:11-16` deliberately gives `neiist_app_user` no table
privileges: every access goes through a `SECURITY DEFINER` function. Four query functions added
across migrations 020-028 inlined SQL against a table instead — `isBoardSignatory` →
`membership`, `getOpenEdition` → `recruitment_editions`, `setEventVisibility` → `internal_events`,
`bookInterview` → `interview_slots`. Only the first was reachable from a page anyone had opened;
the other three were waiting on the recruitment form, the visibility menu and interview booking.

**Why the suite could not catch it.** **Every test in this repository connects as the OWNER.** A
query that reads a table directly therefore passes everything and fails only in the running app.
That gap is the real defect; the four queries are its symptoms. It is the same shape as the
concurrency lesson of 2026-08-19 — a test that cannot reproduce the condition proves nothing —
and the same shape as the client-bundle defect of 2026-08-26, where the failure only appeared in
a build.

**Fix.** Four `SECURITY DEFINER` functions in migration 029, and the call sites now invoke them.

**Regression guard.** `src/utils/db/appRolePrivileges.test.ts` is the only test file that connects
as the APP role. It does not scan source text — it asks Postgres what that role can do. Its final
assertion reads `information_schema.role_table_grants` as the owner, so the guard still works
where the app connection cannot be made. Verified by granting `SELECT` on `membership`, watching
it fail, and revoking.

**Lesson.** When a privilege model exists, at least one test must run under the restricted
identity. Testing as the owner tests a different system than the one that ships.
