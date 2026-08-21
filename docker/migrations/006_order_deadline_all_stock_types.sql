-- 006: enforce the order deadline for every stock type, not only on_demand (#174)
--
-- ⚠️ Replaces neiist.new_order and neiist.update_order. Production's schema is unmeasured —
-- run `yarn db:schema-diff` (#152) before applying this anywhere real.
--
-- ## What was wrong
--
-- The check was guarded on the stock type, in BOTH functions:
--
--     IF v_stock_type = 'on_demand' AND v_order_deadline IS NOT NULL AND NOW() > v_order_deadline
--
-- so a `limited`-stock product whose order_deadline had passed was still orderable. Reproduced
-- against the database: a product with a deadline one day in the past accepted an order, and
-- POST /api/shop/orders returned 200.
--
-- ## Why enforce it everywhere
--
-- The argument for the old behaviour is "limited stock is already bounded by stock, so a
-- deadline is advisory there". It does not hold. Stock is replenishable, and the deadline is a
-- separate promise about WHEN the núcleo places the production order — the two limits mean
-- different things. order_deadline is set per product in the product form and shown to students,
-- so a limited-stock sweat advertising "encomenda até 20/08" that takes an order on 21/08 is a
-- commitment somebody then has to honour or refund.
--
-- p_stock_override still bypasses the check, so an admin taking a POS sale at a stand is
-- unaffected. That was already true and is deliberate.
--
-- ## How this file was produced
--
-- The two function bodies below are EXTRACTED from docker/schema.sql by a script rather than
-- copied by hand, so the migration and the file cannot disagree. The only difference from the
-- previous definitions is the removal of `v_stock_type = 'on_demand' AND`.
--
-- Idempotent: CREATE OR REPLACE over full bodies.

CREATE OR REPLACE FUNCTION neiist.new_order(
  p_user_istid VARCHAR(50),
  p_customer_name TEXT,
  p_customer_email TEXT,
  p_customer_phone TEXT,
  p_nif TEXT,
  p_campus TEXT,
  p_notes TEXT,
  p_payment_method TEXT,
  p_payment_reference TEXT,
  p_created_by TEXT,
  p_items JSONB,
  p_discount_code TEXT DEFAULT NULL,
  p_stock_override BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  id INTEGER,
  order_number TEXT,
  customer_name TEXT,
  user_istid VARCHAR(50),
  customer_email TEXT,
  customer_phone TEXT,
  customer_nif TEXT,
  campus TEXT,
  pickup_deadline TIMESTAMPTZ,
  items JSONB,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  status TEXT
) AS $$
DECLARE
  v_order_id INTEGER;
  v_customer_name TEXT;
  v_customer_email TEXT;
  v_customer_phone TEXT;
  it JSONB;
  v_pid INTEGER;
  v_vid INTEGER;
  v_qty INTEGER;
  v_base NUMERIC(10,2);
  v_unit NUMERIC(10,2);
  v_total NUMERIC(10,2) := 0;
  v_stock_type neiist.shop_stock_type_enum;
  v_order_deadline TIMESTAMPTZ;
  v_variant_stock INTEGER;
  v_product_stock INTEGER;
  v_pname TEXT;
  v_v_label TEXT;
  v_v_opts JSONB;
  v_discount_code TEXT := NULL;
  v_discount_amount NUMERIC(10,2) := 0;
  v_discount_result RECORD;
BEGIN
  v_customer_name := CASE
    WHEN p_user_istid IS NOT NULL THEN NULL
    ELSE NULLIF(BTRIM(p_customer_name), '')
  END;

  v_customer_email := CASE
    WHEN p_user_istid IS NOT NULL THEN NULL
    ELSE NULLIF(BTRIM(p_customer_email), '')
  END;

  v_customer_phone := CASE
    WHEN p_user_istid IS NOT NULL THEN NULL
    ELSE NULLIF(BTRIM(p_customer_phone), '')
  END;

  INSERT INTO neiist.orders(
    user_istid,
    customer_name,
    customer_email,
    customer_phone,
    nif,
    campus,
    notes,
    discount_code,
    discount_amount,
    payment_method,
    payment_reference,
    created_by
  )
  VALUES (
    p_user_istid,
    v_customer_name,
    v_customer_email,
    v_customer_phone,
    p_nif,
    p_campus,
    p_notes,
    NULL,
    NULL,
    p_payment_method,
    p_payment_reference,
    p_created_by
  )
  RETURNING orders.id INTO v_order_id;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_pid := (it->>'product_id')::INTEGER;
    v_vid := NULLIF(it->>'variant_id','')::INTEGER;
    v_qty := (it->>'quantity')::INTEGER;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity for product_id %', v_pid;
    END IF;

    SELECT p.name, p.price, p.stock_type, p.stock_quantity, p.order_deadline
      INTO v_pname, v_base, v_stock_type, v_product_stock, v_order_deadline
    FROM neiist.products p
    WHERE p.id = v_pid AND p.active = TRUE;

    IF v_pname IS NULL THEN
      RAISE EXCEPTION 'Product % not found or inactive', v_pid;
    END IF;

    IF NOT p_stock_override THEN
      -- Every stock type, not just on_demand (#174). Stock is replenishable; the deadline is a
        -- separate promise about when the production order is placed, and it is shown to
        -- students per product. p_stock_override still bypasses it, for POS sales.
        IF v_order_deadline IS NOT NULL AND NOW() > v_order_deadline THEN
        RAISE EXCEPTION 'Order deadline has passed for product % (%)', v_pid, v_pname;
      END IF;
    END IF;

    IF v_vid IS NOT NULL THEN
      -- Lock variant row for stock check
      PERFORM 1 FROM neiist.product_variants WHERE product_variants.id = v_vid AND product_variants.product_id = v_pid AND product_variants.active = TRUE FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant % for product % not found or inactive', v_vid, v_pid;
      END IF;

      SELECT
        NULLIF((
          SELECT string_agg(pvo.option_name || ': ' || pvo.option_value, ' | ' ORDER BY pvo.option_name)
          FROM neiist.product_variant_options pvo
          WHERE pvo.variant_id = pv.id
        ), '') AS label,
        COALESCE((
          SELECT jsonb_object_agg(pvo.option_name, pvo.option_value)
          FROM neiist.product_variant_options pvo
          WHERE pvo.variant_id = pv.id
        ), '{}'::jsonb) AS options,
        pv.price_modifier,
        pv.stock_quantity
      INTO v_v_label, v_v_opts, v_unit, v_variant_stock
      FROM neiist.product_variants pv
      WHERE pv.id = v_vid AND pv.product_id = v_pid;

      v_unit := ROUND(v_base + COALESCE(v_unit,0), 2);

      IF v_stock_type = 'limited' AND NOT p_stock_override THEN
        IF v_variant_stock IS NULL OR v_variant_stock < v_qty THEN
          RAISE EXCEPTION 'Insufficient variant stock (product %, variant %, have %, need %)',
            v_pid, v_vid, COALESCE(v_variant_stock, -1), v_qty;
        END IF;

        UPDATE neiist.product_variants
          SET stock_quantity = stock_quantity - v_qty,
              updated_at = NOW()
          WHERE product_variants.id = v_vid;
      ELSIF v_stock_type = 'limited' AND p_stock_override THEN
        NULL;
      END IF;
    ELSE
      v_v_label := NULL;
      v_v_opts := NULL;
      v_unit := ROUND(v_base, 2);

      IF v_stock_type = 'limited' AND NOT p_stock_override THEN
        SELECT p.stock_quantity INTO v_product_stock
        FROM neiist.products p
        WHERE p.id = v_pid FOR UPDATE;

        IF v_product_stock IS NULL OR v_product_stock < v_qty THEN
          RAISE EXCEPTION 'Insufficient product stock (product %, have %, need %)',
            v_pid, COALESCE(v_product_stock, -1), v_qty;
        END IF;

        UPDATE neiist.products p
        SET stock_quantity = stock_quantity - v_qty
        WHERE p.id = v_pid;
      ELSIF v_stock_type = 'limited' AND p_stock_override THEN
        NULL;
      END IF;
    END IF;

    v_total := v_total + v_unit * v_qty;

    INSERT INTO neiist.order_items(
      order_id, product_id, variant_id, product_name, variant_label, variant_options,
      quantity, unit_price, total_price
    ) VALUES (
      v_order_id, v_pid, v_vid, v_pname, v_v_label, v_v_opts,
      v_qty, v_unit, v_unit * v_qty
    );
  END LOOP;

  IF NULLIF(BTRIM(COALESCE(p_discount_code, '')), '') IS NOT NULL THEN
    SELECT * INTO v_discount_result
    FROM neiist.validate_discount_code(p_discount_code, p_user_istid, p_items);

    IF NOT COALESCE(v_discount_result.is_valid, FALSE) THEN
      RAISE EXCEPTION '%', COALESCE(v_discount_result.error, 'Invalid discount code');
    END IF;

    UPDATE neiist.discount_codes
    SET current_uses = neiist.discount_codes.current_uses + 1,
        updated_at = NOW()
    WHERE neiist.discount_codes.id = v_discount_result.discount_code_id
      AND neiist.discount_codes.active = TRUE
      AND (neiist.discount_codes.expires_at IS NULL OR neiist.discount_codes.expires_at > NOW())
      AND (neiist.discount_codes.max_uses IS NULL OR neiist.discount_codes.current_uses < neiist.discount_codes.max_uses)
    RETURNING neiist.discount_codes.code INTO v_discount_code;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Discount code max uses reached';
    END IF;

    v_discount_amount := LEAST(v_total, COALESCE(v_discount_result.discount_amount, 0));
  END IF;

  UPDATE neiist.orders
  SET
    discount_code = v_discount_code,
    discount_amount = CASE WHEN v_discount_code IS NULL THEN NULL ELSE ROUND(v_discount_amount, 2) END,
    total_amount = ROUND(v_total - COALESCE(v_discount_amount, 0), 2),
    updated_at = NOW(),
    updated_by = p_created_by
  WHERE orders.id = v_order_id;

  RETURN QUERY
  SELECT
    o.id, o.order_number,
    CASE
      WHEN o.user_istid IS NULL THEN COALESCE(o.customer_name, '')
      ELSE COALESCE(u.name, '')
    END AS customer_name,
    o.user_istid,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_email
      ELSE u.email
    END AS customer_email,
    CASE
      WHEN o.user_istid IS NULL THEN o.customer_phone
      ELSE (
        SELECT c.contact_value
        FROM neiist.user_contacts c
        WHERE c.user_istid = o.user_istid AND c.contact_type = 'phone'
        LIMIT 1
      )
    END AS customer_phone,
    o.nif AS customer_nif,
     o.campus,
    o.pickup_deadline,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id,
        'product_name', oi.product_name,
        'variant_id', oi.variant_id,
        'variant_label', oi.variant_label,
        'variant_options', oi.variant_options,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'total_price', oi.total_price
      ) ORDER BY oi.id)
      FROM neiist.order_items oi
      WHERE oi.order_id = o.id
    ), '[]'::JSONB) AS items,
    o.notes, o.discount_code, o.discount_amount, o.total_amount, o.payment_method, o.payment_reference,
    o.created_by,
    o.created_at, o.paid_at, o.payment_checked_by, o.delivered_at, o.delivered_by, o.updated_at, o.updated_by,
    o.status::TEXT
  FROM neiist.orders o
  LEFT JOIN neiist.users u ON u.istid = o.user_istid
  WHERE o.id = v_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION neiist.update_order(
  p_order_id INTEGER,
  p_updates JSONB,
  p_stock_override BOOLEAN DEFAULT FALSE,
  p_user_istid TEXT DEFAULT NULL
) RETURNS TABLE (
  id INTEGER,
  order_number TEXT,
  customer_name TEXT,
  user_istid VARCHAR(50),
  customer_email TEXT,
  customer_phone TEXT,
  customer_nif TEXT,
  campus TEXT,
  items JSONB,
  notes TEXT,
  discount_code TEXT,
  discount_amount NUMERIC(10,2),
  total_amount NUMERIC(10,2),
  payment_method TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_checked_by TEXT,
  pickup_deadline TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  delivered_by TEXT,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  status TEXT
) AS $$
DECLARE
  it JSONB;
  v_pid INTEGER;
  v_vid INTEGER;
  v_qty INTEGER;
  v_base NUMERIC(10,2);
  v_unit NUMERIC(10,2);
  v_total NUMERIC(10,2) := 0;
  v_stock_type neiist.shop_stock_type_enum;
  v_order_deadline TIMESTAMPTZ;
  v_variant_stock INTEGER;
  v_product_stock INTEGER;
  v_pname TEXT;
  v_v_label TEXT;
  v_v_opts JSONB;
  v_existing_discount_amount NUMERIC(10,2) := 0;
