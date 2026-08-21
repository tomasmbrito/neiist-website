import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * #85 — the database now refuses writes it used to accept.
 *
 * These assert the *constraints*, not application code, because that is the point: the
 * application already tries to keep money non-negative and it still produced -17.00 (see #81).
 * A constraint is the layer that holds when the application is wrong.
 *
 * The CHECKs are added NOT VALID, since production's data is unmeasured (#152). NOT VALID means
 * existing rows are not scanned — it does NOT mean the constraint is inert for new writes, and
 * that distinction is exactly what these tests pin.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
let owner: Client;

const expectRejected = async (sql: string, constraint: string) => {
  await expect(owner.query(sql)).rejects.toMatchObject({ constraint });
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(
    `INSERT INTO neiist.products (id, name, description, price, category_id, stock_type,
       stock_quantity, active)
     VALUES (940, 'Integrity Fixture', 'test', 10.00, 1, 'limited', 10, true)
     ON CONFLICT (id) DO NOTHING`
  );
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.products WHERE id = 940");
  await owner.query("DELETE FROM neiist.discount_codes WHERE code LIKE 'ZZTEST%'");
  await owner.query("DELETE FROM neiist.activities WHERE id LIKE 'zz-integrity%'");
  await owner.end();
});

describe("money cannot go negative (#85)", () => {
  it("rejects a negative product price", async () => {
    await expectRejected(
      "UPDATE neiist.products SET price = -1 WHERE id = 940",
      "products_price_non_negative"
    );
  });

  /**
   * The concrete scenario from #81: update_order subtracts a fixed discount from a recomputed
   * line total without re-validating it, so €25 of goods edited down to €3 with a €20 code
   * yields -17.00 — which then reaches SumUp and leaves an unpayable order.
   */
  it("rejects a negative order total", async () => {
    const { rows } = await owner.query<{ id: number }>(
      "SELECT id FROM neiist.orders ORDER BY id LIMIT 1"
    );
    if (rows.length === 0) return; // nothing to update in an empty database
    await expectRejected(
      `UPDATE neiist.orders SET total_amount = -17.00 WHERE id = ${rows[0].id}`,
      "orders_total_amount_non_negative"
    );
  });
});

describe("discount codes (#85)", () => {
  /** new_order clamps with LEAST, so >100% lands at exactly 0.00 rather than erroring — free goods. */
  it("rejects a percentage discount above 100", async () => {
    await expectRejected(
      "INSERT INTO neiist.discount_codes (code, discount_type, discount_value) VALUES ('ZZTEST150','percentage',150)",
      "discount_codes_percentage_max"
    );
  });

  it("allows exactly 100 percent", async () => {
    await expect(
      owner.query(
        "INSERT INTO neiist.discount_codes (code, discount_type, discount_value) VALUES ('ZZTEST100','percentage',100)"
      )
    ).resolves.toBeDefined();
  });

  it("allows a fixed discount above 100, which is a euro amount not a percentage", async () => {
    await expect(
      owner.query(
        "INSERT INTO neiist.discount_codes (code, discount_type, discount_value) VALUES ('ZZTESTFIX','fixed',150)"
      )
    ).resolves.toBeDefined();
  });

  /**
   * validate_discount_code filters on UPPER(code), so two codes differing only by case both
   * satisfy the case-sensitive UNIQUE(code) yet collide at validation — one silently shadows
   * the other.
   */
  it("rejects a code that collides case-insensitively with an existing one", async () => {
    await owner.query(
      "INSERT INTO neiist.discount_codes (code, discount_type, discount_value) VALUES ('ZZTESTcase','fixed',5)"
    );
    await expect(
      owner.query(
        "INSERT INTO neiist.discount_codes (code, discount_type, discount_value) VALUES ('ZZTESTCASE','fixed',5)"
      )
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("activities (#85)", () => {
  it("rejects an activity that ends before it starts", async () => {
    await expectRejected(
      `INSERT INTO neiist.activities (id, title, start, "end", last_edited_time)
       VALUES ('zz-integrity-bad', 'X', NOW(), NOW() - INTERVAL '1 day', NOW())`,
      "activities_end_after_start"
    );
  });
});

describe("order line items are financial records (#85)", () => {
  /**
   * order_items.order_id was ON DELETE CASCADE, so deleting an order silently destroyed the
   * record of what was bought and for how much. Nothing in the codebase deletes orders — they
   * are cancelled — so RESTRICT costs nothing and turns a future accident into an error.
   */
  it("refuses to delete an order that has line items", async () => {
    const { rows } = await owner.query<{ order_id: number }>(
      "SELECT order_id FROM neiist.order_items LIMIT 1"
    );
    if (rows.length === 0) return;
    await expect(
      owner.query(`DELETE FROM neiist.orders WHERE id = ${rows[0].order_id}`)
    ).rejects.toMatchObject({ constraint: "order_items_order_id_fkey" });
  });
});

describe("indexes exist for the joins that need them (#85)", () => {
  it.each([
    "idx_order_items_variant_id",
    "idx_products_category_id",
    "idx_membership_department_role",
    "idx_activities_sign_up_user",
    "idx_email_token_token",
    "idx_email_token_istid",
    "idx_discount_codes_code_upper",
  ])("%s", async (name) => {
    const { rows } = await owner.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'neiist' AND indexname = $1",
      [name]
    );
    expect(rows).toHaveLength(1);
  });
});
