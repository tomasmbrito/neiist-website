import DiscountCodeManagement from "@/components/shop/DiscountCodeManagement";
import { getAllDiscountCodes, getAllProductsAdmin } from "@/utils/db/shopQueries";
import { getAllUsers } from "@/utils/db/userQueries";
import { UserRole } from "@/types/user";
import { requireRoles } from "@/utils/permissionUtils";

export default async function DiscountCodesPage() {
  await requireRoles([UserRole._ADMIN]);

  const [products, discountCodes, users] = await Promise.all([
    getAllProductsAdmin(),
    getAllDiscountCodes(),
    getAllUsers(),
  ]);

  return <DiscountCodeManagement products={products} discountCodes={discountCodes} users={users} />;
}
