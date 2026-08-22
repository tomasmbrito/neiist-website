"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * The workspace sidebar.
 *
 * A client component only because it highlights the active route from `usePathname`. It receives
 * the already-filtered team list as a prop and never fetches — the decision about *which* teams
 * this person may see is made on the server, in the layout. Sending the full list down and
 * filtering here would put the boundary in the browser, where it is not a boundary.
 */
export default function WorkspaceNav({ teams, userName }: { teams: string[]; userName: string }) {
  const pathname = usePathname();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <span className={styles.sidebarTitle}>Espaço de Trabalho</span>
        {userName ? <span className={styles.sidebarUser}>{userName}</span> : null}
      </div>

      <nav aria-label="Equipas">
        <Link
          href="/workspace"
          className={pathname === "/workspace" ? styles.navLinkActive : styles.navLink}>
          Início
        </Link>

        {teams.length > 0 ? (
          <>
            <span className={styles.navSection}>As minhas equipas</span>
            {teams.map((team) => {
              const href = `/workspace/${encodeURIComponent(team)}`;
              return (
                <Link
                  key={team}
                  href={href}
                  className={pathname === href ? styles.navLinkActive : styles.navLink}>
                  {team}
                </Link>
              );
            })}
          </>
        ) : null}
      </nav>
    </aside>
  );
}
