import { NextResponse } from "next/server";
import {
  getAllOrders,
  newOrder,
  getUser,
  updateUser,
  throwIfOrderDbError,
  getProduct,
  getUserOrderedProductsInCategory,
} from "@/utils/dbUtils";
import { UserRole } from "@/types/user";
import { PAYMENT_METHODS, PENDING_PAYMENT_METHODS, PaymentMethod } from "@/types/shop/payment";
import { OrderSource } from "@/types/shop/orderKind";
import { getOrderKindRules, getOrderKindFromItems } from "@/utils/shop/orderKindUtils";
import { OrderItem } from "@/types/shop/order";
import { Product } from "@/types/shop/product";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { sendEmail, getPendingOrderEmailTemplate } from "@/utils/emailUtils";
import { withValidation } from "@/utils/security/validationUtils";
import { createOrderPayloadSchema } from "@/schemas/shop";
import { handleApiError } from "@/lib/errors/apiErrorHandler";

function parseOrderSource(value: string): OrderSource {
  switch (value) {
    case "dinner":
    case "pos":
    case "mobile-pos":
      return value;
    default:
      return "other";
  }
}

export async function GET() {
  const userRoles = await serverCheckRoles([
    UserRole._SHOP_MANAGER,
    UserRole._COORDINATOR,
    UserRole._ADMIN,
  ]);

  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const orders = await getAllOrders();
    return NextResponse.json(orders);
  } catch (error) {
    return handleApiError(error);
  }
}

