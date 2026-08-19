import { signUpToEvent } from "@/utils/db/eventQueries";
import { finalizeOrderPayment } from "@/utils/db/shopQueries";
import { getPaidOrderEmailTemplate, sendEmail } from "@/utils/emailUtils";
import { Order } from "@/types/shop/order";
import { getOrderKindRules } from "@/utils/shop/orderKindUtils";
import { getStatusLabel } from "@/utils/shop/orderStatusUtils";
import { getOrderKindFromItems } from "@/utils/shop/orderKindUtils";

const AFTER_PURCHASE_ACTIONS = {
  register_jantar_de_curso: async (order: Order) => {
    const activityId = process.env.NEXT_PUBLIC_JANTAR_DE_CURSO_ACTIVITY_ID;
    if (!activityId || !order.user_istid) return;

    await signUpToEvent(activityId, order.user_istid);
  },
} as const;

export type FinalizePaidOrderResult =
  | { success: true; alreadyProcessed?: boolean; order: Order }
  | { success: false; error: string; statusCode: number };

export async function finalizePaidOrder({
  orderId,
  paymentReference,
  paymentCheckedBy,
}: {
  orderId: number;
  paymentReference: string;
  paymentCheckedBy: string;
}): Promise<FinalizePaidOrderResult> {
  const reference = String(paymentReference ?? "").trim() || null;

  // One statement, one transaction, one row lock. The database decides whether this caller is
  // the one that transitioned the order; `finalized` is that decision, not a stale read.
  // Whether a reference is required is decided there too, by payment method — an in-person
  // payment has none to give (#154).
  const { finalized, order: statusUpdate } = await finalizeOrderPayment(
    orderId,
    reference,
    paymentCheckedBy
  );

  // A replay: some other entry point already paid this order. Success for the caller, but no
  // side effects — this is what stops duplicate receipts and duplicate event sign-ups.
  if (!finalized) return { success: true, alreadyProcessed: true, order: statusUpdate };

  const { orderKind } = getOrderKindFromItems(statusUpdate.items);
  const orderRules = getOrderKindRules(orderKind, "other");
  const afterPurchaseActionKey = orderRules.afterPurchaseActionKey;

  if (afterPurchaseActionKey) {
    try {
      await AFTER_PURCHASE_ACTIONS[afterPurchaseActionKey](statusUpdate);
    } catch (error) {
      console.warn("Failed to perform after purchase action", {
        orderId,
        error,
      });
    }
  }

  if (statusUpdate.customer_email && orderRules.customerEmailsEnabled) {
    sendEmail({
      to: statusUpdate.customer_email,
      subject: `Encomenda ${statusUpdate.order_number} - ${getStatusLabel("paid")}`,
      html: getPaidOrderEmailTemplate(
        orderKind,
        statusUpdate.order_number,
        statusUpdate.customer_name,
        statusUpdate.items,
        Number(statusUpdate.total_amount),
        statusUpdate.campus,
        statusUpdate.payment_method,
        // The stored reference, not the argument: for a manual finalization the argument is null
        // and the row may still carry one recorded earlier.
        statusUpdate.payment_reference ?? undefined
      ),
    }).catch((err) => console.warn("Confirmation couldn't be sent:", err));
  }

  return { success: true, order: statusUpdate };
}
