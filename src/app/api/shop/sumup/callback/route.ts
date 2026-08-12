import { NextRequest, NextResponse } from "next/server";
import { getOrderById } from "@/utils/db/shopQueries";
import { validateSumUpCredentials, getSumUpClient, sumupErrorResponse } from "@/utils/sumupUtils";
import type { SumUpCheckout } from "@/types/sumup";
import { finalizePaidOrder } from "@/utils/shop/orderFinalization";
import { verifyCheckoutBinding } from "@/utils/shop/paymentVerification";

type CheckoutStatusChangedPayload = {
  event_type?: string;
  id?: string;
};

export async function GET(req: NextRequest) {
  const credentialError = validateSumUpCredentials();
  if (credentialError) return credentialError;

  const orderId = Number(req.nextUrl.searchParams.get("orderId"));
  const checkoutId = String(req.nextUrl.searchParams.get("checkout_id") ?? "").trim();

  if (!Number.isInteger(orderId) || orderId <= 0) return sumupErrorResponse("Invalid orderId", 400);
  if (!checkoutId) return sumupErrorResponse("Missing checkout_id", 400);

  const client = getSumUpClient();

  let checkout: SumUpCheckout;
  try {
    checkout = await client.checkouts.get(checkoutId);
  } catch {
    return sumupErrorResponse("Failed to verify checkout", 502);
  }

  const status = String(checkout.status ?? "")
    .trim()
    .toUpperCase();
  if (status === "PAID") {
    const transactionCode = String(checkout.transaction_code ?? "").trim();
    if (transactionCode) {
      // This browser-return path finalized without ever loading the order, so it neither
      // checked the order's state nor that the checkout belonged to it. Both are required:
      // the endpoint is unauthenticated and both parameters come from the URL.
      const order = await getOrderById(orderId);
      if (!order) return sumupErrorResponse("Order not found", 404);

      const binding = verifyCheckoutBinding(checkout, order);
      if (!binding.ok) {
        console.error(
          `Return-URL checkout ${checkoutId} rejected for order ${orderId}: ${binding.reason}`
        );
        return sumupErrorResponse("Payment does not match this order", 400);
      }

      const result = await finalizePaidOrder({
        orderId,
        paymentReference: transactionCode,
        paymentCheckedBy: "sumup-return",
      });

      if (!result.success) return sumupErrorResponse(result.error, result.statusCode);
    }
  }

  const html = `<!doctype html>
<html lang="pt">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pagamento SumUp</title>
    <style>
      body { font-family: sans-serif; margin: 0; padding: 24px; color: #111827; }
      p { margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <p>Autenticacao concluida. Podes fechar esta janela.</p>
  </body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  const credentialError = validateSumUpCredentials();
  if (credentialError) return credentialError;

  const orderId = Number(req.nextUrl.searchParams.get("orderId"));
  if (!Number.isInteger(orderId) || orderId <= 0) return sumupErrorResponse("Invalid orderId", 400);

  let body: CheckoutStatusChangedPayload;
  try {
    body = (await req.json()) as CheckoutStatusChangedPayload;
  } catch {
    return sumupErrorResponse("Invalid webhook payload", 400);
  }

  const checkoutId = String(body?.id ?? "").trim();
  if (!checkoutId) return sumupErrorResponse("Missing checkout id", 400);

  const client = getSumUpClient();

  let checkout: SumUpCheckout;
  try {
    checkout = await client.checkouts.get(checkoutId);
  } catch {
    return sumupErrorResponse("Failed to verify checkout", 502);
  }

  const order = await getOrderById(orderId);
  if (!order) return sumupErrorResponse("Order not found", 404);

  if (["paid", "ready", "delivered"].includes(order.status))
    return NextResponse.json({ success: true, alreadyProcessed: true });

  if (order.payment_reference && order.payment_reference !== checkoutId)
    return sumupErrorResponse("Checkout id does not match order", 400);

  const status = String(checkout.status ?? "")
    .trim()
    .toUpperCase();

  if (status !== "PAID") return NextResponse.json({ success: true, status });

  // The payment_reference check above is skipped whenever that field is empty — which is every
  // order that never started a SumUp checkout (in-person, MB Way). Binding on the checkout's
  // own reference and amount closes that hole and does not depend on prior state.
  const binding = verifyCheckoutBinding(checkout, order);
  if (!binding.ok) {
    console.error(
      `Callback checkout ${checkoutId} rejected for order ${orderId}: ${binding.reason}` +
        ` (checkout ref ${checkout.checkout_reference}, amount ${checkout.amount},` +
        ` order ${order.order_number}, total ${order.total_amount})`
    );
    return sumupErrorResponse("Payment does not match this order", 400);
  }

  const result = await finalizePaidOrder({
    orderId,
    paymentReference: checkout.transaction_code || checkoutId,
    paymentCheckedBy: "sumup-webhook",
  });

  if (!result.success) return sumupErrorResponse(result.error, result.statusCode);

  return NextResponse.json({
    success: true,
    status,
    transactionCode: checkout.transaction_code || undefined,
    alreadyProcessed: result.alreadyProcessed,
  });
}
