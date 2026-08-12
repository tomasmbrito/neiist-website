# Plan: order integrity batch — #78 (status transitions + auto-cancel race), #79 (atomic payment finalization), #100 (per-user cap TOCTOU)

**Status: proposal. Nothing here has been written to `docker/schema.sql`, `docker/migrations/`,
or application code.** All three issues need SQL function changes, which require human approval
(`CLAUDE.md` §2 / §9).

---

## 0. What changed since this plan was written (2026-08-12 refresh)

This plan was researched before #142, #80 and #148. The **analysis in §1 is still accurate** —
it was read against the live schema and re-spot-checked — but four of its conclusions are now
out of date. Read this section before acting on anything below.

| Was | Now |
|---|---|
| `src/utils/dbUtils.ts` holds all ~64 query functions | **It no longer exists.** #142 split it into `src/utils/db/{dbClient,errorMapper,userQueries,eventQueries,shopQueries}.ts`. Every `dbUtils.ts:NNNN` reference in §4 means `shopQueries.ts` (orders, products) or `errorMapper.ts` (`throwIfOrderDbError`). Line numbers are stale; the function names are not. |
| §3: `withTransaction` does not exist, and `src/lib/db/connection.ts` is dead code | **`withTransaction` exists** in `src/utils/db/dbClient.ts` (#80), along with a `Querier` type, an aborted-`COMMIT` guard and an `AsyncLocalStorage` tripwire. The `connection.ts` blocker described in §3 is gone — that file was deleted with the dead repository layer in #119. §3's conclusion still holds: this batch does not *need* `withTransaction`, because each fix is a single SQL statement. |
| §5: **"there is no automated path from this repository to the production database schema"** — flagged as the blocking open question | **Answered, and fixed.** There was none, and there never had been, in this fork or upstream. PR #148 adds `scripts/migrate.mts`, `docker/migrations/`, `neiist.schema_migrations`, and a migration step in both deploy scripts. §5's "who applies DDL by hand" question is void: **nobody does, and nobody should.** Write `docker/migrations/002_order_integrity.sql` and let the deploy apply it. |
| §8: "No test file will be written, because nothing would run it" | **Wrong now.** #52 added Vitest with a Postgres service container in CI. The concurrency proofs in §8.2 should be written as **tests**, not as a documented manual procedure. Two `psql` sessions become two `pg.Client` connections; the interleavings are the same. |

**One new constraint, from #148.** Every migration must be **idempotent** and
**backward-compatible with the previous release**, because the deploy applies it while the old
instance is still serving traffic. The `DROP FUNCTION` + `CREATE FUNCTION` swaps in §2.2 and §2.4
satisfy this — the runner already wraps each file in one transaction, so §5's "wrap drop+create
in a transaction" instruction is now automatic — and the new parameters all default to `NULL`, so
the old app's shorter calls keep resolving. That property is load-bearing; do not remove it.

**One new risk, and it is the largest one in this document.** Production's actual schema is
**unmeasured**. `docker/schema.sql` has been edited in 53 commits and none of them ever reached
a database with data in it, so the production bodies of `set_order_state` and `new_order` are
*assumed*, not known. This batch rewrites exactly those two functions. **A
`pg_dump --schema-only` of production, diffed against a container built from
`docker/schema.sql`, must happen before Step 1 ships** — it needs production credentials, so it
is a human task. If production has drifted, `CREATE OR REPLACE` will silently overwrite whatever
is actually there.

## Why one batch

The three issues are the same defect seen from three angles: **the database is never asked to
decide anything about order state.** TypeScript reads, decides, then writes on a different
connection, so every decision is stale by the time it is acted on. All three fixes are "move
the decision inside a `plpgsql` function that holds a lock" — the pattern `neiist.new_order`
already uses correctly. Doing them together means one DDL window and one review of the same
locking argument, instead of three.

---

## 1. Verified current state

Every bullet below was read in this repo at `main` (after #99, #101, #102). Corrections to the
briefing are marked **CORRECTION**.

### 1.1 `set_order_state` is unconditional — confirmed

`docker/schema.sql:2822-2890`. Signature `(p_order_id INTEGER, p_status
neiist.shop_order_status_enum, p_user_istid TEXT DEFAULT NULL)`. The write is
`docker/schema.sql:2852-2860`:

```sql
UPDATE neiist.orders o
SET status = p_status, ...
WHERE o.id = p_order_id;          -- no predicate on the current status
```

No row lock, no status guard, no matrix, no affected-row check. Any status can be written over
any other. `paid_at` / `delivered_at` are stamped with `NOW()` on every transition *into* those
states and are never cleared when leaving them.

**Additional finding (not in the briefing):** the row it returns comes from
`FROM neiist.get_all_orders() g WHERE g.id = p_order_id` (`docker/schema.sql:2887-2888`).
`get_all_orders()` (`docker/schema.sql:2480-2570`) reads **every order** and runs a
`jsonb_agg` over `order_items` per row. So *every single status change scans the whole orders
table*. `update_order` does the same (`docker/schema.sql:2816-2817`). The auto-cancel sweep is
therefore O(orders²). `neiist.get_order()` (`:2371-2477`) is the cheap single-row equivalent
and should be used instead. This is free to fix while the functions are being rewritten anyway.

### 1.2 `canTransitionTo` is never called on the server — **CORRECTION: it is never called at all**

`src/utils/shop/orderStatusUtils.ts:26`. `grep -rn "canTransitionTo\b" src/` returns exactly
one hit: the definition. It is dead code everywhere, client included.

The client actually uses `canTransitionOrderStatus` from
`src/utils/shop/orderKindUtils.ts:112-118`, which layers the per-order-kind overrides
(`src/types/shop/orderKind.ts:70-87`) on top of the base matrix
(`src/types/shop/orderStatus.ts:13-44`). `OrderDetailsOverlay.tsx:223-229` gates every status
button through it. So the **single-order manager UI already respects a matrix**; only the
server and the bulk path do not.

The PATCH handler `src/app/api/shop/orders/[id]/route.ts:211-259`:
- `:221` `const { status } = body` — no Zod schema, no `OrderStatus` union check
- `:225` rejects only `"paid"`
- `:228` reads the order (so a `previous status` *is* available to pass as an expectation)
- `:231` `await setOrderState(orderId, status, ...)` — raw string, unvalidated, unguarded
- an invalid string reaches the enum cast and surfaces as a 500 via `handleApiError`

**Additional finding:** `src/lib/errors/apiErrorHandler.ts:23-25` returns `error.message`
verbatim with a 500 for anything it does not recognise. An unmapped `plpgsql` `RAISE` message
is therefore returned to the client. This matters for the new error codes below — an unmapped
`SQLSTATE` leaks SQL text.

**Additional finding:** the PUT handler advertises `status`, `paid_at` and `delivered_at` in
`allowedFields` (`src/app/api/shop/orders/[id]/route.ts:68-82`), but `neiist.update_order`
(`docker/schema.sql:2627-2656`) has **no branch for any of them**. A `PUT {"status":"paid"}`
returns 200 and silently changes nothing. Good news for security (there is no second status
writer to guard); bad news as a trap for managers and future maintainers.

### 1.3 Auto-cancel reads everything and filters in JS — confirmed

`src/utils/shop/autoCancelUtils.ts`:
- `:19` `getAllOrders()` — whole table, items aggregated per row
- `:21` `order.status !== "pending"` filtered in JavaScript
- `:23-24` kind rules decide `autoCancelEnabled` (false for `churrasco`,
  `src/types/shop/orderKind.ts:55`)
- `:30-32` serial loop calling `setOrderState(order.id, "cancelled", "system-cron")`
- `:45` `await sendEmail(...)` **inside** the loop — an SMTP round-trip per order

The snapshot at `:19` is arbitrarily stale by the time `:32` runs. Combined with 1.1, a payment
that lands mid-sweep is overwritten by `cancelled`, the restock trigger
(`docker/schema.sql:364-368`) fires, and the customer gets an auto-cancelled email for an order
they paid for. Confirmed exactly as described in #78 scenario B.

**Additional finding:** `src/lib/autoCancelScheduler.ts:17-34` schedules the sweep in-process,
guarded only by a `globalThis` flag. PM2 blue/green runs a second app instance during every
deploy (`scripts/deploy_prod.sh` starts the new instance and only *then* stops the old one), so
**two sweeps can run concurrently**. The guarded update fixes that too; nothing else does.

### 1.4 `finalizePaidOrder` is a 3-round-trip check-then-act — confirmed, and there are **five** entry points, not three

`src/utils/shop/orderFinalization.ts`:
- `:30` `getOrderById(orderId)` — connection 1
- `:33` status check in JS
- `:39` `setOrderState(orderId, "paid", paymentCheckedBy)` — connection 2
- `:44-51` `updateOrder(orderId, { payment_reference })` — connection 3
- `:62` after-purchase action (`signUpToEvent` for jantar de curso)
- `:72` confirmation email

**CORRECTION to the briefing's entry-point list.** After #102 there are five call sites:

| entry point | actor string | auth |
|---|---|---|
| `src/app/api/shop/sumup/verify/route.ts:107` | `sumup-verify` | session |
| `src/app/api/shop/sumup/callback/route.ts:52` (browser return, GET) | `sumup-return` | none |
| `src/app/api/shop/sumup/callback/route.ts:138` (webhook, POST) | `sumup-webhook` | none |
| `src/app/api/shop/sumup/readers/callback/route.ts:78` (card reader) | `sumup-tpa` | none |
| `src/app/api/shop/orders/[id]/pay/route.ts:28` (manual) | manager istid | shop manager+ |

Every one of them does its own `["paid","ready","delivered"].includes(order.status)` pre-check
(`verify:42`, `callback:113`, `readers/callback:45`) — which is *five copies of the same
racy check*, none of which is the authority. A card-reader payment plus a browser return plus
the webhook for the same purchase is the normal case, not the pathological one.

`pay/route.ts:25` does fetch the order and discard it, exactly as #79 says.

**Good news from #102:** the checkout→order binding (`verifyCheckoutBinding`) already runs
*before* `finalizePaidOrder` in all four SumUp routes, and it is a pure function over an
already-fetched checkout. So no external HTTP happens inside the region this plan is about to
put a row lock around. That property must be preserved.

### 1.5 The per-user cap is enforced only in the route — confirmed

`src/app/api/shop/orders/route.ts:119-151`: read (`getUserOrderedProductsInCategory`, `:122`),
sum in JS (`:127-132`), compare (`:139`), then create the order at `:194`. Two round-trips, no
lock.

`neiist.new_order` (`docker/schema.sql:2082-2368`) contains **no** per-user limit of any kind —
confirmed by reading the whole function.

The only cap in the codebase is `maxQuantityPerUser: 1` for `jantar_de_curso`
(`src/types/shop/orderKind.ts:60`). The cap is **per product within a category**, not per
category total — `getUserOrderedProductsInCategory` groups by `product_id`
(`docker/schema.sql:2893-2906`) and the route compares per product (`:134-149`). Any SQL
version must keep those exact semantics, including `AND o.status <> 'cancelled'`.

### 1.6 `new_order` is the good example — confirmed

`docker/schema.sql:2218` (`FOR UPDATE` on the variant), `:2263` (`FOR UPDATE` on the product),
both taken *before* the stock comparison. Discount redemption at `:2297-2308` is a single
conditional `UPDATE ... WHERE current_uses < max_uses RETURNING`, with `IF NOT FOUND THEN RAISE`
— genuinely race-free. This is the pattern the batch extends.

### 1.7 Related things found while verifying (in scope to *know about*, mostly out of scope to fix)

1. **Bulk "Marcar como Pago" is already broken.** `OrdersTable.tsx:616-620` PATCHes
   `{"status":"paid"}`, which `[id]/route.ts:225` rejects with 400. Every bulk mark-as-paid
   fails today and surfaces as the generic `toast.warning("Aviso")` at `:326`. This matters for
   risk R1 below: managers may already be working around it by bulk-marking `delivered`
   straight from `pending`.
2. **Owners can cancel a paid or delivered order.** `[id]/route.ts:261-292` (DELETE) requires
   owner *or* admin/coordinator and calls `setOrderState(..., "cancelled")` with no status
   check (`:285`). The restock trigger then puts the goods back on sale while the customer
   still has them and has not been refunded. TypeScript-only fix, included as Step 0.
3. **`update_order` with `items` restocks the old lines unconditionally** (`schema.sql:2660-2682`)
   — editing the items of an already-cancelled order restocks a second time. Same family as
   #78 scenario A. Not fixed here; worth its own issue.
4. **No index on `order_items(order_id)`** — the FK every order read joins on. Indexes present:
   `schema.sql:245-246, 304, 307, 2920-2922`. Also no index on `orders(status)`.
5. The dead `src/lib/db/repositories/shop.repository.ts:360-372` has its own `setOrderState`
   with `$3::UUID`. It cannot run against the live schema regardless. This batch does not touch
   it; the divergence just grows, which is one more argument for the identity decision.

---

## 2. Proposed SQL

Conventions kept from the existing schema: `SECURITY DEFINER` (the app role `neiist_app_user`
has **no** table privileges — `schema.sql:11-16` — so a non-DEFINER function would fail with
"permission denied"), schema-qualified references, `TIMESTAMPTZ`.

### 2.0 Error codes

Custom five-character `SQLSTATE`s so `throwIfOrderDbError` can map them to the right HTTP
status instead of everything collapsing to `P0001` → 400.

| SQLSTATE | meaning | domain error | HTTP |
|---|---|---|---|
| `NEI01` | order does not exist | `NotFoundError` | 404 |
| `NEI02` | status transition not allowed by the matrix | `ConflictError` | 409 |
| `NEI03` | per-user quantity cap exceeded | `ValidationError` | 400 |
| `NEI04` | cannot finalize a cancelled order as paid | `ConflictError` | 409 |
| `NEI05` | payment reference required for a non-cash order | `ValidationError` | 400 |

Five-character codes of digits and uppercase ASCII letters are legal `SQLSTATE`s and are
treated as errors as long as the class is not `00`/`01`/`02`. Because
`apiErrorHandler.ts:23-25` echoes unmapped error messages to the client, **every code added
here must get a mapping in the same PR** — that is a review checklist item, not a nice-to-have.

### 2.1 Transition matrix (`#78`)

```sql
-- Which order status transitions the database will accept.
--
-- This is deliberately a SUPERSET of the TypeScript matrix in src/types/shop/orderStatus.ts.
-- The database enforces the transitions that protect data; the application narrows further
-- per order kind (jantar de curso allows only paid -> cancelled, for example). Encoding the
-- kind-specific rules here would duplicate business policy in two places that will drift.
--
-- The only genuinely destructive transition is out of 'cancelled': the restock trigger
-- (trg_restock_limited_on_cancel) has already returned the stock, and there is no compensating
-- re-decrement anywhere. Leaving 'cancelled' therefore mints inventory (#78 scenario A).
CREATE OR REPLACE FUNCTION neiist.is_valid_order_transition(
  p_from neiist.shop_order_status_enum,
  p_to   neiist.shop_order_status_enum
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to        THEN TRUE      -- idempotent no-op, handled by the caller
    WHEN p_from = 'cancelled' THEN FALSE     -- terminal: stock already returned
    WHEN p_from = 'pending'   THEN p_to IN ('paid', 'cancelled')
    WHEN p_from = 'paid'      THEN p_to IN ('ready', 'delivered', 'cancelled')
    WHEN p_from = 'ready'     THEN p_to IN ('paid', 'delivered', 'cancelled')
    WHEN p_from = 'delivered' THEN p_to IN ('paid', 'ready', 'cancelled')
    ELSE FALSE
  END;
$$;
```

**The backward steps (`ready`→`paid`, `delivered`→`ready`, `delivered`→`paid`) are the
deliberate looseness.** They touch no stock and no money; they are how a manager undoes a
misclick. Forbidding them would be strictly stricter than today with no data-integrity benefit
— exactly the failure mode the brief warns about. See §7 R1/R3 for the decisions this leaves
open.

Enumerated legitimate transitions from the real data:

| from → to | who does it | matrix |
|---|---|---|
| pending → paid | `finalize_paid_order` only (5 payment entry points) | allowed (and see 2.2) |
| pending → cancelled | auto-cancel sweep; manager; owner (DELETE) | allowed |
| paid → ready | manager, single + bulk | allowed |
| paid → delivered | manager, single + bulk (`paid.allowedTransitions` includes it) | allowed |
| paid → cancelled | manager (refund) | allowed |
| ready → delivered | manager, single + bulk | allowed |
| ready → cancelled | manager | allowed |
| delivered → cancelled | manager (return) | allowed |
| X → X | bulk operations over a mixed selection | no-op, no error |
| ready/delivered → paid, delivered → ready | manager undoing a misclick — **not exposed in the UI today** | allowed (loose) |
| pending → delivered, pending → ready | bulk buttons, over a pending selection | **rejected — see R1** |
| cancelled → anything | not exposed in the UI (`cancelled.allowedTransitions` is `[]`) | **rejected — see R3** |

### 2.2 `set_order_state` with `p_expected_status` (`#78`)

```sql
-- A function is identified by name + argument types, so CREATE OR REPLACE with an extra
-- parameter would create a SECOND overload and leave the unguarded three-argument version
-- callable. It must be dropped. Run the drop and the create in one transaction (see §5).
DROP FUNCTION IF EXISTS neiist.set_order_state(
  INTEGER, neiist.shop_order_status_enum, TEXT
);

CREATE FUNCTION neiist.set_order_state(
  p_order_id        INTEGER,
  p_status          neiist.shop_order_status_enum,
  p_user_istid      TEXT DEFAULT NULL,
  p_expected_status neiist.shop_order_status_enum DEFAULT NULL
) RETURNS TABLE (
  changed            BOOLEAN,
  previous_status    TEXT,
  id                 INTEGER,
  order_number       TEXT,
  customer_name      TEXT,
  user_istid         VARCHAR(50),
  customer_email     TEXT,
  customer_phone     TEXT,
  customer_nif       TEXT,
  campus             TEXT,
  pickup_deadline    TIMESTAMPTZ,
  items              JSONB,
  notes              TEXT,
  discount_code      TEXT,
  discount_amount    NUMERIC(10,2),
  total_amount       NUMERIC(10,2),
  payment_method     TEXT,
  payment_reference  TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at       TIMESTAMPTZ,
  delivered_by       TEXT,
  updated_at         TIMESTAMPTZ,
  updated_by         TEXT,
  status             TEXT
) AS $$
DECLARE
  v_current neiist.shop_order_status_enum;
  v_rows    INTEGER;
  v_changed BOOLEAN := FALSE;
BEGIN
  -- Serialise every concurrent decision about this order behind one row lock.
  SELECT o.status INTO v_current
  FROM neiist.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE = 'NEI01';
  END IF;

  -- Optimistic concurrency. The caller states the status its decision was based on; if the
  -- order has moved since, the caller's decision is stale and must not be applied.
  -- Zero rows, not an exception: for the auto-cancel sweep this is the normal case (#78 B).
  IF p_expected_status IS NOT NULL AND v_current <> p_expected_status THEN
    RETURN;
  END IF;

  IF v_current = p_status THEN
    v_changed := FALSE;                    -- idempotent no-op; bulk operations rely on this
  ELSE
    IF NOT neiist.is_valid_order_transition(v_current, p_status) THEN
      RAISE EXCEPTION 'Invalid order status transition % -> % for order %',
        v_current, p_status, p_order_id
        USING ERRCODE = 'NEI02';
    END IF;

    UPDATE neiist.orders o
    SET status = p_status,
        -- Preserve the FIRST payment timestamp; a later ready->paid correction must not
        -- rewrite when the money actually arrived.
        paid_at = CASE
          WHEN p_status = 'paid' THEN COALESCE(o.paid_at, NOW())
          ELSE o.paid_at
        END,
        payment_checked_by = CASE
          WHEN p_status = 'paid' THEN COALESCE(o.payment_checked_by, p_user_istid)
          ELSE o.payment_checked_by
        END,
        delivered_at = CASE
          WHEN p_status = 'delivered' THEN COALESCE(o.delivered_at, NOW())
          -- Explicit undo of a delivery clears the record. A cancellation after delivery
          -- (a return) keeps it: that history is wanted.
          WHEN v_current = 'delivered' AND p_status IN ('paid', 'ready') THEN NULL
          ELSE o.delivered_at
        END,
        delivered_by = CASE
          WHEN p_status = 'delivered' THEN COALESCE(o.delivered_by, p_user_istid)
          WHEN v_current = 'delivered' AND p_status IN ('paid', 'ready') THEN NULL
          ELSE o.delivered_by
        END,
        updated_at = NOW(),
        updated_by = COALESCE(p_user_istid, o.updated_by)
    WHERE o.id = p_order_id
      AND o.status = v_current;            -- belt and braces; the row lock already guarantees it

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := (v_rows = 1);
  END IF;

  RETURN QUERY
  SELECT
    v_changed, v_current::TEXT,
    g.id, g.order_number, g.customer_name, g.user_istid, g.customer_email, g.customer_phone,
    g.customer_nif, g.campus, g.pickup_deadline, g.items, g.notes, g.discount_code,
    g.discount_amount, g.total_amount, g.payment_method, g.payment_reference, g.created_by,
    g.created_at, g.paid_at, g.payment_checked_by, g.delivered_at, g.delivered_by,
    g.updated_at, g.updated_by, g.status::TEXT
  FROM neiist.get_order(p_order_id, NULL) g;   -- single-row read; NOT get_all_orders()
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION
  neiist.set_order_state(INTEGER, neiist.shop_order_status_enum, TEXT,
                         neiist.shop_order_status_enum) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION
  neiist.is_valid_order_transition(neiist.shop_order_status_enum,
                                   neiist.shop_order_status_enum) TO neiist_app_user;
```

Notes:
- `p_expected_status DEFAULT NULL` keeps three-argument calls working, so the currently
  deployed app keeps working during the blue/green window (§5).
- The return gains two leading columns. `mapDbOrderToOrder` maps by name and ignores extras, so
  the existing mapper is unaffected.
- Later hardening, deliberately **not** in this batch: forbid `p_status = 'paid'` here entirely
  so `finalize_paid_order` is structurally the only writer of `paid`. It cannot ship before the
  app stops calling `setOrderState(..., "paid")` — see §6 Step 5.

### 2.3 `finalize_paid_order` (`#79`)

```sql
CREATE OR REPLACE FUNCTION neiist.finalize_paid_order(
  p_order_id          INTEGER,
  p_payment_reference TEXT,
  p_actor             TEXT
) RETURNS TABLE (
  finalized          BOOLEAN,
  previous_status    TEXT,
  id                 INTEGER,
  order_number       TEXT,
  customer_name      TEXT,
  user_istid         VARCHAR(50),
  customer_email     TEXT,
  customer_phone     TEXT,
  customer_nif       TEXT,
  campus             TEXT,
  pickup_deadline    TIMESTAMPTZ,
  items              JSONB,
  notes              TEXT,
  discount_code      TEXT,
  discount_amount    NUMERIC(10,2),
  total_amount       NUMERIC(10,2),
  payment_method     TEXT,
  payment_reference  TEXT,
  created_by         TEXT,
  created_at         TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at       TIMESTAMPTZ,
  delivered_by       TEXT,
  updated_at         TIMESTAMPTZ,
  updated_by         TEXT,
  status             TEXT
) AS $$
DECLARE
  v_current   neiist.shop_order_status_enum;
  v_method    TEXT;
  v_reference TEXT := NULLIF(BTRIM(COALESCE(p_payment_reference, '')), '');
  v_rows      INTEGER;
  v_finalized BOOLEAN := FALSE;
BEGIN
  -- One winner. Every other concurrent finalization blocks here and, on waking, re-reads the
  -- row it now holds the lock on (READ COMMITTED re-evaluates FOR UPDATE against the latest
  -- committed version), so it sees 'paid' and takes the replay branch.
  SELECT o.status, o.payment_method INTO v_current, v_method
  FROM neiist.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE = 'NEI01';
  END IF;

  IF v_current = 'cancelled' THEN
    RAISE EXCEPTION 'Order % is cancelled and cannot be finalized as paid', p_order_id
      USING ERRCODE = 'NEI04';
  END IF;

  IF v_current IN ('paid', 'ready', 'delivered') THEN
    v_finalized := FALSE;                  -- replayed webhook: success, no side effects
  ELSE
    -- Matches the current TypeScript behaviour: cash orders carry no external reference.
    IF v_method IS DISTINCT FROM 'cash' AND v_reference IS NULL THEN
      RAISE EXCEPTION 'Payment reference is required for order %', p_order_id
        USING ERRCODE = 'NEI05';
    END IF;

    UPDATE neiist.orders o
    SET status             = 'paid',
        paid_at            = COALESCE(o.paid_at, NOW()),
        payment_checked_by = COALESCE(p_actor, o.payment_checked_by),
        payment_reference  = CASE
                               WHEN o.payment_method = 'cash' THEN o.payment_reference
                               ELSE v_reference
                             END,
        updated_at         = NOW(),
        updated_by         = COALESCE(p_actor, o.updated_by)
    WHERE o.id = p_order_id
      AND o.status = 'pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_finalized := (v_rows = 1);
  END IF;

  RETURN QUERY
  SELECT
    v_finalized, v_current::TEXT,
    g.id, g.order_number, g.customer_name, g.user_istid, g.customer_email, g.customer_phone,
    g.customer_nif, g.campus, g.pickup_deadline, g.items, g.notes, g.discount_code,
    g.discount_amount, g.total_amount, g.payment_method, g.payment_reference, g.created_by,
    g.created_at, g.paid_at, g.payment_checked_by, g.delivered_at, g.delivered_by,
    g.updated_at, g.updated_by, g.status::TEXT
  FROM neiist.get_order(p_order_id, NULL) g;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.finalize_paid_order(INTEGER, TEXT, TEXT) TO neiist_app_user;
```

This collapses `orderFinalization.ts:30`, `:39` and `:44` (three connections, three
transactions) into one statement, and replaces `alreadyProcessed` with a value the database
actually decided: `finalized`. Only `finalized = true` may send an email or run an
after-purchase action.

Interleaving that is now impossible: browser return and webhook 50 ms apart both see `pending`,
both write `paid`, both email, both call `signUpToEvent`. Under the new function the second
caller blocks on the row lock, wakes to `paid`, and returns `finalized = false`.
`payment_checked_by` is `COALESCE(o.payment_checked_by, p_actor)`-style first-writer-wins, so
the audit trail records the actor that actually won.

**Property that must be preserved by reviewers:** no HTTP call may be added between the
`SELECT ... FOR UPDATE` and the end of this function. All SumUp calls already happen before it
(`verify:69`, `callback:27/105`, `readers/callback:59`).

### 2.4 Per-user cap inside `new_order` (`#100`)

Two design options. **Option A is recommended.**

**Option A — the app passes the policy, the database enforces it.** Two new parameters. No
table DDL, no backfill, and `SPECIAL_ORDER_CONFIG` stays the single source of truth for the
policy value.
**Option B — a `categories.max_quantity_per_user` column.** Nothing can forget to pass it, but
it duplicates `src/types/shop/orderKind.ts:60` into data that will drift, and needs a column +
backfill + a management UI. Recommend revisiting only if caps ever become per-category
configurable by managers.

```sql
-- Same reason as set_order_state: the old 13-argument signature must go, or a 13-argument
-- call keeps binding to the uncapped version.
DROP FUNCTION IF EXISTS neiist.new_order(
  VARCHAR(50), TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
);

CREATE FUNCTION neiist.new_order(
  ... all 13 existing parameters unchanged ...,
  p_max_quantity_per_user   INTEGER DEFAULT NULL,
  p_quantity_limit_category TEXT    DEFAULT NULL
) RETURNS TABLE ( ... unchanged ... ) AS $$
DECLARE
  ... existing declarations ...
  v_cap_product_id   INTEGER;
  v_cap_product_name TEXT;
  v_cap_total        INTEGER;
BEGIN
  ... unchanged: insert order, item loop with FOR UPDATE stock locks (schema.sql:2191-2287) ...

  -- ####  NEW: per-user quantity cap, evaluated after the items exist, in the same
  -- ####  transaction, serialised against this user's other concurrent checkouts.
  IF p_max_quantity_per_user IS NOT NULL
     AND p_user_istid IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(p_quantity_limit_category, '')), '') IS NOT NULL THEN

    -- Transaction-scoped advisory lock: released automatically on COMMIT *or* ROLLBACK, so the
    -- RAISE below cannot leak it. Keyed on user+category, so two different students never
    -- contend. Taken AFTER the product/variant row locks, consistently, in the only function
    -- that takes it — so it cannot participate in a lock-ordering cycle.
    PERFORM pg_advisory_xact_lock(
      hashtext('neiist.order_user_quantity_cap'),
      hashtext(lower(p_user_istid) || '|' || lower(BTRIM(p_quantity_limit_category)))
    );

    -- Counts this order's rows too: they are already inserted and visible to this transaction.
    -- Predicate is identical to neiist.get_user_ordered_products_in_category (schema.sql:2893)
    -- so the SQL authority and the route's fast pre-check agree, including status <> 'cancelled'.
    SELECT oi.product_id, MAX(oi.product_name), SUM(oi.quantity)::INT
      INTO v_cap_product_id, v_cap_product_name, v_cap_total
    FROM neiist.order_items oi
    JOIN neiist.orders     o ON o.id = oi.order_id
    JOIN neiist.products   p ON p.id = oi.product_id
    JOIN neiist.categories c ON c.id = p.category_id
    WHERE o.user_istid = p_user_istid
      AND o.status <> 'cancelled'
      AND lower(c.name) = lower(BTRIM(p_quantity_limit_category))
    GROUP BY oi.product_id
    HAVING SUM(oi.quantity) > p_max_quantity_per_user
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION
        'Per-user quantity limit reached for product % (%): % ordered, limit %',
        v_cap_product_id, v_cap_product_name, v_cap_total, p_max_quantity_per_user
        USING ERRCODE = 'NEI03';
    END IF;
  END IF;

  ... unchanged: discount validation + redemption (schema.sql:2289-2311), totals, RETURN QUERY ...
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.new_order(
  VARCHAR(50), TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN,
  INTEGER, TEXT
) TO neiist_app_user;
```

Why the lock is placed there and why it is sufficient:

> A and B are two checkouts by the same student for the same 1-per-student product.
> Both insert their `order_items` (no serialisation yet). A reaches the advisory lock and takes
> it; B blocks. A's `SELECT ... HAVING` runs with a snapshot taken after the lock, sees total 1,
> passes, and A commits — releasing the lock. B wakes, and its `SELECT` statement takes a
> **new** snapshot (READ COMMITTED gives every statement a fresh snapshot), which now includes
> A's committed row. B sees total 2 > 1, raises `NEI03`, and its whole transaction — order row,
> items, stock decrements, discount redemption — rolls back.

Alternative considered: `SELECT ... FROM neiist.users WHERE istid = p_user_istid FOR UPDATE`.
Simpler to read, but it takes a real row lock on `users` that unrelated writers
(`update_user`) would contend with, and it creates a users→products lock ordering that other
functions could invert. The advisory lock has neither problem.

### 2.5 Optional, same batch or later: cheap reads

Not required for correctness. Included because the functions are being rewritten anyway.

```sql
-- The FK every order read joins on. Absent today (schema.sql:304 indexes product_id, not order_id).
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON neiist.order_items(order_id);

-- Auto-cancel candidate selection and every manager filter on status.
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON neiist.orders(status, created_at);
```

---

## 3. `withTransaction` (issue #80)

**Not required for this batch. Recommend shipping #80 separately.**

Every fix above is a *single* SQL statement (`SELECT * FROM neiist.<fn>(...)`), which Postgres
already runs in its own implicit transaction. The atomicity comes from putting the logic inside
the function, exactly as `new_order` does. Wrapping a single-statement call in `BEGIN`/`COMMIT`
from Node would add a connection round-trip and zero safety. The side effects that must *not*
be inside a transaction — email, `signUpToEvent`, SumUp HTTP — stay outside it either way.

For completeness, the helper #80 asks for, if it is shipped on its own:

```ts
// src/lib/db/connection.ts
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export type Queryable = {
  query<T extends QueryResultRow>(_text: string, _params?: unknown[]): Promise<QueryResult<T>>;
};

export async function withTransaction<T>(_fn: (_client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await _fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Transaction rollback failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();          // in finally, always — a leaked client exhausts the pool
  }
}
```

Query functions would then take an optional `client: Queryable = pool` so the same function
works inside and outside a transaction.

**Blocker to flag on #80:** `src/lib/db/connection.ts` is dead code (`CLAUDE.md` §4).
`src/utils/dbUtils.ts:37-39` creates its **own** `Pool`, so a helper added to `connection.ts`
is unreachable from the 55 files that matter. The first step of #80 must be to delete
`dbUtils`' private pool and import `pool` / `db_query` from `@/lib/db/connection` — both read
the same `DATABASE_URL`, and `connection.ts`'s pool is the HMR-safe one, so this is a strict
improvement and independent of the istid/UUID decision. It is a one-import change plus deleting
five lines, but it is *not* in this batch's scope.

---

## 4. Application-side changes

### Step 0 — TypeScript only, no schema (ships first, independently)

| file:line | change |
|---|---|
| `src/app/api/shop/orders/[id]/route.ts:221-223` | validate `status` against the `OrderStatus` union (a Zod enum in `src/schemas/shop.ts`, consistent with `CLAUDE.md` §5) → 400 instead of 500. Closes #78 AC 4. |
| `src/app/api/shop/orders/[id]/route.ts:68-82` | drop `status`, `paid_at`, `delivered_at` from PUT `allowedFields` — `update_order` silently ignores them (§1.2). |
| `src/app/api/shop/orders/[id]/route.ts:277-285` | DELETE: an owner who is not shop-ops may cancel only while `order.status === "pending"`. Today an owner can cancel a delivered order and trigger a restock (§1.7.2). |
| `src/utils/shop/orderStatusUtils.ts:26` | either delete `canTransitionTo` (dead everywhere) or make it delegate to `canTransitionOrderStatus`. Do not leave a third matrix reader. |

### Step 1 — `#78`

| file:line | change |
|---|---|
| `src/utils/dbUtils.ts:1029-1042` | `setOrderState(orderId, status, userIstid, expectedStatus)`. Make `expectedStatus` **required** (`OrderStatus`, not optional) so `tsc` finds every call site — in a repo with no tests, the compiler is the regression guard. Return `{ changed, previousStatus, order } | null`; `null` means the expectation did not match. |
| `src/utils/dbUtils.ts:892-947` | `throwIfOrderDbError`: add `NEI01`→`NotFoundError`, `NEI02`→`ConflictError`, `NEI03`→`ValidationError`, `NEI04`→`ConflictError`, `NEI05`→`ValidationError`, with Portuguese copy. Keep the `P0001` fallback last. |
| `src/app/api/shop/orders/[id]/route.ts:228-232` | pass `order.status` (already read at `:228`) as the expectation; on `null` return 409 *"O estado da encomenda mudou entretanto. Recarrega a página."*; send the status email only when `changed === true`; route the catch through `throwIfOrderDbError` (PATCH currently does not, unlike PUT at `:202-207`). |
| `src/app/api/shop/orders/[id]/route.ts:285` | DELETE: pass `order.status` (read at `:274`) as the expectation. |
| `src/utils/shop/autoCancelUtils.ts:32` | pass `"pending"` as the expectation; a `null` result is a **skip**, not a failure — add `skippedOrderIds` alongside `failedOrderIds` (`:27-28`, `:68-76`) so a paid-mid-sweep order is visible in the log instead of silently cancelled. |
| `src/utils/shop/autoCancelUtils.ts:43-61` | move the email out of the cancel loop: collect the cancelled orders, then send. Optional but it is the thing that makes the window seconds wide. |
| `src/components/shop/OrdersTable.tsx:337-360` | bulk PATCH now gets 409s for members of a mixed selection. Report them distinctly ("N encomendas já estavam nesse estado / não podiam transitar") instead of the generic `toast.warning("Aviso")` at `:326`. |

### Step 2 — `#79`

| file:line | change |
|---|---|
| `src/utils/dbUtils.ts` (new, next to `setOrderState`) | `finalizeOrderPayment(orderId, reference, actor): Promise<{ finalized: boolean; previousStatus: string; order: Order }>` — named differently from the TS `finalizePaidOrder` to keep the two distinguishable. |
| `src/utils/shop/orderFinalization.ts:30-54` | replaced by one call. `alreadyProcessed = !finalized`, so the public `FinalizePaidOrderResult` shape and every route response are unchanged (no client depends on `finalized`/`alreadyProcessed` — verified by grep). |
| `src/utils/shop/orderFinalization.ts:56-86` | gate the after-purchase action and the email on `finalized === true`. This is the actual fix for duplicate `signUpToEvent` and duplicate receipts. |
| `src/app/api/shop/orders/[id]/pay/route.ts:25-26` | delete the redundant `getOrderById`; `NEI01` now produces the 404. |
| `src/app/api/shop/orders/[id]/pay/route.ts:38` | reuse the order returned by finalization instead of re-fetching. |
| `src/app/api/shop/orders/[id]/pay/route.ts:40-43` | route the catch through `throwIfOrderDbError` + `handleApiError`; today every failure is a blanket 500. |
| `verify:42`, `callback:113`, `readers/callback:45` | leave the pre-checks. They are cheap early-outs and they already have the order loaded for `verifyCheckoutBinding`. They are explicitly no longer the authority — worth a one-line comment saying so. |

### Step 3 — `#100`

| file:line | change |
|---|---|
| `src/utils/dbUtils.ts:850-890` | `newOrder` gains `maxQuantityPerUser?: number` and `quantityLimitCategory?: string`, appended as `$14, $15`. |
| `src/app/api/shop/orders/route.ts:119-151` | keep the pre-check exactly as is — it produces the good Portuguese message naming the product. Add a comment that it is a fast path, not the authority. |
| `src/app/api/shop/orders/route.ts:194-210` | pass `orderRules.maxQuantityPerUser` and `products[0]?.category?.trim()` into `newOrder`. (`products[0].category` is what the pre-check already uses at `:120`; caps only exist on special kinds, and mixing a special kind with anything else is already rejected at `:105-110`.) |
| `src/app/api/shop/orders/route.ts:246-254` | already routes through `throwIfOrderDbError`, so `NEI03` becomes a clean 400 with no further change. |

---

## 5. Migration and rollback

### How a schema change reaches production — **I could not establish this, and I am not going to invent it**

Verified:
- `docker/docker-compose.yml:18-21` mounts `schema.sql` and `init.sql` into
  `/docker-entrypoint-initdb.d/`. Postgres runs those **only when the data directory is
  empty**. On any database that already has data, editing `schema.sql` changes nothing.
- `docker/migrations/001_user_uuid.sql` is mounted nowhere and has never been applied
  (`CLAUDE.md` §4).
- `scripts/deploy_prod.sh` and `scripts/deploy_staging.sh` contain **no `psql`, no migration
  runner, no database step of any kind** — they pull, `yarn install --frozen-lockfile`,
  `yarn build`, `pm2 restart`.

So there is **no automated path from this repository to the production database schema.** The
DDL has to be applied by a human with a `psql` session against the production database.

**Question for the human, blocking Steps 1–3:** who applies DDL to production today, with what
credentials, and is there a staging database to apply it to first? If the answer is "nobody has
ever done it", that is worth knowing before, not after, this batch is approved.

### What the PR would contain

1. `docker/schema.sql` edited in place — new definitions replacing
   `:2822-2890` (`set_order_state`), `:2082-2368` (`new_order`), plus
   `is_valid_order_transition` and `finalize_paid_order`. This keeps fresh environments
   (`yarn db:reset`, CI, a new dev machine) correct.
2. `docker/migrations/002_order_integrity.sql` — the *same* DDL, wrapped in a single
   `BEGIN; ... COMMIT;`, for databases that already exist. A header comment must state that
   `001_user_uuid.sql` is **not** a prerequisite: it is unapplied and abandoned pending the
   istid/UUID decision, and the `002_` number does not imply otherwise.
3. `docker/migrations/002_order_integrity_rollback.sql` — the previous function bodies,
   verbatim, restoring the three-argument `set_order_state` and the thirteen-argument
   `new_order` and dropping the two new functions.

### Why the rollback is cheap

Every change is to **functions**, not tables. No column is added, no row is rewritten, no data
is backfilled, nothing is destroyed. Rollback is "re-create the old function bodies", which is
a copy-paste out of git history and takes milliseconds. The only irreversible thing in the
whole batch is orders that were *prevented* from being created or transitioned while it was
live — and preventing those is the point.

### Ordering and the blue/green window

`scripts/deploy_prod.sh` starts the new instance and stops the old one only after it is
healthy, so **both app versions talk to the database at once for several seconds**. The DDL is
designed for that:

1. **Apply the DDL first, then deploy the app.** Both new parameters default to `NULL`, so the
   still-running old app's three-argument `set_order_state(...)` and thirteen-argument
   `new_order(...)` calls resolve to the new functions and behave exactly as before (no
   expectation check, no cap).
2. `DROP FUNCTION` + `CREATE FUNCTION` must be in the **same transaction**. DDL is
   transactional in Postgres, so the swap is atomic and no call can land in the gap. Without
   this, a call between the two statements fails with `42883 function does not exist`.
3. The one behaviour change the old app *does* inherit immediately is the transition matrix —
   an illegal transition now raises `NEI02`, which the old app has no mapping for and will
   surface as a 500 with the raw message (`apiErrorHandler.ts:23-25`). Window is seconds, and
   the transitions concerned are ones that should never have been allowed. Acceptable, but it
   is a reason to deploy the app promptly after the DDL rather than "later this week".

---

## 6. Ordering — each step independently shippable, tree working after each

| # | Contents | Needs DDL? | Ship on its own? |
|---|---|---|---|
| **0** | Status union validation, PUT `allowedFields`, owner-cancel restriction, dead `canTransitionTo` | no | yes — no approval beyond normal review; closes #78 AC 4 today |
| **1** | `is_valid_order_transition` + guarded `set_order_state` + TS call sites (PATCH, DELETE, auto-cancel) | yes | yes — fixes #78 completely |
| **2** | `finalize_paid_order` + `orderFinalization` rewrite + `/pay` route | yes | yes — fixes #79 completely; **must land before Step 5** |
| **3** | Cap inside `new_order` + route passes the parameters | yes | yes — fixes #100 completely |
| **4** | Optional: `idx_order_items_order_id`, `idx_orders_status_created_at`, and `get_all_orders()`→`get_order()` in `update_order` | yes | yes — pure performance, no behaviour change |
| **5** | Optional hardening: `set_order_state` rejects `p_status = 'paid'` so `finalize_paid_order` is the only writer of `paid` | yes | **only after Step 2 is deployed** — otherwise every payment fails |

Steps 1, 2, 3 are independent of each other and can be reordered or split into three PRs. If
only one ships, **Step 2 is the one that costs real money** (duplicate receipts, duplicate
event registrations, wrong audit actor on every raced payment).

`withTransaction` (#80) is not on this list because this batch does not need it (§3).

---

## 7. Risks, ranked

**R1 — the bulk path breaks for `pending` selections. Highest operational risk.**
`OrdersTable.tsx:616-637` offers bulk "Marcar como Pago / Pronto / Entregue / Cancelar" with
no client-side matrix check. Today `pending → delivered` silently succeeds; after Step 1 it is
409. And per §1.7.1, bulk "Marcar como Pago" **already fails today** (`[id]/route.ts:225`
rejects `"paid"`), so it is entirely plausible that managers at a stand currently select
everything and press "Marcar como Entregue" straight from `pending` — a workflow this change
would break on the day it ships.
*Mitigations, pick one:* (a) fix the bulk paid path in the same batch by routing it to
`POST /orders/[id]/pay` with a manual reference — this is the honest fix, and needs a decision
on what reference to record; (b) allow `pending → delivered` in the matrix and accept a
delivered order with `paid_at IS NULL`; (c) ship as proposed and give the bulk toast a precise
message. **Recommend (a) + (c). Needs a human answer: do managers currently mark orders
delivered without marking them paid?**

**R2 — a status transition is rejected that should have been allowed.**
The matrix in §2.1 is a deliberate superset of the TypeScript one, so anything the UI offers
today is allowed. The residual risk is a workflow that only exists via direct API calls or a
future UI. Blast radius is a 409 with a clear message, never data loss, and the matrix is one
`CASE` expression to widen.

**R3 — `cancelled` becomes terminal, with no un-cancel.**
This is the fix for #78 scenario A (minting inventory), but it removes an escape hatch. The UI
never offered it (`cancelled.allowedTransitions` is `[]`,
`src/types/shop/orderStatus.ts:38-43`), so nothing visible regresses — but a manager who
cancels the wrong order will now have to re-create it, and the order number changes.
*Follow-up if that hurts:* a `neiist.reactivate_order(p_order_id)` that re-decrements stock
under the same `FOR UPDATE` locks `new_order` uses, and fails if the stock is gone. That is a
feature, not part of this batch. **Needs a human answer: does anyone un-cancel orders today?**

**R4 — an unmapped `SQLSTATE` leaks SQL text to the client.**
`apiErrorHandler.ts:23-25` returns `error.message` with a 500 for unrecognised errors. Every
`NEIxx` code introduced must be mapped in `throwIfOrderDbError` in the same PR, and the PATCH
and `/pay` routes must be wired through it (neither is today). Review checklist item.

**R5 — the DDL window.** `DROP FUNCTION` takes an exclusive lock on the function entry; a
concurrent in-flight call briefly blocks. Mitigated entirely by wrapping drop+create in one
transaction (§5). Sub-second.

**R6 — cap fails open during the blue/green window.** The old app calls `new_order` with 13
arguments → new parameters default to `NULL` → no SQL cap for a few seconds. The route-level
pre-check still applies. This is the *current* behaviour, so it is a non-regression, not a new
hole.

**R7 — advisory-lock key collisions.** `hashtext` is 32-bit; a collision causes two unrelated
user+category pairs to serialise. Correctness is unaffected, throughput is not measurably.
Verified no other advisory lock exists anywhere in `schema.sql`.

**R8 — a row lock held across network I/O would be a disaster.** `finalize_paid_order` holds
`FOR UPDATE` on the order row for the duration of the call. All SumUp HTTP already happens
before it. Any future change that moves an HTTP call inside it turns a 200 ms lock into a
30 s lock and stalls every concurrent finalization. Worth a comment in the function.

**R9 — the SQL matrix and the TypeScript matrix can drift.** Two sources of truth, by design
(the DB cannot know the order kind cheaply, and the kind rules are business policy). Contained
by making SQL the permissive superset: TS can narrow freely without ever contradicting SQL.
Record this in `docs/ai-workflow/decision-log.md`.

**R10 — `changed` / `finalized` misread as "the order is in this state".** They mean "this
caller performed the write". A `false` with a `paid` status is a successful replay; a `false`
with a stale expectation is zero rows. The TypeScript wrappers must make that distinction
impossible to get wrong (`null` vs `{ changed: false }`).

---

## 8. Verification plan (no test runner exists — `CLAUDE.md` §3)

No test file will be written, because nothing would run it. Verification is (a) the compiler,
(b) reproducible `psql` sessions, (c) manual HTTP.

### 8.1 Compiler as the regression guard

Making `expectedStatus` a **required** parameter of `setOrderState` means `yarn type:check`
enumerates every call site that has not been updated. Same for the new `newOrder` fields if
they are added to a required-ish input type. Gates to run and paste: `yarn type:check`,
`yarn lint`, `yarn build`.

### 8.2 Concurrency proofs — **write these as Vitest tests, not as a manual procedure**

> **Refresh note.** This section originally proposed a committed manual procedure, because no
> test runner existed. #52 changed that: `yarn test` runs against a real Postgres, in CI too.
> The interleavings below are unchanged — they just become two `pg.Client` connections instead
> of two `psql` sessions, in the style of `src/utils/db/dbClient.test.ts`. Each one is a genuine
> concurrency test, so `fileParallelism: false` (already set) matters.
>
> These are the actual acceptance criteria of the three issues, and they are exactly the class of
> bug the gates cannot see. **A fix here without a test for it should not be merged.**

**#79 — two concurrent finalizations produce one winner**
```
-- session A                                   -- session B
BEGIN;
SELECT finalized, status
  FROM neiist.finalize_paid_order(1,'REF-A','a');
-- finalized = t                               BEGIN;
                                               SELECT finalized, status
                                                 FROM neiist.finalize_paid_order(1,'REF-B','b');
                                               -- BLOCKS on the row lock
COMMIT;
                                               -- unblocks: finalized = f, status = paid
                                               COMMIT;
SELECT payment_checked_by FROM neiist.orders WHERE id = 1;   -- 'a', the winner
```

**#78 B — an order that becomes paid mid-sweep is not cancelled**
```
SELECT finalized FROM neiist.finalize_paid_order(2,'REF','manager');   -- order 2 -> paid
SELECT changed, status FROM neiist.set_order_state(2,'cancelled','system-cron','pending');
-- zero rows: the sweep's expectation is stale, nothing was written
SELECT status FROM neiist.orders WHERE id = 2;                         -- still 'paid'
```

**#78 A — no inventory minting**
```
SELECT stock_quantity FROM neiist.products WHERE id = 1;               -- baseline
SELECT changed FROM neiist.set_order_state(3,'cancelled','mgr','pending');   -- restock fires
SELECT * FROM neiist.set_order_state(3,'pending','mgr','cancelled');
-- ERROR: NEI02 invalid order status transition cancelled -> pending
SELECT stock_quantity FROM neiist.products WHERE id = 1;               -- restocked exactly once
```

**#100 — two concurrent orders, cap 1, exactly one succeeds**
```
-- session A                                   -- session B
BEGIN;
SELECT id FROM neiist.new_order('ist1', ..., 1, 'Jantar de Curso');
                                               BEGIN;
                                               SELECT id FROM neiist.new_order('ist1', ..., 1,
                                                                               'Jantar de Curso');
                                               -- BLOCKS on pg_advisory_xact_lock
COMMIT;
                                               -- ERROR: NEI03 per-user quantity limit reached
                                               ROLLBACK;
SELECT count(*) FROM neiist.orders WHERE user_istid = 'ist1';   -- exactly 1
```

**Idempotent bulk no-op** — `set_order_state(id,'delivered','mgr','delivered')` returns one row
with `changed = f` and raises nothing.

### 8.3 Manual HTTP, dev server with a shop-manager session

- `PATCH {"status":"banana"}` → 400 (today: 500).
- `PATCH {"status":"delivered"}` on a cancelled order → 409 (today: 200, `delivered_at`
  stamped).
- `PATCH {"status":"ready"}` twice → 200 then 200 with no second email.
- Two overlapping `POST /orders/[id]/pay` with the same order → one 200 with a state change,
  one 200 replay, **one** email in the mail log, and for a jantar item exactly one row in
  `neiist.activities_sign_up`.
- Bulk-select a mixed `pending`/`paid` set and press "Marcar como Pronto" → the `paid` ones
  transition, the `pending` ones report a clear reason. **Have a shop manager confirm the
  result is acceptable before merging** — that is the R1 check.

### 8.4 Memory to update on merge

- `docs/ai-workflow/problem-registry.md` — the three races, each with the interleaving that
  reproduces it and the lock that closes it.
- `docs/ai-workflow/decision-log.md` — SQL matrix as the permissive superset of the TS matrix
  (R9); `cancelled` made terminal instead of adding a compensating re-decrement (R3); cap
  policy passed in as a parameter rather than stored in `categories` (§2.4 Option A vs B);
  `withTransaction` deliberately **not** used in this batch (§3).
- `docs/ai-workflow/architecture-notes.md` — the DB now decides order state; the five payment
  entry points are convergent on one function.

---

## 9. Open questions for the human (blocking)

**Question 1 is answered. Questions 2–5 are still open and still block Steps 1–3.**

1. ~~**DDL to production**: who applies it, against which database, is there a staging DB (§5)?~~
   **Answered 2026-08-12: nobody ever has, and now nobody has to.** PR #148 built the migration
   path. Superseded by a new blocking item, **1b**.

1b. **Production schema drift must be measured before Step 1 ships.** `docker/schema.sql` has
   been edited 53 times and none of those edits ever reached a database with data. This batch
   rewrites `set_order_state` and `new_order` with `CREATE OR REPLACE`, which will silently
   overwrite whatever is actually in production. Needed: `pg_dump --schema-only` of production,
   diffed against a container built from `docker/schema.sql`. **Production credentials — human.**

2. **R1**: do shop managers currently bulk-mark `pending` orders as `delivered` without marking
   them paid? If yes, do we fix the bulk paid path (recommended) or widen the matrix?
3. **R3**: does anyone un-cancel an order today? If yes, `cancelled` cannot simply become
   terminal and `reactivate_order` needs to be scoped into this batch.
4. **Cap and `stock_override`**: an admin with `stock_override` currently still hits the
   per-user cap (the route checks it regardless, `orders/route.ts:119`). Keep that parity, or
   should `stock_override` also bypass the cap for POS sales? Recommend keeping parity.
5. **Matrix shape**: §2.1 permissive superset (recommended) or strict mirror of the TypeScript
   matrix?

Questions 2 and 3 are about how the shop is **actually operated** and cannot be answered from
the code — they need a shop manager, not a reader. They are the reason this batch is not simply
written and opened as a PR: §7 R1 is a workflow that could break on the day it ships.
