"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { ApplicationOutcome, TeamApplication } from "@/utils/db/recruitmentQueries";
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
 */
const OUTCOME_LABELS: Record<ApplicationOutcome, string> = {
  pending: "Por decidir",
  accepted: "Aceite",
  rejected: "Rejeitada",
};

const formatSubmitted = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" });

export default function TeamApplications({
  team,
  initialApplications,
}: {
  team: string;
  initialApplications: TeamApplication[];
}) {
  const [applications, setApplications] = useState(initialApplications);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch(
      `/api/workspace/applications?department=${encodeURIComponent(team)}`
    );
    if (response.ok) setApplications(await response.json());
  };

  const decide = async (applicationId: number, outcome: ApplicationOutcome) => {
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/applications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, departmentName: team, outcome }),
      });
      if (response.ok) {
        await refresh();
        toast.success(
          outcome === "pending"
            ? "Decisão anulada."
            : `Candidatura ${OUTCOME_LABELS[outcome].toLowerCase()}.`,
          { closeButton: true }
        );
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível guardar a decisão.", { closeButton: true });
    } catch {
      toast.error("Não foi possível guardar a decisão.", { closeButton: true });
    } finally {
      setBusy(false);
    }
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
                  {application.outcome === "pending" ? (
                    <>
                      <button
                        type="button"
                        className={styles.grantBtn}
                        style={{
                          marginLeft: "0.6rem",
                          padding: "0.2rem 0.7rem",
                          fontSize: "0.75rem",
                        }}
                        disabled={busy}
                        onClick={() => decide(application.id, "accepted")}>
                        Aceitar
                      </button>
                      <button
                        type="button"
                        className={styles.revokeBtn}
                        disabled={busy}
                        onClick={() => decide(application.id, "rejected")}>
                        Rejeitar
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.revokeBtn}
                      disabled={busy}
                      onClick={() => decide(application.id, "pending")}>
                      Anular
                    </button>
                  )}
                </span>
              </div>

              {expanded === application.id ? (
                <div className={styles.applicationDetail}>
                  <p className={styles.cardMeta}>
                    {application.email}
                    {application.phone ? ` · ${application.phone}` : ""}
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
