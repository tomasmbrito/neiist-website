import ProductForm from "@/components/shop/ProductForm";
import { getAllCategories } from "@/utils/db/shopQueries";
import { UserRole } from "@/types/user";
import { requireRoles } from "@/utils/permissionUtils";

export default async function NewProductPage() {
  await requireRoles([UserRole._ADMIN]);

  const categories = await getAllCategories(true);

  return <ProductForm isEdit={false} backHref="/shop/manage" categories={categories} />;
}
