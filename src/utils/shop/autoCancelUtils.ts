import { getAllOrders, setOrderState } from "@/utils/db/shopQueries";
import { getAutoCancelledOrderEmailTemplate, sendEmail } from "@/utils/emailUtils";
import { getOrderKindRules, getOrderKindFromItems } from "@/utils/shop/orderKindUtils";
import { Order } from "@/types/shop/order";
import { getStatusLabel } from "@/utils/shop/orderStatusUtils";

const AUTO_CANCEL_MS = 72 * 60 * 60 * 1000;

function isOlderThanThreshold(order: Order, now: number): boolean {
  const createdTs = new Date(order.created_at).getTime();
  if (!Number.isFinite(createdTs)) return false;

  return now - createdTs >= AUTO_CANCEL_MS;
}

export async function autoCancelPendingOrders() {
  const now = Date.now();

  const allOrders = (await getAllOrders()) as Order[];
  const candidates = allOrders.filter((order) => {
    if (order.status !== "pending" || !isOlderThanThreshold(order, now)) return false;

    const { orderKind } = getOrderKindFromItems(order.items);
    return getOrderKindRules(orderKind).autoCancelEnabled;
  });

  const cancelledOrderIds: number[] = [];
  const failedOrderIds: number[] = [];
  const skippedOrderIds: number[] = [];
  const toNotify: Order[] = [];

  for (const order of candidates) {
    try {
      // `candidates` is a snapshot taken before this loop started, and the loop is serial, so by
      // the time an order is reached its status is arbitrarily stale. Passing "pending" as the
      // expectation makes the database refuse to act on a decision that is no longer true — the
      // fix for #78 scenario B, where a payment landing mid-sweep was overwritten by 'cancelled',
      // the restock trigger fired, and the customer was emailed "cancelled" for an order they
      // had just paid for.
      const result = await setOrderState(order.id, "cancelled", "system-cron", "pending");

      // Not a failure: the order moved on (almost always because it was paid). Tracked
      // separately so a paid-mid-sweep order is visible in the log instead of vanishing.
      if (!result) {
        skippedOrderIds.push(order.id);
        continue;
      }

      cancelledOrderIds.push(order.id);
      toNotify.push(order);
    } catch (error) {
      console.error("auto-cancel: failed cancelling order", { orderId: order.id, error: error });
      failedOrderIds.push(order.id);
    }
  }

  // Email after every cancellation is committed, not inside the loop. An SMTP round-trip per
  // order made the window in which a payment could race the sweep seconds wide rather than
  // milliseconds; the expectation check above closes the race, and this keeps it narrow.
  for (const order of toNotify) {
    const { orderKind } = getOrderKindFromItems(order.items);
    const orderRules = getOrderKindRules(orderKind);
    if (!order.customer_email || !orderRules.customerEmailsEnabled) continue;

    try {
      await sendEmail({
        to: order.customer_email,
        subject: `Encomenda ${order.order_number} - ${getStatusLabel("cancelled")}`,
        html: getAutoCancelledOrderEmailTemplate(
          orderKind,
          order.order_number,
          order.customer_name,
          order.campus
        ),
      });
    } catch (mailError) {
      console.warn("auto-cancel: failed sending cancellation email", {
        orderId: order.id,
        error: mailError,
      });
    }
  }

  return {
    success: true,
    checkedOrders: allOrders.length,
    matchedOrders: candidates.length,
    cancelledCount: cancelledOrderIds.length,
    failedCount: failedOrderIds.length,
    skippedCount: skippedOrderIds.length,
    cancelledOrderIds,
    failedOrderIds,
    skippedOrderIds,
  };
}
