import crypto from "crypto";
import { db_query } from "@/utils/db/dbClient";
import { sendEmail } from "@/utils/emailUtils";

/**
 * Telling a candidate the outcome, exactly once (#223, #134 slice C).
 *
 * This is the slice #217 was blocking, and why is worth restating: until two signatures were
 * required, a single click closed a decision, so a single click would have emailed a person that
 * they are in or out.
 *
 * **Nothing here sends from inside a transaction.** The decision is settled by a trigger, which
 * queues a row in `recruitment_decision_notifications` in the same transaction; this module drains
 * that queue afterwards. That ordering is the point — a rollback can un-write the row, and nothing
 * can unsend an email.
 *
 * The drain claims rows before sending, so two concurrent callers partition the queue rather than
 * both sending it, and a send that fails releases its claim with the reason recorded.
 */

/** How long an onboarding link stays usable. Long enough for someone on holiday, not forever. */
const TOKEN_TTL_DAYS = 14;

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

type ClaimedNotification = {
  application_id: number;
  department_name: string;
  outcome: "accepted" | "rejected";
  full_name: string;
  email: string;
  attempts: number;
};

/** The first name, for a greeting. "Ana Sofia Martins Silva" -> "Ana". */
const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] || fullName;

export function acceptedEmailTemplate(
  fullName: string,
  team: string,
  onboardingUrl: string
): string {
  const logoUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/neiist_logo.svg`;
  return `
    <div style="font-family: 'Secular One', Arial, sans-serif; background: #F2F2F7; padding: 2rem; border-radius: 1rem; color: #333;">
      <img src="${logoUrl}" alt="NEIIST" style="height: 48px; margin-bottom: 1rem;" />
      <h2 style="color: #2863FD; margin-bottom: 1rem;">Boas notícias!</h2>
      <p style="font-size: 1.1rem;">Olá, ${firstName(fullName)}!</p>
      <p>A tua candidatura à equipa <strong>${team}</strong> do NEIIST foi aceite. Bem-vindo(a)!</p>
      <p>Falta só um passo: preencher os teus dados para te podermos adicionar à equipa.</p>
      <div style="margin: 2rem 0;">
        <a href="${onboardingUrl}" style="background: linear-gradient(90deg,#2863FD 0%,#34D1F9 100%); color: #fff; padding: 0.9em 2em; border-radius: 0.5em; text-decoration: none; font-weight: bold; font-size: 1.1rem;">
          Completar inscrição
        </a>
      </div>
      <p style="color: #555;">Este link é pessoal e válido durante ${TOKEN_TTL_DAYS} dias. Se expirar, responde a este email e nós tratamos disso.</p>
      <hr style="margin: 2rem 0; border: none; border-top: 1px solid #e9ecef;" />
      <p style="font-size: 0.9rem; color: #6c757d;">NEIIST &mdash; Núcleo Estudantil de Informática do IST</p>
    </div>
  `;
}

export function rejectedEmailTemplate(fullName: string, team: string): string {
  const logoUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/neiist_logo.svg`;
  return `
    <div style="font-family: 'Secular One', Arial, sans-serif; background: #F2F2F7; padding: 2rem; border-radius: 1rem; color: #333;">
      <img src="${logoUrl}" alt="NEIIST" style="height: 48px; margin-bottom: 1rem;" />
      <h2 style="color: #2863FD; margin-bottom: 1rem;">Sobre a tua candidatura</h2>
      <p style="font-size: 1.1rem;">Olá, ${firstName(fullName)}!</p>
      <p>Obrigado por te teres candidatado à equipa <strong>${team}</strong> do NEIIST. Desta vez não vamos avançar com a tua candidatura.</p>
      <p>Isto não é uma porta fechada: as equipas mudam e abrimos recrutamento outra vez. Se quiseres, aparece nas nossas atividades — é a melhor forma de nos conhecermos.</p>
      <hr style="margin: 2rem 0; border: none; border-top: 1px solid #e9ecef;" />
      <p style="font-size: 0.9rem; color: #6c757d;">NEIIST &mdash; Núcleo Estudantil de Informática do IST</p>
    </div>
  `;
}

/**
 * Send everything waiting, and report what happened.
 *
 * Safe to call from anywhere, as often as you like: rows are claimed atomically, so a second
 * concurrent call sends nothing the first is already sending, and a row already sent is never
 * claimed again.
 *
 * Never throws. A recruitment decision must not be rolled back because SMTP was down — the
 * decision stands, the email is retried, and the failure is recorded where the team can see it.
 */
export async function dispatchDecisionEmails(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  const { rows } = await db_query<ClaimedNotification>(
    "SELECT * FROM neiist.claim_decision_notifications($1::INT)",
    [50]
  );

  for (const row of rows) {
    try {
      let tokenHash: string | null = null;
      let expiresAt: string | null = null;
      let html: string;

      if (row.outcome === "accepted") {
        // 32 bytes from a CSPRNG. Only the hash is stored — the plaintext exists in the email and
        // nowhere else, so a database read does not hand somebody an onboarding link.
        const token = crypto.randomBytes(32).toString("base64url");
        tokenHash = hash(token);
        expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();
        const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
        html = acceptedEmailTemplate(
          row.full_name,
          row.department_name,
          `${base}/candidatura/entrada?t=${token}`
        );
      } else {
        html = rejectedEmailTemplate(row.full_name, row.department_name);
      }

      const ok = await sendEmail({
        to: row.email,
        subject:
          row.outcome === "accepted"
            ? `Bem-vindo(a) à equipa ${row.department_name} do NEIIST!`
            : `A tua candidatura ao NEIIST (${row.department_name})`,
        html,
      });

      if (!ok) {
        // sendEmail returns false rather than throwing when SMTP is unconfigured or the send is
        // refused. Treating that as success would mark an email sent that never left.
        await db_query(
          "SELECT neiist.mark_decision_notification_failed($1::INT, $2::VARCHAR(30), $3::TEXT)",
          [row.application_id, row.department_name, "O envio falhou (SMTP)."]
        );
        failed += 1;
        continue;
      }

      // Marked sent AFTER the email is out, and the token is recorded in the same call — so a
      // usable token can never exist for a message nobody received.
      await db_query(
        `SELECT neiist.mark_decision_notification_sent(
           $1::INT, $2::VARCHAR(30), $3::TEXT, $4::TIMESTAMPTZ)`,
        [row.application_id, row.department_name, tokenHash, expiresAt]
      );
      sent += 1;
    } catch (error) {
      await db_query(
        "SELECT neiist.mark_decision_notification_failed($1::INT, $2::VARCHAR(30), $3::TEXT)",
        [
          row.application_id,
          row.department_name,
          error instanceof Error ? error.message : "Erro desconhecido.",
        ]
      ).catch(() => undefined);
      failed += 1;
    }
  }

  return { sent, failed };
}

/** Look up an onboarding token by its plaintext. Slice D (#224) builds the page around this. */
export async function findOnboarding(token: string) {
  const { rows } = await db_query<{
    application_id: number;
    department_name: string;
    full_name: string;
    email: string;
  }>("SELECT * FROM neiist.find_onboarding_token($1::TEXT)", [hash(token)]);
  return rows[0] ?? null;
}

/** Spend an onboarding token. Returns false if it was already used, expired, or never existed. */
export async function consumeOnboarding(token: string): Promise<boolean> {
  const { rows } = await db_query<{ consume_onboarding_token: boolean }>(
    "SELECT neiist.consume_onboarding_token($1::TEXT)",
    [hash(token)]
  );
  return rows[0]?.consume_onboarding_token ?? false;
}
