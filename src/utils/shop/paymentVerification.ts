import type { Order } from "@/types/shop/order";

/**
 * Binds a SumUp payment to the order it is supposed to pay for.
 *
 * Three routes finalize orders from SumUp data, and none of them checked that the payment
 * actually belonged to the order being finalized: no comparison of amount, and none of the
 * checkout reference. Since `orders.payment_reference` has no UNIQUE constraint, one genuine
 * payment could be replayed to finalize unlimited later orders.
 *
 * Kept in one place deliberately. Three copies of a money check drift — the divergence between
 * the callback and verify routes was exactly that, already happening.
 */

export type BindingResult = { ok: true } | { ok: false; reason: string };

/**
 * Converts a monetary value to integer cents.
 *
 * SumUp returns amounts as a number on checkouts and as a string on transactions, so both are
 * accepted. Comparing in cents avoids float equality on money.
 */
export function toCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

function amountsMatch(remote: unknown, order: Order): BindingResult {
  const remoteCents = toCents(remote);
  const orderCents = toCents(order.total_amount);

  if (remoteCents === null || orderCents === null) {
    return { ok: false, reason: "amount missing or not numeric" };
  }
  if (remoteCents !== orderCents) {
    // Values are intentionally omitted from the reason returned to clients; the caller logs
    // the detail server-side.
    return { ok: false, reason: "payment amount does not match the order total" };
  }
  return { ok: true };
}

/**
 * For online checkouts (web card payment, Apple Pay).
 *
 * `sumup/new` creates the checkout with `checkout_reference: order.order_number`, so that field
 * is the authoritative link back to the order.
 */
export function verifyCheckoutBinding(
  checkout: { checkout_reference?: string | null; amount?: unknown; currency?: string | null },
  order: Order
): BindingResult {
  const reference = String(checkout.checkout_reference ?? "").trim();
  const orderNumber = String(order.order_number ?? "").trim();

  if (!reference || !orderNumber) {
    return { ok: false, reason: "checkout reference or order number missing" };
  }
  if (reference !== orderNumber) {
    return { ok: false, reason: "checkout belongs to a different order" };
  }
  if (checkout.currency && String(checkout.currency).toUpperCase() !== "EUR") {
    return { ok: false, reason: "unexpected currency" };
  }
  return amountsMatch(checkout.amount, order);
}

/**
 * For card-reader (POS) payments.
 *
 * Reader checkouts carry no `checkout_reference`. Instead, `readers/[readerId]/checkout` stores
 * the SumUp `client_transaction_id` on the order as `payment_reference`, so that stored value
 * is the link — and it is server-generated, not attacker-supplied.
 */
export function verifyReaderTransactionBinding(
  transaction: { amount?: unknown; currency?: string | null; status?: string | null },
  order: Order,
  clientTransactionId: string
): BindingResult {
  const expected = String(order.payment_reference ?? "").trim();
  const received = String(clientTransactionId ?? "").trim();

  if (!expected || !received) {
    return { ok: false, reason: "no reader transaction is associated with this order" };
  }
  if (expected !== received) {
    return { ok: false, reason: "transaction belongs to a different order" };
  }

  const status = String(transaction.status ?? "").toUpperCase();
  if (status !== "PAID" && status !== "SUCCESSFUL") {
    return { ok: false, reason: `transaction is not paid (status: ${status || "unknown"})` };
  }
  if (transaction.currency && String(transaction.currency).toUpperCase() !== "EUR") {
    return { ok: false, reason: "unexpected currency" };
  }
  return amountsMatch(transaction.amount, order);
}
