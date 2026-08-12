# Plan: #80 — transaction support and a single hardened connection pool

**Status: proposal, awaiting Tomás's approval. No application code written yet.**

#80 is the keystone of the order-integrity batch. #78, #79 and #100 are all "make this
multi-statement operation atomic", and none of them is *expressible* today: `db_query` is
`pool.query()`, which takes an arbitrary pooled connection per call, so nothing can issue
`BEGIN`. This plan builds the mechanism and converts the two operations named in #80's
acceptance criteria. It deliberately does **not** change order or payment behaviour — that is
#78/#79/#100, and those need schema approval.

---

## 1. Verified current state (read at `main` = `aab9d38`, after #142)

Corrections to #80's body, which was written before #119 and #142:

- **The "two pools" half of #80 is already fixed.** `src/lib/db/connection.ts` no longer exists;
  it went with the dead repository layer in #119. `grep -rn "new Pool"` over `src/` returns
  exactly one hit: `src/utils/db/dbClient.ts:3`. What remains of that half is the HMR leak, the
  missing config, and the missing error handler.
- **#80's body says to add `withTransaction` to `src/lib/db/connection.ts`.** That file is gone.
  It goes in `src/utils/db/dbClient.ts`, which is where the pool now lives and which the other
  four modules already import.
- **`src/utils/dbUtils.ts` no longer exists** (#142). All line references in #80's body that
  point at it are stale.

`dbClient.ts` in full today — 17 lines, no config, no HMR guard, no `pool.on("error")`:

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db_query = async <T extends QueryResultRow>(text, params) => {
  try { return await pool.query<T>(text, params); }
  catch (error) { console.error("Database query error:", error); throw error; }
};
```

Blast radius: 5 files import `db_query` directly; 59 import from `src/utils/db/*`.
`grep -rn "BEGIN\|COMMIT\|ROLLBACK" src/` → nothing.

### 1.1 The obstacle that makes this more than plumbing

**The house `catch { console.error(...); return null; }` pattern silently defeats a
transaction.** `shopQueries.ts` has 5 such returns; `userQueries.ts` swallows in every function.

The sequence, if a swallowing function is threaded into a transaction:

1. Its statement fails. Postgres puts the transaction in the aborted state.
2. The `catch` swallows it and returns `null`, so `fn` does **not** throw.
3. `withTransaction` therefore reaches `COMMIT`.
4. **`COMMIT` on an aborted transaction succeeds and returns the command tag `ROLLBACK`.** No
   error reaches the client. The writes are discarded and the application is told nothing.

Step 4 proven against the live database rather than argued:

```
BEGIN
CREATE TABLE
INSERT 0 1
-- induce the error a swallowing query function would hide:
ERROR:  duplicate key value violates unique constraint "probe_pkey"
-- a swallowing catch returns null here, so the code proceeds to COMMIT:
ROLLBACK          <- the tag COMMIT returned. No exception was raised.
 probe_table_still_exists
                        0
```

So: **any query function threaded into a transaction must propagate its errors.** This is a
hard prerequisite, not a cleanup. Checked per function:

| Function | Propagates? |
|---|---|
| `updateProduct`, `addProductVariant`, `updateProductVariant`, `deleteProductVariant`, `getProduct` | yes — no `try/catch`. Safe to thread as-is. |
| `createDiscountCode` | **no** — swallows everything and returns `null`. Must be fixed first. |

---

## 2. The change, in five steps

### Step 1 — harden the pool (`dbClient.ts`)

Independent of transactions and the highest value-per-line in the PR.

- Cache the pool on `globalThis` so a turbopack HMR reload reuses it instead of leaking a new
  pool per edit. This is what the deleted `src/lib/db/connection.ts` existed to do.
- `pool.on("error", ...)`. **Without this an error on an idle pooled client is an unhandled
  `error` event and terminates the Node process.** Today there is no handler.
- Explicit `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `statement_timeout`.
  Proposed: `max: 10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`,
  `statement_timeout: 15_000`.

> `statement_timeout` is the one setting here that can break working code, because it is global
> to every connection. Nothing I found in `src/` looks like it legitimately runs >15s, but that
> is an inspection, not a measurement. **Flagging for your call** — it can be raised, or set
> per-transaction instead of pool-wide.

### Step 2 — `Querier` + `withTransaction`

```ts
export type Querier = <T extends QueryResultRow>(
  text: string, params?: unknown[]
) => Promise<QueryResult<T>>;

export const db_query: Querier = /* pool-backed, signature unchanged */;

export async function withTransaction<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
```

`db_query`'s exported signature does not change, so all 59 importers keep working untouched.

Two details that implementations of this routinely get wrong, and that I will get right:

- **`ROLLBACK` goes in its own `try/catch`.** If the connection is already dead the `ROLLBACK`
  throws, and an unguarded one replaces the real error with a meaningless one.
- **`client.release(err)` on failure**, not bare `release()`, so a poisoned connection is
  destroyed instead of handed to the next request. `release()` in a `finally` either way.

### Step 3 — thread only what the conversions need

Add an optional trailing `q: Querier = db_query` to **6** functions: the five product/variant
functions above plus `createDiscountCode`. The other ~58 stay exactly as they are. Widening
later is mechanical and should happen per operation that needs it, not speculatively.

### Step 4 — make `createDiscountCode` propagate

Currently one `catch` covers both "the random 6-char code collided" (expected, the caller
retries up to 5×) and "the database is broken" (must abort). Narrow it: on SQLSTATE `23505`
(unique violation) return `null` — that is the retry signal `createCodeForRecipient` wants — and
rethrow everything else. Kept local to the function; this does **not** reopen the `errorMapper`
reconciliation in #143.

### Step 5 — convert the two operations in #80's acceptance criteria

**`PUT /api/shop/products/[id]`** (`src/app/api/shop/products/[id]/route.ts:26-95`) — today
`updateProduct` + N deletes + N upserts is `1 + 2N` statements in `1 + 2N` separate transactions.
Wrap all of it in one `withTransaction`. `getProduct` moves *after* the commit, so the client is
handed committed state.

**`POST /api/shop/discounts`** (`src/app/api/shop/discounts/route.ts:72-115`) — today the loop is
`create code → send email → create code → send email`. Invert it: generate and commit **every**
code inside one `withTransaction`, then send the emails after it returns.

> **Emails must never be inside the transaction.** An SMTP round-trip would hold a pooled
> connection open for its whole duration, and no `ROLLBACK` can unsend a delivered email.
>
> Consequence to state plainly in the PR: with codes committed first, an SMTP failure leaves a
> valid code that nobody was told about. That is the correct direction for this trade — an
> unsent code is recoverable, an email promising a code that does not exist is not — and the
> response already reports `failed_recipients`. The current code has the *same* exposure plus a
> worse one: a crash mid-loop leaves half a campaign with no record of who was emailed.

### Step 6 (recommended, your call) — make the footgun loud

Explicit threading has one silent failure mode: forget to pass `q`, and that statement runs on a
different pooled connection *outside* the transaction. No error, wrong atomicity — the same
shape of bug as the `VARCHAR(10)` truncation, and invisible for the same reason.

~15 lines fix it: `withTransaction` marks the async context with `AsyncLocalStorage`, and
pool-backed `db_query` checks it — if a transaction is open in the current context, a pool query
is a threading mistake. Throw in development, `console.error` in production.

I recommend including it. It catches every missed thread the first time the code path runs,
which in a repo with no test runner is the only place it would be caught at all.

**The tempting alternative — using `AsyncLocalStorage` to make transactions *implicit*, so all
64 functions join automatically — should be rejected.** `getUser` fires its role-order queries
with `Promise.all` (`userQueries.ts:90`); a single `pg` client cannot run concurrent statements,
so under implicit ALS that path would break the moment it ran inside a transaction.

---

## 3. Out of scope

- #78, #79, #100 — behaviour changes needing schema approval. This PR only makes them expressible.
- The other ~58 query functions.
- `errorMapper` reconciliation (#143).
- Order finalization / SumUp (that is #79 — payment code, needs approval).

## 4. Verification plan

Gates: `yarn type:check && yarn lint && yarn format:check && yarn build`, output pasted.

Against the live database:
- **Induced-failure rollback.** Force a throw between the variant deletes and the upserts on the
  product PUT; assert the product row *and* every variant are byte-identical to before. This is
  #80's third acceptance criterion and it is the one that proves the mechanism.
- Re-run the aborted-`COMMIT` probe from §1.1 to show `createDiscountCode` now propagates
  instead of producing a silent no-op.

Manual: edit a product with variants through `/shop/manage`; generate a 2-recipient campaign and
confirm 2 codes committed and 2 emails sent.

**What this will NOT verify, and must be said in the PR:**
- Behaviour under real concurrency. A single-process manual test cannot exercise the interleavings
  #78/#79/#100 are about.
- Pool `max: 10` and `statement_timeout` under production traffic. Both are judgement calls.
- Real SMTP delivery.
- There are still no automated tests (#52). The gates prove compilation and formatting only.

## 5. Approvals

By `CLAUDE.md` §9 this PR needs none: no `docker/schema.sql`, no `docker/migrations/`, no auth,
no SumUp, no dependency change. Flagging anyway, because two things sit near money:

1. The two conversions touch product pricing and discount-code generation. Confirm both targets.
2. `statement_timeout: 15_000` — see Step 1.

#52 (Vitest) will need a dependency approval. Separate ask, after this lands.