export const POST = withValidation(createOrderPayloadSchema, async (request, body) => {
  const userRoles = await serverCheckRoles([]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const validPaymentMethods = new Set(Object.keys(PAYMENT_METHODS));
    const orderSource = parseOrderSource(body.order_source ?? "");
    const guestCheckout = body.guest_checkout === true;
    const canUseGuestCheckout =
      userRoles.roles?.some((role) => [UserRole._ADMIN].includes(role)) && orderSource === "pos";

    if (guestCheckout && !canUseGuestCheckout) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    const hasExplicitPaymentMethod =
      typeof body.payment_method === "string" && validPaymentMethods.has(body.payment_method);
    const explicitlyRequestedMethod = hasExplicitPaymentMethod
      ? (body.payment_method as PaymentMethod)
      : undefined;

    const orderItems = new Set<number>(body.items.map((item) => item.product_id));
    const products = await Promise.all([...orderItems].map((id) => getProduct(id)));
    if (products.some((product) => product == null))
      return NextResponse.json({ error: "Produto invalido no pedido" }, { status: 400 });

    const { orderKind, isMixedInvalid } = getOrderKindFromItems(products as Product[]);
    const orderRules = getOrderKindRules(orderKind, orderSource);
    const userAssignmentRequired = orderRules.requiresUserAssignment;
    const orderUserIstid = guestCheckout
      ? undefined
      : userAssignmentRequired
        ? body.user_istid
        : undefined;

    if (isMixedInvalid) {
      return NextResponse.json(
        { error: "Este pedido nao pode misturar categorias especiais com outras categorias" },
        { status: 400 }
      );
    }

    if (!orderRules.allowedSources.includes(orderSource)) {
      return NextResponse.json(
        { error: "Não é permitida a encomenda de produtos desta categoria" },
        { status: 400 }
      );
    }

    if (orderRules.maxQuantityPerUser && orderUserIstid) {
      const categoryName = products[0]?.category?.trim();
      if (categoryName) {
        const existingByProduct = await getUserOrderedProductsInCategory(
          orderUserIstid,
          categoryName
        );

        const requestedQuantitiesByProduct: Record<number, number> = {};
        for (const item of body.items as OrderItem[]) {
          const productId = Number(item.product_id);
          requestedQuantitiesByProduct[productId] =
            (requestedQuantitiesByProduct[productId] ?? 0) + Number(item.quantity ?? 0);
        }

        for (const [productIdString, requestedQty] of Object.entries(
          requestedQuantitiesByProduct
        )) {
          const productId = Number(productIdString);
          const existing = existingByProduct[productId] ?? 0;
          if (existing + requestedQty > orderRules.maxQuantityPerUser) {
            const product = await getProduct(productId);
            const productLabel = product?.name ?? `product ${productId}`;
            return NextResponse.json(
              {
                error: `O limite para o produto "${productLabel}" para este utilizador foi atingido`,
              },
              { status: 400 }
            );
          }
        }
      }
    }

    const allowedPaymentMethods = orderRules.paymentMethods;
    const paymentMethod: PaymentMethod =
      explicitlyRequestedMethod ??
      (allowedPaymentMethods.length > 0 ? allowedPaymentMethods[0] : "in-person");

    if (allowedPaymentMethods.length > 0 && !allowedPaymentMethods.includes(paymentMethod)) {
      return NextResponse.json(
        { error: "Metodo de pagamento invalido para a categoria selecionada" },
        { status: 400 }
      );
    }

    if (userAssignmentRequired && !body.user_istid && !guestCheckout) {
      return NextResponse.json(
        { error: "Utilizador obrigatorio para este tipo de pedido" },
        { status: 400 }
      );
    }

    const customerName = String(body.customer_name ?? "").trim();
    const customerEmail = typeof body.customer_email === "string" ? body.customer_email.trim() : "";
    const customerPhone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : "";

    if (guestCheckout && userAssignmentRequired) {
      if (!customerName) {
        return NextResponse.json({ error: "Nome do cliente obrigatorio" }, { status: 400 });
      }
      if (!customerEmail) {
        return NextResponse.json({ error: "Email do cliente obrigatorio" }, { status: 400 });
      }
      if (!customerPhone) {
        return NextResponse.json({ error: "Telemóvel do cliente obrigatorio" }, { status: 400 });
      }
    }

    const stockOverride =
      (userRoles.roles?.includes(UserRole._ADMIN) ?? false) && body.stock_override === true;

    const order = await newOrder(
      {
        user_istid: orderUserIstid,
        customer_name: customerName || (guestCheckout ? "Cliente POS" : ""),
        customer_email: customerEmail || undefined,
        customer_phone: customerPhone || undefined,
        customer_nif: body.customer_nif ?? undefined,
        campus: body.campus ?? undefined,
        notes: body.notes ?? undefined,
        payment_method: paymentMethod,
        payment_reference: body.payment_reference ?? undefined,
        created_by: userRoles.user!.istid,
        items: body.items,
        discount_code: typeof body.discount_code === "string" ? body.discount_code : undefined,
      },
      stockOverride
    );
    if (!order) return NextResponse.json({ error: "Failed to create order" }, { status: 500 });

    if (orderUserIstid && body.customer_phone) {
      const user = await getUser(orderUserIstid);
      if (user && user.phone !== body.customer_phone)
        await updateUser(orderUserIstid, { phone: body.customer_phone });
    }

    if (
      hasExplicitPaymentMethod &&
      order.customer_email &&
      orderRules.customerEmailsEnabled &&
      PENDING_PAYMENT_METHODS.has(paymentMethod)
    ) {
      try {
        await sendEmail({
          to: order.customer_email,
          subject: `Encomenda ${order.order_number} - Pendente`,
          html: getPendingOrderEmailTemplate(
            orderKind,
            order.order_number,
            order.customer_name,
            order.items,
            order.total_amount,
            order.campus ?? undefined,
            order.payment_method ?? undefined,
            order.pickup_deadline ?? null
          ),
        });
      } catch (emailErr) {
        console.warn("Failed to send order confirmation email:", emailErr);
      }
    }

    return NextResponse.json(order);
  } catch (error) {
    try {
      throwIfOrderDbError(error);
    } catch (e) {
      return handleApiError(e);
    }
    console.error("orders POST error:", error);
    return handleApiError(error);
  }
});
