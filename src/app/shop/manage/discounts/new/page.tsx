import DiscountCodeForm from "@/components/shop/DiscountCodeForm";
import { getAllProductsAdmin, getAllUsers } from "@/utils/dbUtils";
import { UserRole } from "@/types/user";
import { requireRoles } from "@/utils/permissionUtils";

export const dynamic = "force-dynamic";

export default async function NewDiscountPage() {
  await requireRoles([UserRole._ADMIN]);

  const [products, users] = await Promise.all([getAllProductsAdmin(), getAllUsers()]);

  return <DiscountCodeForm products={products} users={users} />;
}
