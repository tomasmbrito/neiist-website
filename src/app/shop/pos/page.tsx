import SumUpReadersManagement from "@/components/shop/SumUpReadersManagement";
import { requireRoles } from "@/utils/permissionUtils";
import { UserRole } from "@/types/user";
import styles from "@/styles/pages/ShopPos.module.css";

export default async function ShopPosPage() {
  // Matches the roles the SumUp reader API routes already require. This page had no gate of
  // any kind, and middleware did not cover it either — see the shopManagerRoutes note there.
  await requireRoles([UserRole._ADMIN, UserRole._SHOP_MANAGER]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <span className={styles.primary}>Gestão</span>
          <span className={styles.secondary}> de TPA</span>
          <span className={styles.tertiary}>s Sum</span>
          <span className={styles.quaternary}>Up</span>
        </h1>
      </div>
      <SumUpReadersManagement />
    </div>
  );
}
