-- 003: guarded order status transitions (#78) and an atomic per-user purchase cap (#100)
--
-- ⚠️ Unlike 002, this migration REPLACES functions that already exist. Production's real schema
-- is unmeasured (#152) — CREATE OR REPLACE will silently overwrite whatever body is actually
-- there. #152 must be answered before this is applied to production.
--
-- ## #78 — set_order_state was unconditional
--
-- The old body wrote any status over any other with no row lock, no guard and no check on rows
-- affected. Two consequences, both live:
--
--   A. Leaving 'cancelled' MINTS INVENTORY. trg_restock_limited_on_cancel has already returned
--      the stock, and there is no compensating re-decrement anywhere, so cancelled -> pending
--      hands out units that were never bought.
--   B. The auto-cancel sweep reads every order, filters in JavaScript, then cancels in a serial
--      loop. A payment that lands mid-sweep is overwritten by 'cancelled': money taken, stock
--      restocked, and the customer emailed "cancelled" for an order they paid for.
--
-- p_expected_status is optimistic concurrency: the caller states the status its decision was
-- based on, and if the order has moved since, the decision is stale and nothing is written. For
-- the sweep that is the normal case, not an error, so it returns ZERO ROWS rather than raising.
--
-- The transition matrix is deliberately a SUPERSET of the TypeScript one in
-- src/types/shop/orderStatus.ts. The database enforces what protects data; the application
-- narrows further per order kind. Encoding kind-specific policy here would put business rules in
-- two places that will drift.
--
-- pending -> ready and pending -> delivered are REJECTED, which is a real behaviour change.
-- Confirmed with Tomás that this matches the intended flow: a SumUp payment finalizes itself,
-- an in-person payment waits for a manager to mark it paid, so 'pending' means pending PAYMENT
-- and nothing may skip it. This is why #154 (bulk mark-as-paid, which has never worked) had to
-- ship first — it is the button that flow depends on.
--
-- ## #100 — the per-user cap was TOCTOU
--
-- The route read the user's quantities, summed them in JavaScript, compared, and only then
-- created the order: two round trips, no lock. Double-clicking Checkout yields two items past a
-- cap of one.
--
-- Implemented as a WRAPPER around neiist.new_order rather than by editing it. new_order is ~280
-- lines of stock locking, discount redemption and totals; copying that body into a migration to
-- add ten lines would create a second copy destined to drift from schema.sql. The wrapper takes a
-- transaction-scoped advisory lock, delegates, then validates — and because a plpgsql RAISE
-- aborts the caller's transaction, the order row, its items, the stock decrements and any
-- discount redemption all roll back together.
--
-- Idempotent: CREATE OR REPLACE throughout; the one DROP is IF EXISTS on a specific signature.

-- ---------------------------------------------------------------------------------------------
-- #78
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION neiist.is_valid_order_transition(
  p_from neiist.shop_order_status_enum,
  p_to   neiist.shop_order_status_enum
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_from = p_to        THEN TRUE   -- idempotent no-op; bulk operations rely on it
    WHEN p_from = 'cancelled' THEN FALSE  -- terminal: the stock has already been returned
    WHEN p_from = 'pending'   THEN p_to IN ('paid', 'cancelled')
    WHEN p_from = 'paid'      THEN p_to IN ('ready', 'delivered', 'cancelled')
    -- Backward steps touch no stock and no money; they are how a manager undoes a misclick.
    -- Forbidding them would be stricter than today with no integrity benefit.
    WHEN p_from = 'ready'     THEN p_to IN ('paid', 'delivered', 'cancelled')
    WHEN p_from = 'delivered' THEN p_to IN ('paid', 'ready', 'cancelled')
    ELSE FALSE
  END;
$$;

-- A function is identified by name + argument types, so adding a 4th parameter with a default
-- would leave the unguarded 3-argument version in place AND make every 3-argument call ambiguous.
-- The old signature has to go. The runner wraps this file in one transaction, so the swap is
-- atomic and no call can land in the gap.
DROP FUNCTION IF EXISTS neiist.set_order_state(
  INTEGER, neiist.shop_order_status_enum, TEXT
);

CREATE OR REPLACE FUNCTION neiist.set_order_state(
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

  -- Stale caller: the order moved since the decision was made. Zero rows, not an exception —
  -- for the auto-cancel sweep this is the expected outcome, not a failure.
  IF p_expected_status IS NOT NULL AND v_current <> p_expected_status THEN
    RETURN;
  END IF;

  IF v_current = p_status THEN
    v_changed := FALSE;
  ELSE
    IF NOT neiist.is_valid_order_transition(v_current, p_status) THEN
      RAISE EXCEPTION 'Invalid order status transition % -> % for order %',
        v_current, p_status, p_order_id
        USING ERRCODE = 'NEI02';
    END IF;

    UPDATE neiist.orders o
    SET status = p_status,
        -- COALESCE, not NOW(): a later ready->paid correction must not rewrite when the money
        -- actually arrived.
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
          -- Explicitly undoing a delivery clears the record. A cancellation after delivery
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
      AND o.status = v_current;   -- belt and braces; the row lock already guarantees it

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
  -- get_order(), NOT get_all_orders(). The old body read EVERY order and ran a jsonb_agg over
  -- order_items per row just to return one, which made the auto-cancel sweep O(orders^2).
  FROM neiist.get_order(p_order_id, NULL) g;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.is_valid_order_transition(
  neiist.shop_order_status_enum, neiist.shop_order_status_enum
) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.set_order_state(
  INTEGER, neiist.shop_order_status_enum, TEXT, neiist.shop_order_status_enum
) TO neiist_app_user;

-- ---------------------------------------------------------------------------------------------
-- #100
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION neiist.new_order_capped(
  p_user_istid              VARCHAR(50),
  p_customer_name           TEXT,
  p_customer_email          TEXT,
  p_customer_phone          TEXT,
  p_nif                     TEXT,
  p_campus                  TEXT,
  p_notes                   TEXT,
  p_payment_method          TEXT,
  p_payment_reference       TEXT,
  p_created_by              TEXT,
  p_items                   JSONB,
  p_discount_code           TEXT    DEFAULT NULL,
  p_stock_override          BOOLEAN DEFAULT FALSE,
  p_max_quantity_per_user   INTEGER DEFAULT NULL,
  p_quantity_limit_category TEXT    DEFAULT NULL
) RETURNS TABLE (
  id INTEGER, order_number TEXT, customer_name TEXT, user_istid VARCHAR(50),
  customer_email TEXT, customer_phone TEXT, customer_nif TEXT, campus TEXT,
  pickup_deadline TIMESTAMPTZ, items JSONB, notes TEXT, discount_code TEXT,
  discount_amount NUMERIC(10,2), total_amount NUMERIC(10,2), payment_method TEXT,
  payment_reference TEXT, created_by TEXT, created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
  payment_checked_by TEXT, delivered_at TIMESTAMPTZ, delivered_by TEXT,
  updated_at TIMESTAMPTZ, updated_by TEXT, status TEXT
) AS $$
DECLARE
  v_category         TEXT := NULLIF(BTRIM(COALESCE(p_quantity_limit_category, '')), '');
  v_cap_product_name TEXT;
  v_cap_total        INTEGER;
BEGIN
  IF p_max_quantity_per_user IS NOT NULL AND p_user_istid IS NOT NULL AND v_category IS NOT NULL
  THEN
    -- Transaction-scoped: released on COMMIT *or* ROLLBACK, so the RAISE below cannot leak it.
    -- Keyed on user+category, so two different students never contend. This is the only place
    -- the lock is taken, and it is always taken before new_order's product/variant row locks,
    -- so it cannot participate in a lock-ordering cycle.
    PERFORM pg_advisory_xact_lock(
      hashtext('neiist.order_user_quantity_cap'),
      hashtext(lower(p_user_istid) || '|' || lower(v_category))
    );
  END IF;

  -- Delegate. Everything about stock, discounts and totals stays in one place.
  RETURN QUERY
  SELECT * FROM neiist.new_order(
    p_user_istid, p_customer_name, p_customer_email, p_customer_phone, p_nif, p_campus,
    p_notes, p_payment_method, p_payment_reference, p_created_by, p_items, p_discount_code,
    p_stock_override
  );

  IF p_max_quantity_per_user IS NOT NULL AND p_user_istid IS NOT NULL AND v_category IS NOT NULL
  THEN
    -- Counts the rows just inserted: they are visible to this transaction. The predicate matches
    -- neiist.get_user_ordered_products_in_category exactly, including status <> 'cancelled', so
    -- the authority and the route's fast pre-check agree.
    SELECT MAX(oi.product_name), SUM(oi.quantity)::INT
      INTO v_cap_product_name, v_cap_total
    FROM neiist.order_items oi
    JOIN neiist.orders     o ON o.id = oi.order_id
    JOIN neiist.products   p ON p.id = oi.product_id
    JOIN neiist.categories c ON c.id = p.category_id
    WHERE o.user_istid = p_user_istid
      AND o.status <> 'cancelled'
      AND lower(c.name) = lower(v_category)
    GROUP BY oi.product_id
    HAVING SUM(oi.quantity) > p_max_quantity_per_user
    LIMIT 1;

    IF FOUND THEN
      -- Aborts the whole transaction: the order row, its items, the stock decrements and any
      -- discount redemption all roll back together.
      RAISE EXCEPTION
        'Per-user quantity limit reached for % : % ordered, limit %',
        COALESCE(v_cap_product_name, 'product'), v_cap_total, p_max_quantity_per_user
        USING ERRCODE = 'NEI03';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.new_order_capped(
  VARCHAR(50), TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN,
  INTEGER, TEXT
) TO neiist_app_user;
