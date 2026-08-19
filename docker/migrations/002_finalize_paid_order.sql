-- 002: atomic, idempotent payment finalization (#79), plus the reference rule the in-person
--      payment flow needs (#154)
--
-- The problem: finalizePaidOrder was check-then-act across three round-trips on three different
-- pooled connections — read the order, decide in JavaScript, set the status, update the
-- reference. There are FIVE entry points into it (SumUp verify, the browser return, the SumUp
-- webhook, the card reader callback, and a manager pressing Pay), and a card-reader payment plus
-- a browser return plus a webhook for the same purchase is the NORMAL case, not a pathological
-- one. Each of them ran its own `["paid","ready","delivered"].includes(status)` pre-check, so
-- there were five copies of the same racy test and none of them was the authority.
--
-- Two callers 50ms apart both saw 'pending', both wrote 'paid', both sent a receipt and both ran
-- the after-purchase action — which for jantar de curso means signing the student up to the
-- event twice.
--
-- This moves the decision inside one function that holds a row lock, so exactly one caller can
-- win. The loser blocks on the lock, wakes to find 'paid', and is told `finalized = false` — a
-- value the database decided, rather than a stale read. Only `finalized = true` may send an
-- email or run an after-purchase action.
--
-- On the payment reference: it is required only for the SumUp-backed methods, which are the only
-- ones that HAVE an external reference. Confirmed with Tomás: a SumUp online payment is
-- finalized automatically, while an in-person payment waits for a manager to mark it paid — and
-- that manager has no reference to type. The old rule (`payment_method <> 'cash'`) rejected
-- 'in-person', 'mbway' and 'transfer', which is exactly the flow it was meant to serve (#154).
--
-- Idempotent: CREATE OR REPLACE over a function that does not exist yet, then over itself.

CREATE OR REPLACE FUNCTION neiist.payment_method_requires_reference(p_method TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  -- Only the SumUp-backed methods carry an external transaction id. Everything else is
  -- confirmed by a human, who may have nothing to record. NULL is treated as manual.
  SELECT lower(COALESCE(p_method, '')) IN ('card', 'sumup', 'sumup-tpa');
$$;

CREATE OR REPLACE FUNCTION neiist.finalize_paid_order(
  p_order_id          INTEGER,
  p_payment_reference TEXT,
  p_actor             TEXT
) RETURNS TABLE (
  finalized          BOOLEAN,
  previous_status    TEXT,
  id                 INT,
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
  -- One winner. Every other concurrent finalization blocks here and, on waking, re-reads the row
  -- it now holds the lock on (READ COMMITTED re-evaluates FOR UPDATE against the latest committed
  -- version), so it sees 'paid' and takes the replay branch below.
  --
  -- DO NOT add any network call between this lock and the end of the function. All SumUp HTTP
  -- already happens before it. Moving one inside turns a 200ms lock into a 30s one and stalls
  -- every concurrent finalization for the same order.
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
    -- Replayed webhook or a second entry point for the same purchase. Success, no side effects:
    -- the caller must not email or re-run the after-purchase action.
    v_finalized := FALSE;
  ELSE
    IF neiist.payment_method_requires_reference(v_method) AND v_reference IS NULL THEN
      RAISE EXCEPTION 'Payment reference is required for order %', p_order_id
        USING ERRCODE = 'NEI05';
    END IF;

    UPDATE neiist.orders o
    SET status             = 'paid',
        -- COALESCE, not NOW(): preserve when the money actually arrived if this ever runs twice.
        paid_at            = COALESCE(o.paid_at, NOW()),
        payment_checked_by = COALESCE(o.payment_checked_by, p_actor),
        -- Keep an existing reference rather than blanking it when a manual finalization carries
        -- none. A reference that was recorded is evidence; absence of one is not.
        payment_reference  = COALESCE(v_reference, o.payment_reference),
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
  FROM neiist.get_order(p_order_id, NULL) g;   -- single-row read; NOT get_all_orders()
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION neiist.finalize_paid_order(INTEGER, TEXT, TEXT) TO neiist_app_user;
GRANT EXECUTE ON FUNCTION neiist.payment_method_requires_reference(TEXT) TO neiist_app_user;

-- The FK every order read joins on, absent until now (schema.sql indexes order_items.product_id,
-- not order_id). Free to add while the order functions are being reworked anyway.
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON neiist.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON neiist.orders(status, created_at);
