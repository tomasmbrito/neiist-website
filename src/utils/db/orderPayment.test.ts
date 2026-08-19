import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { finalizeOrderPayment } from "@/utils/db/shopQueries";

/**
 * #79 — atomic, idempotent payment finalization — and #154, the reference rule the in-person
 * flow depends on.
 *
 * These are the acceptance criteria of #79, not illustrations of it. The bug was a check-then-act
 * across three round-trips reached from five entry points (SumUp verify, browser return, webhook,
 * card reader, manual), several of which firing for one purchase is the normal case. Two callers
 * 50ms apart both saw 'pending', both wrote 'paid', both emailed a receipt, and for jantar de
 * curso both signed the student up to the event.
 *
 * A mock cannot test this. The fix *is* `SELECT ... FOR UPDATE` serialising two connections, so
 * the test has to be two connections.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEST_ISTID = "ist9990901";
const TEST_PRODUCT_ID = 901;

let owner: Client;

const newOrder = async (paymentMethod: string): Promise<number> => {
  const { rows } = await owner.query<{ id: number }>(
    `SELECT id FROM neiist.new_order($1::VARCHAR(50), 'Payment Test', $2, NULL, NULL, 'Alameda',
       NULL, $3, NULL, $1, $4::jsonb, NULL, false)`,
    [
      TEST_ISTID,
      `${TEST_ISTID}@tecnico.ulisboa.pt`,
      paymentMethod,
      JSON.stringify([{ product_id: TEST_PRODUCT_ID, variant_id: null, quantity: 1 }]),
    ]
  );
  return rows[0].id;
};

const statusOf = async (orderId: number) => {
  const { rows } = await owner.query<{ status: string; payment_checked_by: string | null }>(
    "SELECT status::TEXT, payment_checked_by FROM neiist.orders WHERE id = $1",
    [orderId]
  );
  return rows[0];
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();

  await owner.query(
    `INSERT INTO neiist.products (id, name, description, price, category_id, stock_type,
       stock_quantity, active)
     VALUES ($1, 'Payment Test Product', 'test fixture', 10.00, 1, 'limited', 1000, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_PRODUCT_ID]
  );
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Payment Test', $2)
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
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.products WHERE id = $1", [TEST_PRODUCT_ID]);
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [TEST_ISTID]);
  await owner.end();
});

describe("finalizeOrderPayment", () => {
  it("finalizes a pending order and reports that this caller did it", async () => {
    const orderId = await newOrder("in-person");

    const result = await finalizeOrderPayment(orderId, null, "manager-a");

    expect(result.finalized).toBe(true);
    expect(result.previousStatus).toBe("pending");
    expect(result.order.status).toBe("paid");
    expect((await statusOf(orderId)).payment_checked_by).toBe("manager-a");
  });

  /**
   * The #79 regression guard, and the reason it is written the hard way.
   *
   * `Promise.all([finalize(), finalize()])` does **not** test this. Two pool queries start about
   * a millisecond apart, and the unguarded window between the status read and the write is
   * microseconds wide, so they never overlap — that version passed against a deliberately broken
   * function with neither the row lock nor the conditional write. It looked like a concurrency
   * test and guarded nothing.
   *
   * Holding a transaction open is what makes the interleaving real: A takes the row lock and
   * keeps it, B must block, and B may only proceed once A commits. Verified to fail against the
   * check-then-act version (see the PR body).
   */
  it("blocks a second finalization until the first commits, and gives exactly one winner", async () => {
    const orderId = await newOrder("in-person");

    const sessionA = new Client({ connectionString: OWNER_URL });
    const sessionB = new Client({ connectionString: OWNER_URL });
    await sessionA.connect();
    await sessionB.connect();

    try {
      await sessionA.query("BEGIN");
      const resultA = await sessionA.query<{ finalized: boolean; previous_status: string }>(
        "SELECT finalized, previous_status FROM neiist.finalize_paid_order($1, NULL, 'manager-a')",
        [orderId]
      );
      expect(resultA.rows[0].finalized).toBe(true);

      // B is issued while A still holds the lock, and must not resolve.
      let settled = false;
      const pendingB = sessionB
        .query<{
          finalized: boolean;
          previous_status: string;
        }>(
          "SELECT finalized, previous_status FROM neiist.finalize_paid_order($1, NULL, 'manager-b')",
          [orderId]
        )
        .then((result) => {
          settled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false); // still blocked on the row lock — this is the assertion

      await sessionA.query("COMMIT");

      const resultB = await pendingB;
      expect(resultB.rows[0].finalized).toBe(false);
      expect(resultB.rows[0].previous_status).toBe("paid");

      // First writer wins the audit trail, so it names the caller that actually transitioned it.
      expect((await statusOf(orderId)).payment_checked_by).toBe("manager-a");
    } finally {
      await sessionA.query("ROLLBACK").catch(() => undefined);
      await sessionA.end();
      await sessionB.end();
    }
  });

  it("treats a replay as success without repeating the transition", async () => {
    const orderId = await newOrder("in-person");

    await finalizeOrderPayment(orderId, null, "manager-a");
    const replay = await finalizeOrderPayment(orderId, null, "manager-b");

    expect(replay.finalized).toBe(false);
    expect(replay.previousStatus).toBe("paid");
    expect((await statusOf(orderId)).payment_checked_by).toBe("manager-a");
  });

  /**
   * #154. The old rule was `payment_method !== "cash"`, which rejected 'in-person', 'mbway' and
   * 'transfer' — i.e. every manually-confirmed method, which is exactly the flow that needs it.
   */
  it.each(["in-person", "cash", "mbway", "transfer", "other"])(
    "finalizes a %s order with no payment reference",
    async (method) => {
      const orderId = await newOrder(method);

      const result = await finalizeOrderPayment(orderId, null, "manager-a");

      expect(result.finalized).toBe(true);
      expect(result.order.status).toBe("paid");
    }
  );

  it.each(["card", "sumup"])("rejects a %s order with no payment reference", async (method) => {
    const orderId = await newOrder(method);

    await expect(finalizeOrderPayment(orderId, null, "manager-a")).rejects.toMatchObject({
      code: "NEI05",
    });
    expect((await statusOf(orderId)).status).toBe("pending");
  });

  it("stores the reference for a card order and does not let a replay overwrite it", async () => {
    const orderId = await newOrder("card");

    const first = await finalizeOrderPayment(orderId, "SUMUP-TX-1", "sumup-webhook");
    expect(first.order.payment_reference).toBe("SUMUP-TX-1");

    const replay = await finalizeOrderPayment(orderId, "SUMUP-TX-2", "sumup-return");
    expect(replay.finalized).toBe(false);
    expect(replay.order.payment_reference).toBe("SUMUP-TX-1");
  });

  it("refuses to finalize a cancelled order", async () => {
    const orderId = await newOrder("in-person");
    await owner.query("UPDATE neiist.orders SET status = 'cancelled' WHERE id = $1", [orderId]);

    await expect(finalizeOrderPayment(orderId, null, "manager-a")).rejects.toMatchObject({
      code: "NEI04",
    });
  });

  it("reports a missing order rather than silently doing nothing", async () => {
    await expect(finalizeOrderPayment(999_999_999, null, "manager-a")).rejects.toMatchObject({
      code: "NEI01",
    });
  });
});
