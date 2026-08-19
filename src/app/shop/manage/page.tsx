import ShopManagement from "@/components/shop/ShopManagement";
import { getAllProductsAdmin, getAllCategories } from "@/utils/db/shopQueries";
import { requirePermission } from "@/utils/permissionUtils";

export default async function ShopManagePage() {
  await requirePermission("shop.products.manage");

  const [products, categories] = await Promise.all([getAllProductsAdmin(), getAllCategories(true)]);

  return <ShopManagement products={products} categories={categories} />;
}
