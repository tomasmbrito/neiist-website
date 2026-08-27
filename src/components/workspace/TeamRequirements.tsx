"use client";

import { useState } from "react";
import { toast } from "sonner";
import type {
  ChecklistItem,
  RequirementStatus,
  TeamRequirement,
} from "@/utils/db/requirementQueries";
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
  /** The requerimento whose checklist is open, and its items. Loaded on demand. */
  const [openId, setOpenId] = useState<number | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [newItem, setNewItem] = useState("");

  const endpoint = `/api/workspace/requirements/checklist?department=${encodeURIComponent(team)}`;

  const loadChecklist = async (requirementId: number) => {
    const response = await fetch(`${endpoint}&requirementId=${requirementId}`);
    setChecklist(response.ok ? await response.json() : []);
  };

  const toggleOpen = async (requirementId: number) => {
    if (openId === requirementId) {
      setOpenId(null);
      return;
    }
    setOpenId(requirementId);
    setNewItem("");
    await loadChecklist(requirementId);
  };

  /**
   * One place for the fetch/toast/refresh cycle. The server's message is surfaced verbatim: SQL
   * says "Só a equipa que fez o pedido pode dizer o que espera receber", which is the whole
   * explanation, and a generic failure would leave somebody guessing why a click did nothing.
   */
  const checklistAction = async (init: RequestInit, ok?: string) => {
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (response.ok) {
        if (openId !== null) await loadChecklist(openId);
        await refresh();
        if (ok) toast.success(ok, { closeButton: true });
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível.", { closeButton: true });
    } catch {
      toast.error("Não foi possível.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

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

                {/* The To-do List from the Notion protocol (#242). Both teams see it; only the
                    requester adds and only the doer ticks, enforced in SQL. */}
                <button
                  type="button"
                  className={styles.applicationToggle}
                  onClick={() => toggleOpen(item.id)}
                  aria-expanded={openId === item.id}>
                  {item.checklistTotal > 0
                    ? `Lista · ${item.checklistDone}/${item.checklistTotal}`
                    : "Lista"}
                </button>

                {openId === item.id ? (
                  <div className={styles.applicationDetail}>
                    {checklist.length === 0 ? (
                      <p className={styles.empty}>
                        {mine
                          ? "A equipa que pediu ainda não disse o que espera receber."
                          : "Diz o que esperas receber — a equipa responsável vai marcando."}
                      </p>
                    ) : (
                      <ul className={styles.memberList}>
                        {checklist.map((entry) => (
                          <li key={entry.id} className={styles.member}>
                            <span className={styles.memberName}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={entry.done}
                                  // Only the target team may tick. Offering it to the requester
                                  // would render a control that always 403s.
                                  disabled={busy || !mine}
                                  onChange={(inputEvent) =>
                                    checklistAction({
                                      method: "PATCH",
                                      body: JSON.stringify({
                                        itemId: entry.id,
                                        done: inputEvent.target.checked,
                                      }),
                                    })
                                  }
                                />{" "}
                                {entry.item}
                              </label>
                            </span>
                            <span className={styles.memberRoles}>
                              {entry.done && entry.doneByName ? (
                                <span className={styles.cardMeta}>{entry.doneByName}</span>
                              ) : null}
                              {/* A `brief` item is deleted by unticking the option in the brief
                                  (#233), not here — SQL refuses it with that message. */}
                              {!mine && entry.source === "manual" ? (
                                <button
                                  type="button"
                                  className={styles.revokeBtn}
                                  disabled={busy}
                                  onClick={() =>
                                    checklistAction({
                                      method: "DELETE",
                                      body: JSON.stringify({ itemId: entry.id }),
                                    })
                                  }>
                                  Remover
                                </button>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Only the requesting team says what is expected. */}
                    {canEdit && !mine ? (
                      <div className={styles.grantRow}>
                        <input
                          type="text"
                          className={styles.grantInput}
                          value={newItem}
                          disabled={busy}
                          maxLength={200}
                          placeholder="O que esperas receber"
                          aria-label="Novo item da lista"
                          onChange={(inputEvent) => setNewItem(inputEvent.target.value)}
                        />
                        <button
                          type="button"
                          className={styles.grantBtn}
                          disabled={busy || newItem.trim() === ""}
                          onClick={() =>
                            checklistAction(
                              {
                                method: "POST",
                                body: JSON.stringify({
                                  requirementId: item.id,
                                  item: newItem,
                                }),
                              },
                              "Adicionado."
                            ).then(() => setNewItem(""))
                          }>
                          Adicionar
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
