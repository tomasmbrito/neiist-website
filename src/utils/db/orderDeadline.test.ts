import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newOrder } from "@/utils/db/shopQueries";

/**
 * #174 — the order deadline was guarded on the stock type, so a `limited` product past its
 * deadline was still orderable. Reproduced before the fix: an order one day past the deadline
 * was accepted, and POST /api/shop/orders returned 200.
 *
 * The decision recorded in decision-log.md is that the deadline applies to every stock type:
 * stock is replenishable, while the deadline is a separate promise about when the núcleo places
 * the production order, and it is shown to students per product.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const TEST_ISTID = "ist9990905";
const LIMITED_PAST = 960;
const ON_DEMAND_PAST = 961;
const LIMITED_FUTURE = 962;

let owner: Client;

const order = (productId: number, stockOverride = false) =>
  newOrder(
    {
      user_istid: TEST_ISTID,
      customer_name: "Deadline Test",
      campus: "Alameda",
      payment_method: "in-person",
      created_by: TEST_ISTID,
      items: [{ product_id: productId, quantity: 1 }],
    },
    stockOverride
  );

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Deadline Test', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [TEST_ISTID, `${TEST_ISTID}@tecnico.ulisboa.pt`]
  );
  const fixture = async (id: number, stockType: string, offset: string) =>
    owner.query(
      `INSERT INTO neiist.products (id, name, description, price, category_id, stock_type,
         stock_quantity, active, order_deadline)
       VALUES ($1, $4, 'test', 10.00, 1, $2::neiist.shop_stock_type_enum,
         100, true, NOW() + $3::interval)
       ON CONFLICT (id) DO UPDATE
         SET stock_type = EXCLUDED.stock_type,
             stock_quantity = 100,
             order_deadline = EXCLUDED.order_deadline`,
      [id, stockType, offset, `Deadline Fixture ${id}`]
    );
  await fixture(LIMITED_PAST, "limited", "-1 day");
  await fixture(ON_DEMAND_PAST, "on_demand", "-1 day");
  await fixture(LIMITED_FUTURE, "limited", "7 days");
});

afterEach(async () => {
  await owner.query(
    `DELETE FROM neiist.order_items WHERE order_id IN
       (SELECT id FROM neiist.orders WHERE user_istid = $1)`,
    [TEST_ISTID]
  );
  await owner.query("DELETE FROM neiist.orders WHERE user_istid = $1", [TEST_ISTID]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.products WHERE id = ANY($1)", [
    [LIMITED_PAST, ON_DEMAND_PAST, LIMITED_FUTURE],
  ]);
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [TEST_ISTID]);
  await owner.end();
});

describe("the order deadline (#174)", () => {
  /** The regression this issue is about: `limited` used to slip through the guard entirely. */
  it("rejects a limited-stock product past its deadline", async () => {
    await expect(order(LIMITED_PAST)).rejects.toThrow(/Order deadline has passed/);
  });

  it("still rejects an on_demand product past its deadline", async () => {
    await expect(order(ON_DEMAND_PAST)).rejects.toThrow(/Order deadline has passed/);
  });

  it("accepts a limited-stock product whose deadline has not passed", async () => {
    const created = await order(LIMITED_FUTURE);
    expect(created?.id).toBeGreaterThan(0);
  });

  /**
   * An admin taking a sale at a stand bypasses the deadline. That was already true and is
   * deliberate — the check exists to stop students ordering after the production run is placed,
   * not to stop the núcleo selling stock it already has in a box.
   */
  it("lets stock_override bypass it, so POS sales still work", async () => {
    const created = await order(LIMITED_PAST, true);
    expect(created?.id).toBeGreaterThan(0);
  });
});
