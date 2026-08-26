import crypto from "crypto";
import { db_query } from "@/utils/db/dbClient";
import { sendEmail } from "@/utils/emailUtils";
import { createInternalEvent } from "@/utils/db/eventQueries";
import { claimInterviewSlot, confirmInterviewSlot } from "@/utils/db/interviewQueries";

/**
 * Booking an interview, end to end (#218).
 *
 * The order of operations here is the design, not an implementation detail:
 *
 *   1. **Claim** the slot — one conditional UPDATE, whose success IS the reservation. If somebody
 *      else got there first this returns null and nothing else happens.
 *   2. **Create** the interview as an `internal_event` (#129), so it lands on the team's real
 *      calendar rather than in a second, parallel one.
 *   3. **Confirm** the slot against that event, still conditional on the hold being ours.
 *   4. **Then** email both parties — after everything is committed. A rollback can undo a booking;
 *      nothing can unsend an email (CLAUDE.md §8).
 *
 * If step 4 fails the interview still stands, and the coordinator sees the booking in the
 * workspace. That is the right way round: a booking nobody was emailed about is recoverable, an
 * email about a booking that does not exist is not.
 */

/** How long an interview invitation link stays usable. */
const INVITE_TTL_DAYS = 10;

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

type NotificationTargets = {
  candidate_name: string;
  candidate_email: string;
  coordinator_name: string;
  coordinator_mail: string | null;
  department_name: string;
  starts_at: string;
  location: string | null;
};

const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString("pt-PT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

const shell = (title: string, body: string) => `
  <div style="font-family: 'Secular One', Arial, sans-serif; background: #F2F2F7; padding: 2rem; border-radius: 1rem; color: #333;">
    <img src="${process.env.NEXT_PUBLIC_BASE_URL}/neiist_logo.svg" alt="NEIIST" style="height: 48px; margin-bottom: 1rem;" />
    <h2 style="color: #2863FD; margin-bottom: 1rem;">${title}</h2>
    ${body}
    <hr style="margin: 2rem 0; border: none; border-top: 1px solid #e9ecef;" />
    <p style="font-size: 0.9rem; color: #6c757d;">NEIIST &mdash; Núcleo Estudantil de Informática do IST</p>
  </div>`;

/**
 * Issue an interview invitation and email the link.
 *
 * The plaintext token exists in the email and nowhere else; only its hash is stored. Re-inviting
 * replaces the previous token rather than adding a second live one.
 */
export async function inviteToInterview(
  applicationId: number,
  departmentName: string,
  actorIstid: string,
  candidateName: string,
  candidateEmail: string
): Promise<boolean> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();

  await db_query(
    `SELECT neiist.issue_interview_invite(
       $1::INT, $2::VARCHAR(30), $3::TEXT, $4::TIMESTAMPTZ, $5::VARCHAR(50))`,
    [applicationId, departmentName, hash(token), expiresAt, actorIstid]
  );

  const url = `${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/candidatura/entrevista?t=${token}`;
  return sendEmail({
    to: candidateEmail,
    subject: `Entrevista para a equipa ${departmentName} do NEIIST`,
    html: shell(
      "Vamos conhecer-te!",
      `<p style="font-size: 1.1rem;">Olá, ${candidateName.split(/\s+/)[0]}!</p>
       <p>A tua candidatura à equipa <strong>${departmentName}</strong> passou à fase de entrevista.
          Escolhe o horário que te der mais jeito:</p>
       <div style="margin: 2rem 0;">
         <a href="${url}" style="background: linear-gradient(90deg,#2863FD 0%,#34D1F9 100%); color: #fff; padding: 0.9em 2em; border-radius: 0.5em; text-decoration: none; font-weight: bold; font-size: 1.1rem;">
           Marcar entrevista
         </a>
       </div>
       <p style="color: #555;">O link é pessoal e válido durante ${INVITE_TTL_DAYS} dias. Os horários são por ordem de chegada.</p>`
    ),
  });
}

