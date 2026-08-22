import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTeamWorkspace } from "@/utils/permissionUtils";
import { canForTeam, ROLE_LABELS } from "@/lib/auth/permissions";
import { getAllDepartments, getAllMemberships } from "@/utils/db/userQueries";
import { groupMembershipsByMember } from "@/types/memberships";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * One team's workspace.
 *
 * `requireTeamWorkspace` runs **before any data is fetched**, not after — the member list below is
 * exactly the internal information a member of another team must not receive, so fetching first
 * and rendering conditionally would already have leaked it into the server's memory and, on any
 * future refactor, into the response.
 */
export default async function TeamWorkspacePage({ params }: { params: Promise<{ team: string }> }) {
  const { team: rawTeam } = await params;
  const team = decodeURIComponent(rawTeam);

  const session = await requireTeamWorkspace(team, "team.workspace.view");

  // Only after authorization: a team that does not exist is a 404, but an unauthorized caller
  // never learns the difference, because the guard above already redirected them.
  const departments = await getAllDepartments();
  if (!departments.some((d) => d.name === team)) notFound();

  const memberships = await getAllMemberships();
  const members = groupMembershipsByMember(
    memberships.filter((m) => m.departmentName === team && m.isActive)
  );
  const mayEdit = canForTeam(session.roles, session.scopes, "team.content.edit", team);
  const myAccess = session.scopes.find((s) => s.departmentName === team)?.access;

  return (
    <>
      <header className={styles.header}>
        <nav className={styles.breadcrumb}>
          <Link href="/workspace">Espaço de Trabalho</Link> <span aria-hidden="true">/</span> {team}
        </nav>
        <h1 className={styles.title}>{team}</h1>
        <p className={styles.subtitle}>
          O teu acesso: {myAccess ? ROLE_LABELS[myAccess] : "Direção"}
          {mayEdit ? " — podes gerir esta equipa." : " — acesso de leitura."}
        </p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Equipa ({members.length})</h2>
        <ul className={styles.memberList}>
          {members.map((member) => (
            <li key={member.userNumber} className={styles.member}>
              <span className={styles.memberName}>{member.userName}</span>
              <span className={styles.memberRoles}>
                {member.positions.map((p) => p.roleName).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Conteúdo</h2>
        <p className={styles.empty}>
          Ainda não há conteúdo nesta área. As páginas do Notion serão migradas para aqui.
        </p>
      </section>
    </>
  );
}
