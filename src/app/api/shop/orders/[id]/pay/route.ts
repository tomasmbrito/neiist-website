import { NextRequest, NextResponse } from "next/server";
import { finalizePaidOrder } from "@/utils/shop/orderFinalization";
import { serverCheckRoles } from "@/utils/permissionUtils";
import { throwIfOrderDbError } from "@/utils/db/errorMapper";
import { handleApiError } from "@/lib/errors/apiErrorHandler";
import { UserRole } from "@/types/user";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userRoles = await serverCheckRoles([
    UserRole._SHOP_MANAGER,
    UserRole._COORDINATOR,
    UserRole._ADMIN,
  ]);
  if (!userRoles.isAuthorized) return userRoles.error;

  try {
    const body = await request.json();
    const { paymentReference } = body;
    const orderId = Number((await params).id);

    if (!orderId) return NextResponse.json({ error: "Invalid order id" }, { status: 400 });

    // Deliberately NOT required here any more. Whether a reference is needed depends on the
    // order's payment method, which only the database knows without another round trip:
    // neiist.finalize_paid_order demands one for the SumUp-backed methods and raises NEI05 if it
    // is missing. Requiring it unconditionally rejected exactly the flow this route exists for —
    // a manager marking an in-person payment as received has no reference to type (#154).
    const result = await finalizePaidOrder({
      orderId,
      paymentReference,
      paymentCheckedBy: userRoles.user!.istid,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.statusCode });
    }

    // finalizePaidOrder already read the order under the lock; re-fetching it here would be a
    // third round trip returning the same row.
    return NextResponse.json({
      order: result.order,
      alreadyPaid: result.alreadyProcessed === true,
    });
  } catch (error) {
    // NEI01/NEI04/NEI05 become 404/409/400 here. Without this every failure was a blanket 500,
    // and an unmapped SQLSTATE would have leaked the raw RAISE text to the client.
    try {
      throwIfOrderDbError(error);
    } catch (mapped) {
      return handleApiError(mapped);
    }
    console.error("Order finalization error:", error);
    return handleApiError(error);
  }
}
