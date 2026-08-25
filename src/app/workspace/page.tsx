import Link from "next/link";
import { requireNeiistMember } from "@/utils/permissionUtils";
import { visibleWorkspaceTeams, canForTeam, ROLE_LABELS } from "@/lib/auth/permissions";
import { getAllDepartments } from "@/utils/db/userQueries";
import { getUserTasks } from "@/utils/db/taskQueries";

/** Mirrors TeamTasks; the dashboard shows the same words for the same states. */
const TASK_STATUS_LABELS = {
  not_started: "Por começar",
  in_progress: "Em curso",
  done: "Concluída",
} as const;
import styles from "@/styles/pages/Workspace.module.css";

export const metadata = { title: "Espaço de Trabalho | NEIIST" };

/**
 * The workspace index: the teams this member belongs to, and what they may do in each.
 *
 * Deliberately shows the caller's access level per team. Someone who is a coordinator of one team
 * and a plain member of another needs to see which is which before acting — the alternative is
 * discovering it from a 403.
 */
export default async function WorkspacePage() {
  const session = await requireNeiistMember();
  const departments = await getAllDepartments();
  const teams = visibleWorkspaceTeams(
    session.roles,
    session.scopes,
    departments.filter((d) => d.active).map((d) => d.name)
  );

  // The member dashboard's core panel (#130): my tasks, across every team I belong to. Scoped in
  // SQL through `get_user_team_scopes`, so a task in a team I have left drops off by itself.
  const myTasks = session.user ? await getUserTasks(session.user.istid) : [];
  const openTasks = myTasks.filter((task) => task.status !== "done");

  const accessIn = (team: string) =>
    session.scopes.find((scope) => scope.departmentName === team)?.access;

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>Espaço de Trabalho</h1>
        <p className={styles.subtitle}>
          As equipas de que fazes parte. Só os membros de cada equipa veem o respetivo espaço.
        </p>
      </header>

      {myTasks.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>As minhas tarefas ({openTasks.length} por fazer)</h2>
          <ul className={styles.memberList}>
            {myTasks.slice(0, 8).map((task) => {
              const due = task.dueAt ? new Date(task.dueAt) : null;
              const overdue = due !== null && due.getTime() < Date.now() && task.status !== "done";
              return (
                <li key={task.id} className={styles.member}>
                  <span className={styles.memberName}>
                    {task.title}
                    <span className={styles.cardMeta}> · {task.departmentName}</span>
                  </span>
                  <span className={styles.memberRoles}>
                    {TASK_STATUS_LABELS[task.status]}
                    {due ? (
                      <span className={overdue ? styles.overdue : ""}>
                        {" · "}
                        {due.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" })}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {teams.length === 0 ? (
        <p className={styles.empty}>Ainda não pertences a nenhuma equipa.</p>
      ) : (
        <ul className={styles.grid}>
          {teams.map((team) => {
            const access = accessIn(team);
            const mayEdit = canForTeam(session.roles, session.scopes, "team.content.edit", team);
            return (
              <li key={team}>
                <Link href={`/workspace/${encodeURIComponent(team)}`} className={styles.card}>
                  <span className={styles.cardTitle}>{team}</span>
                  <span className={styles.cardMeta}>
                    {access ? ROLE_LABELS[access] : "Acesso da direção"}
                    {mayEdit ? " · pode editar" : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
