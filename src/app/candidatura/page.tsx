import { getAllDepartments } from "@/utils/db/userQueries";
import { getOpenEdition } from "@/utils/db/recruitmentQueries";
import ApplicationForm from "@/components/recruitment/ApplicationForm";
import styles from "@/styles/pages/Candidatura.module.css";

export const metadata = {
  title: "Candidatura | NEIIST",
  description: "Candidata-te para fazer parte do NEIIST.",
};

/**
 * The public application form (#134).
 *
 * No authentication at all — see the route comment in `proxy.ts` for why, and why it still had to
 * be listed there.
 *
 * Only `department_type = 'team'` is offered. The admin bodies (Direção, Mesa da Assembleia
 * Geral, Conselho Fiscal) are elected, not applied to, and listing them would invite an
 * application nobody can act on.
 */
export default async function CandidaturaPage() {
  const [edition, departments] = await Promise.all([getOpenEdition(), getAllDepartments()]);

  const teams = departments
    .filter((department) => department.active && department.department_type === "team")
    .map((department) => department.name)
    .sort((a, b) => a.localeCompare(b, "pt"));

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Candidata-te ao NEIIST</h1>

      {edition ? (
        <>
          <p className={styles.intro}>
            Estão abertas as candidaturas para <strong>{edition.name}</strong>. Podes candidatar-te
            a mais do que uma equipa — cada uma decide separadamente, por isso podes ser aceite numa
            e não noutra.
          </p>
          <ApplicationForm teams={teams} />
        </>
      ) : (
        <p className={styles.intro}>
          Não há candidaturas abertas de momento. Segue-nos nas redes sociais para saberes quando
          abrir a próxima ronda de recrutamento.
        </p>
      )}
    </div>
  );
}
