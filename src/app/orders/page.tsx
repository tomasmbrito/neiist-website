import OrdersTable from "@/components/shop/OrdersTable";
import OrderDetailOverlay from "@/components/shop/OrderDetailsOverlay";
import { getAllOrders, getAllProducts } from "@/utils/db/shopQueries";
import { requirePermission } from "@/utils/permissionUtils";
import { redactCustomerData } from "@/utils/shop/orderPrivacy";
import { UserRole } from "@/types/user";
import { can } from "@/lib/auth/permissions";

interface PageProps {
  searchParams: Promise<{ orderId?: string }>;
}

export default async function OrdersManagementPage({ searchParams }: PageProps) {
  const { orderId } = await searchParams;

  // Authorize BEFORE fetching. The previous `serverCheckRoles([])` ran after `getAllOrders()`
  // and passed an empty role list, so it only proved the caller was logged in — it computed UI
  // flags rather than guarding anything. Middleware is not a substitute: it is an optimisation,
  // not a boundary.
  const { roles = [UserRole._GUEST] } = await requirePermission("shop.orders.viewAll");

  // The same question the API asks before letting a status change through, so the button and
  // the endpoint cannot drift apart.
  const canManage = can(roles, "shop.orders.setStatus");

  const canEditOrder = roles.includes(UserRole._ADMIN) || roles.includes(UserRole._COORDINATOR);

  const [allOrders, products] = await Promise.all([getAllOrders(), getAllProducts(true)]);

  // A plain member can reach this page but has no management function on it, so they have no
  // reason to receive customer personal data.
  const orders = canManage ? allOrders : redactCustomerData(allOrders);

  return (
    <>
      <OrdersTable
        orders={orders}
        products={products}
        canCreateOrders={can(roles, "shop.orders.create")}
      />
      {orderId && (
        <OrderDetailOverlay
          orderId={Number(orderId)}
          orders={orders}
          canManage={canManage}
          basePath="/orders"
          canEditNotes={canEditOrder}
          canEditItems={canEditOrder}
          products={products}
        />
      )}
    </>
  );
}
