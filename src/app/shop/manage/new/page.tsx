import ProductForm from "@/components/shop/ProductForm";
import { getAllCategories } from "@/utils/db/shopQueries";
import { requirePermission } from "@/utils/permissionUtils";

export default async function NewProductPage() {
  await requirePermission("shop.products.manage");

  const categories = await getAllCategories(true);

  return <ProductForm isEdit={false} backHref="/shop/manage" categories={categories} />;
}
