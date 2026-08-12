import { getAllProducts } from "@/utils/db/shopQueries";
import ShopProductList from "@/components/shop/ShopProductList";
import styles from "@/styles/pages/Shop.module.css";

// Reads the live catalogue on every request; prerendering froze it into the build output and
// made a reachable database a build-time requirement.
//
// This page keeps `force-dynamic` where the other three dropped it in #111, because it is the
// only one of them that never touches the session. Those call serverCheckRoles/requireRoles
// first, and now that #111 lets `cookies()`'s DynamicServerError escape, that call is itself
// the signal that marks them dynamic. This page has no such signal — its only dynamism is the
// database read, which Next does not treat as one. Verified: without this line `yarn build`
// fails with no database reachable ("Error occurred prerendering page /shop"), reintroducing
// the build-time database dependency that #106/#109 removed.
export const dynamic = "force-dynamic";

export default async function ShopPage() {
  const products = await getAllProducts();

  return (
    <div className={styles.content}>
      <ShopProductList products={products} />
    </div>
  );
}
