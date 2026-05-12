import DiscountCodesDashboard from "@/components/shop/DiscountCodesDashboard";
import { getAllDiscountCodes, getAllProductsAdmin, getAllUsers } from "@/utils/dbUtils";

export default async function DiscountCodesPage() {
  const [products, discountCodes, users] = await Promise.all([
    getAllProductsAdmin(),
    getAllDiscountCodes(),
    getAllUsers(),
  ]);

  return <DiscountCodesDashboard products={products} discountCodes={discountCodes} users={users} />;
}
