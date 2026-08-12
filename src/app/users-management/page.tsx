import UsersManagement from "@/components/admin/UsersManagement";
import MembershipsManagement from "@/components/admin/MembershipsManagement";
import styles from "@/styles/pages/AdminDashboard.module.css";
import { GoPerson, GoShield } from "react-icons/go";
import { requireRoles } from "@/utils/permissionUtils";
import { UserRole } from "@/types/user";

const sections = [
  { id: "users", name: "Utilizadores", icon: <GoShield /> },
  { id: "memberships", name: "Membros", icon: <GoPerson /> },
];

export default async function UsersManagementPage({
  searchParams: searchParamsPromise,
}: {
  searchParams?: Promise<Record<string, string | string[]>>;
}) {
  // Mirrors the admin rule in middleware. Enforced here too — middleware is an optimisation,
  // not a boundary.
  await requireRoles([UserRole._ADMIN]);

  const searchParams = searchParamsPromise ? await searchParamsPromise : {};
  const sectionParam = searchParams?.section;
  const activeSection =
    typeof sectionParam === "string" && sections.some((s) => s.id === sectionParam)
      ? sectionParam
      : "users";

  let content = null;
  switch (activeSection) {
    case "users":
      content = <UsersManagement />;
      break;
    case "memberships":
      content = <MembershipsManagement />;
      break;
    default:
      content = <UsersManagement />;
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>Gestão de Pessoas</h1>
      </header>
      <nav className={styles.tabBar}>
        {sections.map((section) => (
          <a
            key={section.id}
            href={`?section=${section.id}`}
            className={`${styles.tabButton} ${activeSection === section.id ? styles.activeTab : ""}`}>
            <span>{section.icon}</span>
            {section.name}
          </a>
        ))}
      </nav>
      <div className={styles.dashboard}>{content}</div>
    </div>
  );
}