BEGIN
  SELECT COALESCE(o.discount_amount, 0)
    INTO v_existing_discount_amount
  FROM neiist.orders o
  WHERE o.id = p_order_id;

  IF p_updates ? 'user_istid' THEN
    UPDATE neiist.orders SET user_istid = NULLIF(p_updates->>'user_istid','') WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'nif' THEN
    UPDATE neiist.orders SET nif = p_updates->>'nif' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'campus' THEN
    UPDATE neiist.orders SET campus = p_updates->>'campus' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'notes' THEN
    UPDATE neiist.orders SET notes = p_updates->>'notes' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'payment_method' THEN
    UPDATE neiist.orders SET payment_method = p_updates->>'payment_method' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'payment_reference' THEN
    UPDATE neiist.orders SET payment_reference = p_updates->>'payment_reference' WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'created_by' THEN
    UPDATE neiist.orders SET created_by = NULLIF(p_updates->>'created_by','') WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'payment_checked_by' THEN
    UPDATE neiist.orders SET payment_checked_by = NULLIF(p_updates->>'payment_checked_by','') WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'pickup_deadline' THEN
    UPDATE neiist.orders SET pickup_deadline = NULLIF(p_updates->>'pickup_deadline','')::timestamptz WHERE neiist.orders.id = p_order_id;
  END IF;
  IF p_updates ? 'delivered_by' THEN
    UPDATE neiist.orders SET delivered_by = NULLIF(p_updates->>'delivered_by','') WHERE neiist.orders.id = p_order_id;
  END IF;

  IF p_updates ? 'items' THEN
    -- Restock previous limited-stock items before replacing the order lines.
    FOR v_pid, v_vid, v_qty IN
      SELECT oi.product_id, oi.variant_id, oi.quantity
      FROM neiist.order_items oi
      WHERE oi.order_id = p_order_id
    LOOP
      SELECT p.stock_type
        INTO v_stock_type
      FROM neiist.products p
      WHERE p.id = v_pid FOR UPDATE;

      IF v_stock_type = 'limited' AND NOT p_stock_override THEN
        IF v_vid IS NOT NULL THEN
          UPDATE neiist.product_variants
            SET stock_quantity = COALESCE(stock_quantity, 0) + v_qty,
                updated_at = NOW()
          WHERE product_variants.id = v_vid AND product_variants.product_id = v_pid;
        ELSE
          UPDATE neiist.products
          SET stock_quantity = COALESCE(stock_quantity, 0) + v_qty
          WHERE products.id = v_pid;
        END IF;
      END IF;
    END LOOP;

    DELETE FROM neiist.order_items WHERE order_id = p_order_id;

    FOR it IN SELECT * FROM jsonb_array_elements(p_updates->'items')
    LOOP
      v_pid := (it->>'product_id')::INTEGER;
      v_vid := NULLIF(it->>'variant_id','')::INTEGER;
      v_qty := (it->>'quantity')::INTEGER;

      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Invalid quantity for product_id %', v_pid;
      END IF;

      SELECT p.name, p.price, p.stock_type, p.order_deadline
        INTO v_pname, v_base, v_stock_type, v_order_deadline
      FROM neiist.products p
      WHERE p.id = v_pid AND p.active = TRUE;

      IF v_pname IS NULL THEN
        RAISE EXCEPTION 'Product % not found or inactive', v_pid;
      END IF;

      IF NOT p_stock_override THEN
        -- Every stock type, not just on_demand (#174). Stock is replenishable; the deadline is a
        -- separate promise about when the production order is placed, and it is shown to
        -- students per product. p_stock_override still bypasses it, for POS sales.
        IF v_order_deadline IS NOT NULL AND NOW() > v_order_deadline THEN
          RAISE EXCEPTION 'Order deadline has passed for product % (%)', v_pid, v_pname;
        END IF;
      END IF;

      IF v_vid IS NOT NULL THEN
        -- Lock variant row for stock check
        PERFORM 1 FROM neiist.product_variants WHERE product_variants.id = v_vid AND product_variants.product_id = v_pid AND product_variants.active = TRUE FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Variant % for product % not found or inactive', v_vid, v_pid;
        END IF;

        SELECT
          NULLIF((
            SELECT string_agg(pvo.option_name || ': ' || pvo.option_value, ' | ' ORDER BY pvo.option_name)
            FROM neiist.product_variant_options pvo
            WHERE pvo.variant_id = pv.id
          ), '') AS label,
          COALESCE((
            SELECT jsonb_object_agg(pvo.option_name, pvo.option_value)
            FROM neiist.product_variant_options pvo
            WHERE pvo.variant_id = pv.id
          ), '{}'::jsonb) AS options,
          pv.price_modifier,
          pv.stock_quantity
        INTO v_v_label, v_v_opts, v_unit, v_variant_stock
        FROM neiist.product_variants pv
        WHERE pv.id = v_vid AND pv.product_id = v_pid;

        v_unit := ROUND(v_base + COALESCE(v_unit, 0), 2);

        IF v_stock_type = 'limited' AND NOT p_stock_override THEN
          IF v_variant_stock IS NULL OR v_variant_stock < v_qty THEN
            RAISE EXCEPTION 'Insufficient variant stock (product %, variant %, have %, need %)',
              v_pid, v_vid, COALESCE(v_variant_stock, -1), v_qty;
          END IF;

          UPDATE neiist.product_variants
            SET stock_quantity = stock_quantity - v_qty,
                updated_at = NOW()
            WHERE product_variants.id = v_vid;
        ELSIF v_stock_type = 'limited' AND p_stock_override THEN
          NULL;
        END IF;
      ELSE
        v_v_label := NULL;
        v_v_opts := NULL;
        v_unit := ROUND(v_base, 2);

        IF v_stock_type = 'limited' AND NOT p_stock_override THEN
          SELECT p.stock_quantity INTO v_product_stock
          FROM neiist.products p
          WHERE p.id = v_pid FOR UPDATE;

          IF v_product_stock IS NULL OR v_product_stock < v_qty THEN
            RAISE EXCEPTION 'Insufficient product stock (product %, have %, need %)',
              v_pid, COALESCE(v_product_stock, -1), v_qty;
          END IF;

          UPDATE neiist.products p
          SET stock_quantity = stock_quantity - v_qty
          WHERE p.id = v_pid;
        ELSIF v_stock_type = 'limited' AND p_stock_override THEN
          NULL;
        END IF;
      END IF;

      v_total := v_total + v_unit * v_qty;

      INSERT INTO neiist.order_items(
        order_id, product_id, variant_id, product_name, variant_label, variant_options,
        quantity, unit_price, total_price
      ) VALUES (
        p_order_id, v_pid, v_vid, v_pname, v_v_label, v_v_opts,
        v_qty, v_unit, v_unit * v_qty
      );
    END LOOP;

    UPDATE neiist.orders SET total_amount = ROUND(v_total - COALESCE(v_existing_discount_amount, 0), 2), updated_by = p_user_istid WHERE neiist.orders.id = p_order_id;
  END IF;

  UPDATE neiist.orders SET updated_at = NOW(), updated_by = p_user_istid WHERE neiist.orders.id = p_order_id;

  RETURN QUERY
  SELECT
    g.id,
    g.order_number,
    g.customer_name,
    g.user_istid,
    g.customer_email,
    g.customer_phone,
    g.customer_nif,
    g.campus,
    g.items,
    g.notes,
    g.discount_code,
    g.discount_amount,
    g.total_amount,
    g.payment_method,
    g.payment_reference,
    g.created_by,
    g.created_at,
    g.paid_at,
    g.payment_checked_by,
    g.pickup_deadline,
    g.delivered_at,
    g.delivered_by,
    g.updated_at,
    g.updated_by,
    g.status::TEXT
  FROM neiist.get_all_orders() g
  WHERE g.id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
