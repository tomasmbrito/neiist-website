"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { RequirementStatus, TeamRequirement } from "@/utils/db/requirementQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * Requerimentos — what my team owes, and what my team is waiting on (#232).
 *
 * The two directions are deliberately in one list rather than two panels. A coordinator's real
 * question is "what is outstanding on this event", and that spans both: the poster we are drawing
 * and the campaign we are waiting for are the same conversation.
 *
 * The buttons offered differ by direction, and that asymmetry is the point — see the note on
 * `advance` below. Getting it wrong here shows a button that fails; SQL is what actually decides.
 */
const STATUS_LABELS: Record<RequirementStatus, string> = {
  requested: "Pedido",
  accepted: "Aceite",
  in_progress: "Em curso",
  done: "Entregue",
  cancelled: "Cancelado",
};

/** What the target team can move to next. `cancelled` is offered separately, to both sides. */
const NEXT_STATUS: Partial<Record<RequirementStatus, RequirementStatus>> = {
  requested: "accepted",
  accepted: "in_progress",
  in_progress: "done",
};

const formatDeadline = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-PT", { day: "2-digit", month: "short" }) : "sem prazo";

export default function TeamRequirements({
  team,
  initialRequirements,
  canEdit,
}: {
  team: string;
  initialRequirements: TeamRequirement[];
  canEdit: boolean;
}) {
  const [requirements, setRequirements] = useState(initialRequirements);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch(
      `/api/workspace/requirements?department=${encodeURIComponent(team)}`
    );
    if (response.ok) setRequirements(await response.json());
  };

  const patch = async (body: object, ok: string) => {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/workspace/requirements?department=${encodeURIComponent(team)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (response.ok) {
        await refresh();
        toast.success(ok, { closeButton: true });
        return;
      }
      // SQL refuses the requesting team advancing its own request, with a message that says so.
      const error = await response.json().catch(() => ({}));
      toast.error(error.error || "Não foi possível.", { closeButton: true });
    } catch {
      toast.error("Não foi possível.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const openCount = requirements.filter(
    (r) => r.status !== "done" && r.status !== "cancelled"
  ).length;

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Requerimentos ({openCount} em aberto)</h2>
      <p className={styles.cardMeta}>
        O que pediram à tua equipa, e o que a tua equipa pediu a outras. Só a equipa responsável
        avança o estado — quem pediu pode cancelar.
      </p>

      {requirements.length === 0 ? (
        <p className={styles.empty}>Não há requerimentos.</p>
      ) : (
        <ul className={styles.memberList}>
          {requirements.map((item) => {
            const mine = item.direction === "inbox";
            const next = NEXT_STATUS[item.status];
            const closed = item.status === "done" || item.status === "cancelled";

            return (
              <li key={item.id} className={styles.member}>
                <span className={styles.memberName}>
                  {item.title}
                  <span className={styles.cardMeta}>
                    {" "}
                    · {item.eventName} ·{" "}
                    {mine
                      ? `pedido por ${item.requestingDepartment}`
                      : `para ${item.targetDepartment}`}
                    {item.assigneeName ? ` · ${item.assigneeName}` : ""}
                    {item.deliverableCount > 0 ? ` · ${item.deliverableCount} entrega(s)` : ""}
                  </span>
                </span>
                <span className={styles.memberRoles}>
                  {STATUS_LABELS[item.status]} · {formatDeadline(item.deadline)}
                  {/* Only the TARGET team advances. Offering the button to the requesting team
                      would render a control that always fails — SQL refuses it. */}
                  {canEdit && mine && next && !closed ? (
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
                        patch(
                          { requirementId: item.id, status: next },
                          `Marcado como ${STATUS_LABELS[next].toLowerCase()}.`
                        )
                      }>
                      {STATUS_LABELS[next]}
                    </button>
                  ) : null}
                  {/* Either side may cancel: withdrawing your own request is not a claim about
                      somebody else's work. */}
                  {canEdit && !closed ? (
                    <button
                      type="button"
                      className={styles.revokeBtn}
                      disabled={busy}
                      onClick={() =>
                        patch(
                          { requirementId: item.id, status: "cancelled" },
                          "Requerimento cancelado."
                        )
                      }>
                      Cancelar
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
