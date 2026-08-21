-- 005: missing indexes and integrity constraints (#85)
--
-- ⚠️ Replaces one foreign key and adds constraints. Production's schema and data are unmeasured
-- (#152); the CHECK constraints are added NOT VALID for exactly that reason — see below.
--
-- ## Indexes
--
-- Every one of these sits behind a foreign key or a column used in WHERE/JOIN. Purely additive:
-- no behaviour change, so nothing here can break a deploy.
--
-- Two from the issue's list are deliberately skipped:
--   * orders.status — idx_orders_status_created_at (added in 002) already leads with status, and
--     Postgres uses a composite index for a predicate on its leading column. A standalone index
--     would be redundant storage and another thing to keep updated on write.
--   * orders(status, created_at DESC) — that is idx_orders_status_created_at.
--
-- ## Constraints, and why NOT VALID
--
-- A CHECK added the ordinary way scans the table and FAILS the migration if any existing row
-- violates it. Against a database whose contents nobody has measured, that turns a data problem
-- into a failed deploy at the worst moment. NOT VALID applies the constraint to every INSERT and
-- UPDATE from now on while leaving existing rows unscanned — the whole benefit, none of the risk.
--
-- Once #152 has measured production, each can be promoted with:
--     ALTER TABLE neiist.orders VALIDATE CONSTRAINT orders_total_amount_non_negative;
-- which takes only a SHARE UPDATE EXCLUSIVE lock and does not block reads or writes.
--
-- Checked against the dev database first: zero violating rows for every constraint below.
--
-- ## What this migration deliberately does NOT do
--
-- The issue asks for foreign keys on created_by / updated_by / delivered_by /
-- payment_checked_by. They must not be added. Those columns legitimately hold sentinels that are
-- not istids — 'system-cron' from the auto-cancel sweep, and the SumUp actor strings
-- ('sumup-webhook', 'sumup-return', 'sumup-tpa', 'sumup-verify') that #79 relies on to record
-- which entry point finalized a payment. An FK would make the auto-cancel sweep and every
-- webhook finalization fail. Modelling the actor properly is a design change, not a constraint.
--
-- Idempotent: IF NOT EXISTS on every index, and each constraint guarded on pg_constraint.

-- ---------------------------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------------------------

-- FK with ON DELETE SET NULL and no index: deleting a variant scans the whole table.
CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON neiist.order_items(variant_id);

-- FK joined by get_user_ordered_products_in_category, which backs the per-user purchase cap.
CREATE INDEX IF NOT EXISTS idx_products_category_id ON neiist.products(category_id);

-- Composite FK joined by get_user (on the path serverCheckRoles runs for every guarded page)
-- and by get_all_memberships.
CREATE INDEX IF NOT EXISTS idx_membership_department_role
  ON neiist.membership(department_name, role_name);

-- PK is (event_id, user_istid), so "which events has this person signed up to" scans.
CREATE INDEX IF NOT EXISTS idx_activities_sign_up_user
  ON neiist.activities_sign_up(user_istid);

-- Every email-verification lookup filters on token; neither column was indexed.
CREATE INDEX IF NOT EXISTS idx_email_token_token ON neiist.email_token(token);
CREATE INDEX IF NOT EXISTS idx_email_token_istid ON neiist.email_token(istid);

-- validate_discount_code filters WHERE UPPER(code) = …, which cannot use idx_discount_codes_code.
-- Making it UNIQUE also closes a case-collision hole: 'save10' and 'SAVE10' both satisfy the
-- case-sensitive UNIQUE(code) yet collide at validation time, so one of them silently shadows
-- the other.
--
-- Created non-unique first would be pointless; if this fails, two codes already differ only by
-- case and a human has to choose which survives. Deliberately not IF NOT EXISTS-guarded away
-- from that failure — a silent skip would leave the hole open.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_code_upper
  ON neiist.discount_codes (UPPER(code));

-- ---------------------------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------------------------

DO $$
BEGIN
  -- Money cannot be negative. #81 documents how update_order can currently produce a negative
  -- total: it subtracts a fixed discount from a recomputed line total without re-validating the
  -- discount against the new items, so editing €25 of goods down to €3 with a €20 code yields
  -- -17.00. That value then reaches SumUp, whose amount <= 0 guard rejects it, leaving an order
  -- that cannot be paid. This constraint makes the database refuse the write instead.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_amount_non_negative') THEN
    ALTER TABLE neiist.orders
      ADD CONSTRAINT orders_total_amount_non_negative CHECK (total_amount >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_amount_non_negative') THEN
    ALTER TABLE neiist.orders
      ADD CONSTRAINT orders_discount_amount_non_negative CHECK (discount_amount >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_price_non_negative') THEN
    ALTER TABLE neiist.products
      ADD CONSTRAINT products_price_non_negative CHECK (price >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_prices_non_negative') THEN
    ALTER TABLE neiist.order_items
      ADD CONSTRAINT order_items_prices_non_negative
      CHECK (unit_price >= 0 AND total_price >= 0) NOT VALID;
  END IF;

  -- A percentage discount above 100 is free goods: new_order clamps with LEAST, so the total
  -- lands at exactly 0.00 rather than erroring. discount_value already has CHECK (>= 0) but no
  -- upper bound, so nothing stopped an admin typing 500.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discount_codes_percentage_max') THEN
    ALTER TABLE neiist.discount_codes
      ADD CONSTRAINT discount_codes_percentage_max
      CHECK (discount_type <> 'percentage' OR discount_value <= 100) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activities_end_after_start') THEN
    ALTER TABLE neiist.activities
      ADD CONSTRAINT activities_end_after_start CHECK ("end" >= start) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- ON DELETE: order line items are financial records
-- ---------------------------------------------------------------------------------------------

-- order_items.order_id was ON DELETE CASCADE, so deleting an order silently destroyed its line
-- items — the record of what was actually bought and for how much. Orders are cancelled, never
-- deleted: nothing in the codebase issues DELETE FROM neiist.orders, so RESTRICT costs nothing
-- today and turns a future accident into an error rather than lost financial history.
ALTER TABLE neiist.order_items DROP CONSTRAINT IF EXISTS order_items_order_id_fkey;
ALTER TABLE neiist.order_items
  ADD CONSTRAINT order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES neiist.orders(id) ON DELETE RESTRICT;
