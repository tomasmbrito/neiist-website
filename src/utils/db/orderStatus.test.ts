import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newOrder, setOrderState } from "@/utils/db/shopQueries";

/**
 * #78 (guarded status transitions, auto-cancel race) and #100 (per-user cap TOCTOU).
 *
 * Both are races, so both are tested with two real connections and a transaction held open.
 * `Promise.all` is not enough — see the note in orderPayment.test.ts, where that mistake made a
 * concurrency test pass against a deliberately broken function.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEST_ISTID = "ist9990903";
const TEST_PRODUCT_ID = 903;
/**
 * A second fixture with `on_demand` stock, used only by the concurrency test.
 *
 * This matters. `neiist.new_order` takes `FOR UPDATE` on the product row **only** when the stock
 * type is `limited` and there is no stock override (`schema.sql:2264-2267`). For a `limited`
 * product that row lock incidentally serialises two checkouts of the same product, which made an
 * earlier version of the race test pass even with the advisory lock removed.
 *
 * `on_demand` is also the realistic case: jantar de curso is the only kind that has a cap
 * (`orderKind.ts:60`), and a dinner ticket is not limited stock. With no row lock to borrow, the
 * advisory lock in `new_order_capped` is the only thing standing between a double-clicked
 * Checkout and two tickets.
 */
const TEST_ON_DEMAND_PRODUCT_ID = 904;
const TEST_CATEGORY_ID = 1;

let owner: Client;
let categoryName: string;

const createOrder = async (quantity = 1): Promise<number> => {
  const { rows } = await owner.query<{ id: number }>(
    `SELECT id FROM neiist.new_order($1::VARCHAR(50), 'Status Test', $2, NULL, NULL, 'Alameda',
       NULL, 'in-person', NULL, $1, $3::jsonb, NULL, false)`,
    [
      TEST_ISTID,
      `${TEST_ISTID}@tecnico.ulisboa.pt`,
      JSON.stringify([{ product_id: TEST_PRODUCT_ID, variant_id: null, quantity }]),
    ]
  );
  return rows[0].id;
};

const statusOf = async (orderId: number): Promise<string> => {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status::TEXT FROM neiist.orders WHERE id = $1",
    [orderId]
  );
  return rows[0].status;
};

const stockOf = async (): Promise<number> => {
  const { rows } = await owner.query<{ stock_quantity: number }>(
    "SELECT stock_quantity FROM neiist.products WHERE id = $1",
    [TEST_PRODUCT_ID]
  );
  return Number(rows[0].stock_quantity);
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();

  const { rows } = await owner.query<{ name: string }>(
    "SELECT name FROM neiist.categories WHERE id = $1",
    [TEST_CATEGORY_ID]
  );
  categoryName = rows[0].name;

  await owner.query(
    `INSERT INTO neiist.products (id, name, description, price, category_id, stock_type,
       stock_quantity, active)
     VALUES ($1, 'Status Test Product', 'test fixture', 10.00, $2, 'limited', 500, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_PRODUCT_ID, TEST_CATEGORY_ID]
  );
  await owner.query(
    `INSERT INTO neiist.products (id, name, description, price, category_id, stock_type,
       stock_quantity, active)
     VALUES ($1, 'Cap Race Product', 'on_demand fixture', 10.00, $2, 'on_demand', 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_ON_DEMAND_PRODUCT_ID, TEST_CATEGORY_ID]
  );
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Status Test', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [TEST_ISTID, `${TEST_ISTID}@tecnico.ulisboa.pt`]
  );
});

afterEach(async () => {
  await owner.query(
    `DELETE FROM neiist.order_items WHERE order_id IN
       (SELECT id FROM neiist.orders WHERE user_istid = $1)`,
    [TEST_ISTID]
  );
  await owner.query("DELETE FROM neiist.orders WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("UPDATE neiist.products SET stock_quantity = 500 WHERE id = $1", [
    TEST_PRODUCT_ID,
  ]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.products WHERE id = ANY($1)", [
    [TEST_PRODUCT_ID, TEST_ON_DEMAND_PRODUCT_ID],
  ]);
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [TEST_ISTID]);
  await owner.end();
});

