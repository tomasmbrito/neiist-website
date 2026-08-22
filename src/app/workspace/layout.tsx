import { requireNeiistMember } from "@/utils/permissionUtils";
import { visibleWorkspaceTeams } from "@/lib/auth/permissions";
import { getAllDepartments } from "@/utils/db/userQueries";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * The members-only boundary for everything under `/workspace` (#183).
 *
 * The guard lives in the **layout**, so a new page under this segment is protected the moment it
 * is created rather than when someone remembers to add a check. That inverts the failure mode:
 * forgetting produces a locked page, not a leaked one.
 *
 * It is not the *only* guard, on purpose. Each team page also calls `requireTeamWorkspace`,
 * because this layout can only answer "is this person a member" — not "of *this* team". Layouts
 * also do not re-run on every client navigation, so a page that authorized only here would be a
 * boundary that sometimes isn't. Two layers, same as the rest of the site (#116).
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await requireNeiistMember();

  // Board members see every team; everyone else sees only their own. The full list is fetched
  // solely to answer that first case — for an ordinary member it is filtered away entirely.
  const departments = await getAllDepartments();
  const teams = visibleWorkspaceTeams(
    session.roles,
    session.scopes,
    departments.map((d) => d.name)
  );

  return (
    <div className={styles.shell}>
      <WorkspaceNav teams={teams} userName={session.user?.name ?? ""} />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
