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
import { getTeamInternalEvents } from "@/utils/db/eventQueries";
import { getTeamTasks } from "@/utils/db/taskQueries";
import TeamAccessGrants from "@/components/workspace/TeamAccessGrants";
import TeamEvents from "@/components/workspace/TeamEvents";
import TeamTasks from "@/components/workspace/TeamTasks";
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
  // Fetched only after `requireTeamWorkspace` above — a team's internal meetings are exactly what
  // someone outside it must not receive, so this must never move before the guard.
  const events = await getTeamInternalEvents(team);
  const tasks = await getTeamTasks(team);

  // The roster, for the assignee picker. Grouped so someone holding two roles appears once (#8).
  const roster = groupMembershipsByMember(
    memberships.filter((membership) => membership.departmentName === team && membership.isActive)
  ).map((member) => ({ istid: member.userNumber, name: member.userName }));
  // "Is this person the board" — derived the SAME way SQL derives it (#184 invariant 1):
  // `admin` access held through a department that is NOT a team.
  //
  // It used to be `session.roles.includes(_ADMIN)`, which stopped agreeing with SQL when #189
  // left `Dev-Team / Coordenador` seeded as `admin`. That divergence broke the exact scenario
  // #184 was built for: the Dev-Team coordinator saw the board's grant form, submitted, and got
  // NEI08 — and because `delegatable` was computed only when `!canGrant`, they were never
  // offered the delegation form either. The one person requirement 6 names could neither grant
  // nor delegate through the UI.
  const canGrant = session.scopes.some(
    (scope) =>
      scope.source === "membership" &&
      scope.access === UserRole._ADMIN &&
      scope.departmentType !== "team"
  );
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
  // Computed unconditionally: someone can be both board and a grantee, and more importantly a
  // non-board coordinator must always be offered delegation when they hold a root grant.
  const delegatable =
    (await getUserActiveGrants(session.user!.istid)).find(
      // Only a root grant may be delegated: the chain is capped at one hop.
      (grant) => grant.departmentName === team && grant.parentGrantId === null
    ) ?? null;

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

      <TeamTasks
        team={team}
        initialTasks={tasks}
        roster={roster}
        events={events.map((event) => ({ id: event.id, name: event.name }))}
        canManage={canForTeam(session.roles, session.scopes, "team.tasks.manage", team)}
        canDelete={canForTeam(session.roles, session.scopes, "team.tasks.delete", team)}
      />

      <TeamEvents
        team={team}
        initialEvents={events}
        canCreateMeeting={canForTeam(session.roles, session.scopes, "team.meetings.manage", team)}
        canCreateEvent={canForTeam(session.roles, session.scopes, "team.events.manage", team)}
        canPublish={canForTeam(session.roles, session.scopes, "team.events.publish", team)}
      />
    </>
  );
}
