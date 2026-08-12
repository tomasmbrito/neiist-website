import DiscountCodeForm from "@/components/shop/DiscountCodeForm";
import { getAllProductsAdmin } from "@/utils/db/shopQueries";
import { getAllUsers } from "@/utils/db/userQueries";
import { UserRole } from "@/types/user";
import { requireRoles } from "@/utils/permissionUtils";

// Carried `export const dynamic = "force-dynamic"` until #111. The `requireRoles` call below is
// now the signal that marks this route dynamic: it reads `cookies()`, whose DynamicServerError
// escapes instead of being swallowed. Keep it ahead of the data reads.
export default async function NewDiscountPage() {
  await requireRoles([UserRole._ADMIN]);

  const [products, users] = await Promise.all([getAllProductsAdmin(), getAllUsers()]);

  return <DiscountCodeForm products={products} users={users} />;
}
