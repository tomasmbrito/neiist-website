"use client";

import { useState } from "react";
import { toast } from "sonner";
import type {
  ApplicationOutcome,
  ApprovalDecision,
  ApprovalSide,
  TeamApplication,
} from "@/utils/db/recruitmentQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * Reviewing this team's applications (#134).
 *
 * Two things shape the design:
 *
 *  - **The decision is this team's alone.** Someone who applied to three teams appears on three
 *    boards, and each decides separately. The other teams are shown by name only, so a
 *    coordinator knows the person is also being considered elsewhere without seeing — or being
 *    influenced by — what those teams decided.
 *  - **This is somebody's personal data.** The panel only renders for callers holding
 *    `team.recruitment.decide`, which is checked on the server and again in the route; the
 *    contact details are deliberately not shown in the collapsed row.
 *
 * #217 changed the shape of the decision. There is no longer an "accept" button that decides
 * anything: each person signs **their own half**, and the outcome appears only once the team's
 * coordinator and a member of the board have both signed. What this component renders is
 * therefore two signatures and their state, not one verdict — and `mySides` comes from the
 * server, which is also the only thing that decides whether a signature is accepted.
 */
const OUTCOME_LABELS: Record<ApplicationOutcome, string> = {
  pending: "Por decidir",
  accepted: "Aceite",
  rejected: "Rejeitada",
};

const SIDE_LABELS: Record<ApprovalSide, string> = {
  team: "Coordenação",
  board: "Direção",
};

/** One half of the pair, as a sentence. `null` means nobody has signed that half yet. */
function signatureLine(
  side: ApprovalSide,
  decision: ApprovalDecision | null,
  actor: string | null
): string {
  if (!decision) return `${SIDE_LABELS[side]}: por assinar`;
  const verb = decision === "accept" ? "aceitou" : "rejeitou";
  return `${SIDE_LABELS[side]}: ${verb}${actor ? ` — ${actor}` : ""}`;
}

const formatSubmitted = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" });

