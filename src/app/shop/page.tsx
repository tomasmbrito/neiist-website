import { getAllProducts } from "@/utils/dbUtils";
import ShopProductList from "@/components/shop/ShopProductList";
import styles from "@/styles/pages/Shop.module.css";

export default async function ShopPage() {
  const products = await getAllProducts();

  return (
    <div className={styles.content}>
      <ShopProductList products={products} />
    </div>
  );
}
