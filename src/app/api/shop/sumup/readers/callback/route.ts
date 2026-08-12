import { NextRequest, NextResponse } from "next/server";
import { getOrderById } from "@/utils/db/shopQueries";
import { getSumUpClient, sumupErrorResponse, validateSumUpCredentials } from "@/utils/sumupUtils";
import type { SumUpCheckout } from "@/types/sumup";
import { finalizePaidOrder } from "@/utils/shop/orderFinalization";
import { verifyReaderTransactionBinding } from "@/utils/shop/paymentVerification";

const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE;

type ReaderCheckoutStatusPayload = {
  payload?: {
    client_transaction_id?: string;
    checkout_id?: string;
    status?: string;
  };
};

/**
 * SumUp card-reader status callback.
 *
 * This endpoint is unauthenticated — SumUp calls it directly. It therefore treats the entire
 * request body as untrusted input, and specifically does NOT act on `payload.status`.
 *
 * Previously it did: a POST of `{"payload":{"status":"successful"}}` with any `?orderId=`
 * marked that order paid, sent the confirmation email, and auto-registered the buyer for
 * jantar-de-curso events. Order ids are sequential, so every pending order was walkable.
 *
 * The body is now used only as a hint about which transaction to look up. Whether the payment
 * happened, for how much, and against which order is decided entirely by SumUp's own record.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReaderCheckoutStatusPayload;
    const orderIdRaw = req.nextUrl.searchParams.get("orderId");
    const orderId = Number(orderIdRaw);

    if (!Number.isInteger(orderId) || orderId <= 0)
      return sumupErrorResponse("Invalid orderId", 400);

    const clientTransactionId = String(body?.payload?.client_transaction_id ?? "").trim();

    const order = await getOrderById(orderId);
    if (!order) return sumupErrorResponse("Order not found", 404);

    if (["paid", "ready", "delivered"].includes(order.status))
      return NextResponse.json({ success: true, alreadyProcessed: true });

    // No transaction id means there is nothing we can independently verify, so there is nothing
    // to act on. Acknowledged so SumUp does not retry forever.
    if (!clientTransactionId) {
      return NextResponse.json({ success: true, ignored: "no client_transaction_id" });
    }

    const credentialError = validateSumUpCredentials();
    if (credentialError) return credentialError;

    let transaction: SumUpCheckout;
    try {
      transaction = (await getSumUpClient().transactions.get(SUMUP_MERCHANT_CODE!, {
        client_transaction_id: clientTransactionId,
      })) as SumUpCheckout;
    } catch (error) {
      // A lookup failure must never fall through to finalization. Previously this was a
      // console.warn that gated nothing.
      console.error("Reader callback could not verify transaction with SumUp", error);
      return sumupErrorResponse("Could not verify transaction with payment provider", 502);
    }

    const binding = verifyReaderTransactionBinding(transaction, order, clientTransactionId);
    if (!binding.ok) {
      console.error(
        `Reader callback rejected for order ${orderId}: ${binding.reason}` +
          ` (transaction ${clientTransactionId})`
      );
      return sumupErrorResponse("Payment does not match this order", 400);
    }

    const result = await finalizePaidOrder({
      orderId,
      paymentReference: String(transaction.transaction_code ?? clientTransactionId),
      paymentCheckedBy: "sumup-tpa",
    });

    if (!result.success) {
      return sumupErrorResponse(result.error, result.statusCode);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Reader callback processing error", error);
    return sumupErrorResponse("Failed to process callback", 500);
  }
}
