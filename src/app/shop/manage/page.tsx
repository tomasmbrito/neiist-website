import ShopManagement from "@/components/shop/ShopManagement";
import { getAllProductsAdmin, getAllCategories } from "@/utils/db/shopQueries";
import { UserRole } from "@/types/user";
import { requireRoles } from "@/utils/permissionUtils";

export default async function ShopManagePage() {
  await requireRoles([UserRole._ADMIN]);

  const [products, categories] = await Promise.all([getAllProductsAdmin(), getAllCategories(true)]);

  return <ShopManagement products={products} categories={categories} />;
}
