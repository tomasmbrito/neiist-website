import type { Order } from "@/types/shop/order";

/**
 * Strips customer personal data from orders before they reach a caller who has no business
 * reading it.
 *
 * `/orders` is gated to `_MEMBER` in middleware, but the page renders the full order rows —
 * name, email, phone, NIF, MBWay number, payment reference — to whoever loads it. Only the
 * *management affordances* were gated on role, not the data behind them, so every member of
 * NEIIST could read every customer's personal data out of the RSC payload.
 *
 * Redaction happens on the server, before serialization. Hiding these columns in the client
 * component would not help: the values would still be in the payload sent to the browser.
 */
export function redactCustomerData(orders: Order[]): Order[] {
  return orders.map((order) => ({
    ...order,
    customer_name: "",
    user_istid: undefined,
    customer_email: undefined,
    customer_phone: undefined,
    customer_nif: undefined,
    mbway_number: null,
    payment_reference: undefined,
    // Free text written by staff about a customer, so it is PII by content even though the
    // column name does not say so.
    notes: undefined,
  }));
}