export type BookingResult =
  | { ok: true; slotId: number; eventId: number; emailed: boolean }
  | { ok: false; reason: "taken" };

/** Book a slot. See the ordering note at the top of this file — it is the whole design. */
export async function bookInterview(
  slotId: number,
  applicationId: number,
  departmentName: string,
  candidateName: string
): Promise<BookingResult> {
  // 1. Claim. Never preceded by an availability read.
  const claimed = await claimInterviewSlot(slotId, applicationId);
  if (claimed === null) return { ok: false, reason: "taken" };

  const { rows } = await db_query<NotificationTargets>(
    "SELECT * FROM neiist.get_interview_notification_targets($1::INT)",
    [slotId]
  );

  const slotTimes = await db_query<{ starts_at: string; ends_at: string; coordinator: string }>(
    `SELECT starts_at, ends_at, coordinator_istid AS coordinator
     FROM neiist.interview_slots WHERE id = $1`,
    [slotId]
  );
  const slot = slotTimes.rows[0];

  // 2. The interview IS an internal event (#129), not a second calendar.
  //
  // The candidate is deliberately NOT an attendee: `event_attendees.user_istid` references
  // `users`, and a candidate has no account. Creating one to satisfy a foreign key would make
  // scheduling mint an identity as a side effect — the same thing #134 refuses when it keeps
  // onboarding from creating a membership. Their name is in the event title instead.
  const eventId = await createInternalEvent({
    kind: "meeting",
    name: `Entrevista — ${candidateName}`,
    description: null,
    startsAt: slot.starts_at,
    endsAt: slot.ends_at,
    isPublic: false,
    departmentName,
    createdByIstid: slot.coordinator,
    locations: [],
    attendees: [slot.coordinator],
  });

  // 3. Confirm, still conditional on the hold being ours and live.
  const confirmed = await confirmInterviewSlot(slotId, applicationId, eventId);
  if (!confirmed) return { ok: false, reason: "taken" };

  // 4. Only now, and never inside a transaction.
  const targets = rows[0];
  let emailed = false;
  if (targets) {
    const when = whenLabel(targets.starts_at);
    const where = targets.location ? ` em <strong>${targets.location}</strong>` : "";

    const toCandidate = await sendEmail({
      to: targets.candidate_email,
      subject: `Entrevista marcada — ${departmentName}`,
      html: shell(
        "Entrevista marcada!",
        `<p style="font-size: 1.1rem;">Olá, ${candidateName.split(/\s+/)[0]}!</p>
         <p>A tua entrevista para a equipa <strong>${departmentName}</strong> está marcada para
            <strong>${when}</strong>${where}, com ${targets.coordinator_name}.</p>
         <p>Se precisares de desmarcar, volta ao link que te enviámos.</p>`
      ),
    });

    // The coordinator is told too — the whole point of the flow is that nobody has to chase this.
    const toCoordinator = targets.coordinator_mail
      ? await sendEmail({
          to: targets.coordinator_mail,
          subject: `Entrevista marcada: ${candidateName} (${departmentName})`,
          html: shell(
            "Foi marcada uma entrevista",
            `<p><strong>${candidateName}</strong> marcou entrevista para <strong>${when}</strong>${where}.</p>
             <p>Já está no calendário da equipa, no espaço de trabalho.</p>`
          ),
        })
      : false;

    emailed = toCandidate && toCoordinator;
  }

  return { ok: true, slotId, eventId, emailed };
}

/** Resolve an interview invitation token. Same empty answer for unknown, expired, and decided. */
export async function findInterviewInvite(token: string) {
  const { rows } = await db_query<{
    application_id: number;
    department_name: string;
    full_name: string;
    email: string;
  }>("SELECT * FROM neiist.find_interview_invite($1::TEXT)", [hash(token)]);
  return rows[0] ?? null;
}
