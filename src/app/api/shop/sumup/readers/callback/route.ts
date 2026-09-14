import { NextRequest, NextResponse } from "next/server";
import { withSumUp, sumupErrorResponse } from "@/lib/sumup";
import type { SumUpCheckout, SumUpReaderCallbackPayload } from "@/types/sumup";
import { getOrderById } from "@/lib/db/repositories/shop.repository";
import { finalizePaidOrder } from "@/utils/shop/orderFinalization";

const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

export async function POST(req: NextRequest) {
  let body: SumUpReaderCallbackPayload;
  try {
    body = (await req.json()) as SumUpReaderCallbackPayload;
  } catch {
    return sumupErrorResponse("Invalid payload", 400);
  }

  const orderId = Number(body?.payload?.order_id);
  const status = body?.event_type;

  if (!Number.isInteger(orderId) || orderId <= 0)
    return sumupErrorResponse("Invalid order_id", 400);

  const clientTransactionId = String(body?.payload?.client_transaction_id ?? "").trim();

  try {
    const order = await getOrderById(orderId);

    if (!order) return sumupErrorResponse("Order not found", 404);

    if (["paid", "ready", "delivered"].includes(order.status))
      return NextResponse.json({ success: true, alreadyProcessed: true });

    if (status !== "successful") return NextResponse.json({ success: true, status });

    if (!clientTransactionId) return sumupErrorResponse("Missing client_transaction_id", 400);

    // The transaction id must match the one this server itself stored when a shop manager
    // started the checkout (readers/[readerId]/checkout). Anything else is not our payment.
    if (order.payment_reference && order.payment_reference !== clientTransactionId)
      return sumupErrorResponse("Transaction does not match order", 400);

    if (!SUMUP_MERCHANT_CODE || !process.env.SUMUP_API_KEY)
      return sumupErrorResponse("Payment service misconfigured", 500);

    let transaction: SumUpCheckout;
    try {
      transaction = (await withSumUp((client) =>
        client.transactions.get(SUMUP_MERCHANT_CODE!, {
          client_transaction_id: clientTransactionId,
        })
      )) as SumUpCheckout;
    } catch (error) {
      return sumupErrorResponse(error);
    }

    if (String(transaction.status ?? "").toUpperCase() !== "SUCCESSFUL")
      return sumupErrorResponse("Transaction not successful", 400);

    if (transaction.currency && transaction.currency.toUpperCase() !== "EUR")
      return sumupErrorResponse("Payment currency mismatch", 400);

    const expectedAmountCents = Math.round(Number(order.total_amount) * 100);
    const actualAmountCents = Math.round(Number(transaction.amount) * 100);
    if (actualAmountCents !== expectedAmountCents)
      return sumupErrorResponse("Payment amount mismatch", 400);

    const result = await finalizePaidOrder({
      orderId,
      paymentReference: transaction.transaction_code || clientTransactionId,
      paymentCheckedBy: "sumup-tpa",
    });

    if (!result.success) return sumupErrorResponse(result.error, result.statusCode);

    return NextResponse.json({ success: true, transactionCode: transaction.transaction_code });
  } catch (error) {
    console.error("Reader callback processing error", error);
    return sumupErrorResponse("Failed to process callback", 500);
  }
}
