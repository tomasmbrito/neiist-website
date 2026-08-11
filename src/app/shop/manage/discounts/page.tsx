import DiscountCodeManagement from "@/components/shop/DiscountCodeManagement";
import { getAllDiscountCodes, getAllProductsAdmin, getAllUsers } from "@/utils/dbUtils";
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