describe("setOrderState — the transition matrix (#78)", () => {
  it("allows pending -> cancelled", async () => {
    const orderId = await createOrder();
    const result = await setOrderState(orderId, "cancelled", "manager", "pending");
    expect(result?.changed).toBe(true);
    expect(await statusOf(orderId)).toBe("cancelled");
  });

  /**
   * The flow Tomás described: a SumUp payment finalizes itself, an in-person payment waits for a
   * manager to mark it paid. So 'pending' means pending PAYMENT and nothing may skip it.
   */
  it.each(["ready", "delivered"] as const)("rejects pending -> %s", async (target) => {
    const orderId = await createOrder();
    await expect(setOrderState(orderId, target, "manager", "pending")).rejects.toMatchObject({
      code: "NEI02",
    });
    expect(await statusOf(orderId)).toBe("pending");
  });

  /**
   * #78 scenario A. trg_restock_limited_on_cancel has already returned the stock and there is no
   * compensating re-decrement, so leaving 'cancelled' hands out units nobody bought.
   */
  it("makes cancelled terminal, so stock cannot be minted", async () => {
    const before = await stockOf();
    const orderId = await createOrder();
    expect(await stockOf()).toBe(before - 1);

    await setOrderState(orderId, "cancelled", "manager", "pending");
    const afterCancel = await stockOf();
    expect(afterCancel).toBe(before); // restocked exactly once

    await expect(setOrderState(orderId, "pending", "manager", null)).rejects.toMatchObject({
      code: "NEI02",
    });
    expect(await stockOf()).toBe(before); // and not a second time
  });

  it("treats setting the same status again as a no-op rather than an error", async () => {
    const orderId = await createOrder();
    const result = await setOrderState(orderId, "pending", "manager", "pending");
    expect(result?.changed).toBe(false);
    expect(result?.previousStatus).toBe("pending");
  });

  it("returns null when the expectation is stale, without writing", async () => {
    const orderId = await createOrder();
    await setOrderState(orderId, "cancelled", "manager", "pending");

    // A caller that still believes the order is pending must not be able to act on that.
    const stale = await setOrderState(orderId, "paid", "manager", "pending");
    expect(stale).toBeNull();
    expect(await statusOf(orderId)).toBe("cancelled");
  });

  it("reports a missing order rather than silently doing nothing", async () => {
    await expect(setOrderState(999_999_999, "cancelled", "manager", null)).rejects.toMatchObject({
      code: "NEI01",
    });
  });
});

describe("the per-user purchase cap (#100)", () => {
  const cap = { maxQuantityPerUser: 1, categoryName: "" };

  it("allows an order up to the cap", async () => {
    const order = await newOrder(
      {
        user_istid: TEST_ISTID,
        customer_name: "Cap Test",
        customer_email: `${TEST_ISTID}@tecnico.ulisboa.pt`,
        campus: "Alameda",
        payment_method: "in-person",
        created_by: TEST_ISTID,
        items: [{ product_id: TEST_PRODUCT_ID, quantity: 1 }],
      },
      false,
      { ...cap, categoryName }
    );
    expect(order?.id).toBeGreaterThan(0);
  });

  it("rejects an order that exceeds the cap, and rolls the whole order back", async () => {
    const stockBefore = await stockOf();

    await newOrder(
      {
        user_istid: TEST_ISTID,
        customer_name: "Cap Test",
        campus: "Alameda",
        payment_method: "in-person",
        created_by: TEST_ISTID,
        items: [{ product_id: TEST_PRODUCT_ID, quantity: 1 }],
      },
      false,
      { ...cap, categoryName }
    );

    await expect(
      newOrder(
        {
          user_istid: TEST_ISTID,
          customer_name: "Cap Test",
          campus: "Alameda",
          payment_method: "in-person",
          created_by: TEST_ISTID,
          items: [{ product_id: TEST_PRODUCT_ID, quantity: 1 }],
        },
        false,
        { ...cap, categoryName }
      )
    ).rejects.toMatchObject({ code: "NEI03" });

    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*)::TEXT FROM neiist.orders WHERE user_istid = $1 AND status <> 'cancelled'",
      [TEST_ISTID]
    );
    expect(rows[0].count).toBe("1");

    // The rejected order's stock decrement rolled back with it: exactly one unit is gone.
    expect(await stockOf()).toBe(stockBefore - 1);
  });

  /**
   * The #100 regression guard. Without the advisory lock both checkouts read "0 ordered so far",
   * both pass, and the student ends up with two of a one-per-person item.
   */
  it("serialises two concurrent checkouts by the same user, so only one succeeds", async () => {
    const sessionA = new Client({ connectionString: OWNER_URL });
    await sessionA.connect();

    const call = `SELECT id FROM neiist.new_order_capped($1::VARCHAR(50), 'Cap Race', NULL, NULL,
        NULL, 'Alameda', NULL, 'in-person', NULL, $1, $2::jsonb, NULL, false, 1, $3)`;
    const args = [
      TEST_ISTID,
      JSON.stringify([{ product_id: TEST_ON_DEMAND_PRODUCT_ID, variant_id: null, quantity: 1 }]),
      categoryName,
    ];

    try {
      await sessionA.query("BEGIN");
      await sessionA.query(call, args); // takes the advisory lock, holds it

      let settled = false;
      // Goes through the pool, i.e. a different connection.
      const pendingB = newOrder(
        {
          user_istid: TEST_ISTID,
          customer_name: "Cap Race",
          campus: "Alameda",
          payment_method: "in-person",
          created_by: TEST_ISTID,
          items: [{ product_id: TEST_ON_DEMAND_PRODUCT_ID, quantity: 1 }],
        },
        false,
        { maxQuantityPerUser: 1, categoryName }
      ).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false); // blocked on pg_advisory_xact_lock — the assertion

      await sessionA.query("COMMIT");

      await expect(pendingB).rejects.toMatchObject({ code: "NEI03" });

      const { rows } = await owner.query<{ count: string }>(
        "SELECT count(*)::TEXT FROM neiist.orders WHERE user_istid = $1 AND status <> 'cancelled'",
        [TEST_ISTID]
      );
      expect(rows[0].count).toBe("1");
    } finally {
      await sessionA.query("ROLLBACK").catch(() => undefined);
      await sessionA.end();
    }
  });
});
