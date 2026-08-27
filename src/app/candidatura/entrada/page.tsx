import OnboardingForm from "@/components/recruitment/OnboardingForm";
import styles from "@/styles/pages/Candidatura.module.css";

export const metadata = { title: "Bem-vindo ao NEIIST" };

/**
 * The page an acceptance email leads to (#224).
 *
 * Public by design — the person has no account yet, and this is the step before they get one.
 * `/candidatura` is already a public prefix in `proxy.ts`, which this inherits.
 *
 * The token is read here and passed to the client component, which never uses it to *name*
 * anything: the server resolves it to a candidate and a team.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;

  if (!t) {
    return (
      <main className={styles.container}>
        <section className={styles.done}>
          <h1 className={styles.title}>Link inválido</h1>
          <p>Falta o código. Usa o link que recebeste por email.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      <OnboardingForm token={t} />
    </main>
  );
}
