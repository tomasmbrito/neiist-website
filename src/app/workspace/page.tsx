import Link from "next/link";
import { requireNeiistMember } from "@/utils/permissionUtils";
import { visibleWorkspaceTeams, canForTeam, ROLE_LABELS } from "@/lib/auth/permissions";
import { getAllDepartments } from "@/utils/db/userQueries";
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
