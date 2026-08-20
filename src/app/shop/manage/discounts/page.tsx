import DiscountCodeManagement from "@/components/shop/DiscountCodeManagement";
import { getAllDiscountCodes, getAllProductsAdmin } from "@/utils/db/shopQueries";
import { getAllUsers } from "@/utils/db/userQueries";
import { requirePermission } from "@/utils/permissionUtils";

export default async function DiscountCodesPage() {
  await requirePermission("shop.discounts.manage");

  const [products, discountCodes, users] = await Promise.all([
    getAllProductsAdmin(),
    getAllDiscountCodes(),
    getAllUsers(),
  ]);

  return <DiscountCodeManagement products={products} discountCodes={discountCodes} users={users} />;
}
