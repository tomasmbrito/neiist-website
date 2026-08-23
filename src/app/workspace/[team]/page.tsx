import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTeamWorkspace } from "@/utils/permissionUtils";
import { accessRank, canForTeam, ROLE_LABELS } from "@/lib/auth/permissions";
import {
  getAllDepartments,
  getAllMemberships,
  getTeamAccessGrants,
  getUserActiveGrants,
} from "@/utils/db/userQueries";
import { groupMembershipsByMember } from "@/types/memberships";
import TeamAccessGrants from "@/components/workspace/TeamAccessGrants";
import { UserRole } from "@/types/user";
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
  // Next's App Router already decodes dynamic params. Decoding again would be a second pass —
  // it throws URIError on a literal "%" before the guard below can run, and it is the only
  // decodeURIComponent on a param anywhere in src/app.
  const { team } = await params;

  const session = await requireTeamWorkspace(team, "team.workspace.view");

  // Only after authorization: a team that does not exist is a 404, but an unauthorized caller
  // never learns the difference, because the guard above already redirected them.
  const departments = await getAllDepartments();
  if (!departments.some((d) => d.name === team && d.active)) notFound();

  const memberships = await getAllMemberships();
  const members = groupMembershipsByMember(
    memberships.filter((m) => m.departmentName === team && m.isActive)
  );
  const mayEdit = canForTeam(session.roles, session.scopes, "team.content.edit", team);
  const myAccess = session.scopes.find((s) => s.departmentName === team)?.access;

  // Temporary access (#184). `canGrant` is organisation-wide access, mirroring the SQL rule that
  // only the board creates new authority; `delegatable` is a live grant of the caller's own on
  // this team that they could pass on. Both only decide what the UI *offers* — every rule is
  // enforced in `create_team_access_grant`, so a wrong answer here is a bad offer, not a bad grant.
  const grants = await getTeamAccessGrants(team);
  const canGrant = session.roles.includes(UserRole._ADMIN);
  // The receiving team's own coordinator may revoke anyone's grant on it — by MEMBERSHIP, so a
  // grantee holding coordinator-level borrowed access cannot revoke the people around them.
  const canRevokeAny =
    canGrant ||
    session.scopes.some(
      (scope) =>
        scope.departmentName === team &&
        scope.source === "membership" &&
        accessRank(scope.access) >= accessRank(UserRole._COORDINATOR)
    );
  const delegatable = canGrant
    ? null
    : ((await getUserActiveGrants(session.user!.istid)).find(
        // Only a root grant may be delegated: the chain is capped at one hop.
        (grant) => grant.departmentName === team && grant.parentGrantId === null
      ) ?? null);

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

      <TeamAccessGrants
        team={team}
        initialGrants={grants}
        canGrant={canGrant}
        delegatableGrantId={delegatable?.id ?? null}
        maxAccess={delegatable?.access ?? null}
        canRevokeAny={canRevokeAny}
        viewerIstid={session.user!.istid}
      />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Conteúdo</h2>
        <p className={styles.empty}>
          Ainda não há conteúdo nesta área. As páginas do Notion serão migradas para aqui.
        </p>
      </section>
    </>
  );
}
