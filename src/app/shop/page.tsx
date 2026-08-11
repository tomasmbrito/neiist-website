import { getAllProducts, getAllCategories } from "@/utils/dbUtils";
import ShopProductList from "@/components/shop/ShopProductList";
import styles from "@/styles/pages/Shop.module.css";

// Reads the live catalogue on every request; prerendering froze it into the build output and
// made a reachable database a build-time requirement.
export const dynamic = "force-dynamic";

export default async function ShopPage() {
  const [products, categories] = await Promise.all([getAllProducts(), getAllCategories()]);

  return (
    <div className={styles.content}>
      <ShopProductList products={products} categories={categories} />
    </div>
  );
}
