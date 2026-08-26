import InterviewBooking from "@/components/recruitment/InterviewBooking";
import styles from "@/styles/pages/Candidatura.module.css";

export const metadata = { title: "Marcar entrevista | NEIIST" };

/**
 * Interview booking, reached from the invitation email (#218).
 *
 * Public by design — a candidate has no account, and asking them to authenticate to a system they
 * have no relationship with in order to book an interview is the wrong order. `/candidatura` is
 * already a public prefix in `proxy.ts`, which this inherits; that listing matters for the reason
 * documented there, and it is not an accident that it is a prefix.
 *
 * The token is read here and handed to the client component, which never uses it to *name*
 * anything — the server resolves it to a candidate and a team.
 */
export default async function InterviewBookingPage({
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
          <p>Falta o código do convite. Usa o link que recebeste por email.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      <InterviewBooking token={t} />
    </main>
  );
}