export default function TeamApplications({
  team,
  initialApplications,
  mySides,
  viewerIstid,
}: {
  team: string;
  initialApplications: TeamApplication[];
  /**
   * Which halves this viewer may sign, from SQL. Usually one; both only for someone who is a
   * coordinator of this team *and* on the board — who may still fill only one of them.
   */
  mySides: ApprovalSide[];
  viewerIstid: string;
}) {
  const [applications, setApplications] = useState(initialApplications);
  const [sides, setSides] = useState(mySides);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch(
      `/api/workspace/applications?department=${encodeURIComponent(team)}`
    );
    if (response.ok) {
      const body = await response.json();
      setApplications(body.applications);
      setSides(body.sides);
    }
  };

  /** Sign your own half. Which half is decided by SQL; `side` is only sent when it is ambiguous. */
  const signHalf = async (
    applicationId: number,
    decision: ApprovalDecision,
    side?: ApprovalSide
  ) => {
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/applications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, departmentName: team, decision, side }),
      });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        await refresh();
        // Deliberately does not say "accepted" — one signature decides nothing, and telling
        // someone their click accepted a candidate is how they stop looking for the second.
        toast.success(
          `Assinaste como ${SIDE_LABELS[(body.side as ApprovalSide) ?? "team"]}. ` +
            "Falta a outra aprovação para a decisão ficar fechada.",
          { closeButton: true }
        );
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível registar a aprovação.", { closeButton: true });
    } catch {
      toast.error("Não foi possível registar a aprovação.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  /** Take back your own signature. Reopens the decision. */
  const withdraw = async (applicationId: number) => {
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/applications", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, departmentName: team }),
      });
      if (response.ok) {
        await refresh();
        toast.success("Retiraste a tua aprovação.", { closeButton: true });
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível retirar a aprovação.", { closeButton: true });
    } catch {
      toast.error("Não foi possível retirar a aprovação.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Have I already signed this one? The server answers this properly; this only decides which
   * button to offer. Getting it wrong shows a button that fails, not a signature that succeeds.
   */
  const mySignature = (application: TeamApplication): ApprovalSide | null => {
    if (sides.includes("team") && application.teamActor === viewerIstid) return "team";
    if (sides.includes("board") && application.boardActor === viewerIstid) return "board";
    return null;
  };

  const pending = applications.filter((application) => application.outcome === "pending");

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        Candidaturas{pending.length > 0 ? ` (${pending.length} por decidir)` : ""}
      </h2>

      {applications.length === 0 ? (
        <p className={styles.empty}>Não há candidaturas a esta equipa.</p>
      ) : (
        <ul className={styles.memberList}>
          {applications.map((application) => (
            <li key={application.id} className={styles.applicationRow}>
              <div className={styles.member} style={{ background: "transparent", padding: 0 }}>
                <span className={styles.memberName}>
                  <button
                    type="button"
                    className={styles.applicationToggle}
                    onClick={() => setExpanded(expanded === application.id ? null : application.id)}
                    aria-expanded={expanded === application.id}>
                    {application.fullName}
                  </button>
                  <span className={styles.cardMeta}>
                    {" "}
                    · {application.istid}
                    {application.course ? ` · ${application.course}` : ""}
                    {application.year ? ` · ${application.year}º ano` : ""}
                  </span>
                </span>
                <span className={styles.memberRoles}>
                  {OUTCOME_LABELS[application.outcome]} · {formatSubmitted(application.submittedAt)}
                  {mySignature(application) ? (
                    <button
                      type="button"
                      className={styles.revokeBtn}
                      disabled={busy}
                      onClick={() => withdraw(application.id)}>
                      Retirar a minha aprovação
                    </button>
                  ) : sides.length > 0 ? (
                    // Someone holding both halves is asked which one; everyone else has only one
                    // to give, and SQL works it out without being told.
                    sides.map((side) => (
                      <span key={side}>
                        <button
                          type="button"
                          className={styles.grantBtn}
                          style={{
                            marginLeft: "0.6rem",
                            padding: "0.2rem 0.7rem",
                            fontSize: "0.75rem",
                          }}
                          disabled={busy}
                          onClick={() =>
                            signHalf(application.id, "accept", sides.length > 1 ? side : undefined)
                          }>
                          {sides.length > 1 ? `Aceitar (${SIDE_LABELS[side]})` : "Aceitar"}
                        </button>
                        <button
                          type="button"
                          className={styles.revokeBtn}
                          disabled={busy}
                          onClick={() =>
                            signHalf(application.id, "reject", sides.length > 1 ? side : undefined)
                          }>
                          {sides.length > 1 ? `Rejeitar (${SIDE_LABELS[side]})` : "Rejeitar"}
                        </button>
                      </span>
                    ))
                  ) : null}
                </span>
              </div>

              {expanded === application.id ? (
                <div className={styles.applicationDetail}>
                  <p className={styles.cardMeta}>
                    {application.email}
                    {application.phone ? ` · ${application.phone}` : ""}
                  </p>
                  {/* The two signatures, always visible — an application that looks decided but is
                      waiting on the board is the thing a coordinator most needs to see. */}
                  <p className={styles.cardMeta}>
                    {signatureLine("team", application.teamDecision, application.teamActor)}
                    {" · "}
                    {signatureLine("board", application.boardDecision, application.boardActor)}
                  </p>
                  {application.otherTeams.length > 0 ? (
                    <p className={styles.cardMeta}>
                      Candidatou-se também a: {application.otherTeams.join(", ")} — cada equipa
                      decide separadamente.
                    </p>
                  ) : null}
                  {application.motivation ? (
                    <p className={styles.notesRead}>{application.motivation}</p>
                  ) : (
                    <p className={styles.empty}>Sem motivação escrita.</p>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
