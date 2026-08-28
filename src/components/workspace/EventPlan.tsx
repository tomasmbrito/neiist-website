"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { EventPlan, PlanExternal, PlanTodo } from "@/utils/db/eventPlanQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * Plano de Atividades (#247) — what the team writes before anything else exists.
 *
 * Modelled on the real plans in the Organização de Eventos Drive. Two things are deliberately
 * absent, and both are the same rule:
 *
 *  * **No local, data or hora.** Those belong to the event, shown at the top of this page. A second
 *    copy here is the bug where the poster says 16:00 and the event says 17:00.
 *  * **No "Comunicação Interna" list.** In Drive that is a heading per team with dashes under it;
 *    here it IS the set of requerimentos, which the panel below already shows.
 *
 * The interesting control is "Fazer requerimento" on a to-do. In Drive, *"Fazer o requerimento de
 * visuais — Guilherme Carreira"* is a line somebody has to remember to act on. Here it becomes the
 * requerimento, and the to-do links to it.
 */
const EXTERNAL_LABELS: Record<PlanExternal["kind"], string> = {
  orador: "Orador",
  patrocinio: "Patrocínio",
  parceiro: "Parceiro",
  outro: "Outro",
};

export default function EventPlanPanel({
  eventId,
  team,
  initialPlan,
  initialTodos,
  initialExternals,
  roster,
  otherTeams,
}: {
  eventId: number;
  team: string;
  initialPlan: EventPlan | null;
  initialTodos: PlanTodo[];
  initialExternals: PlanExternal[];
  roster: { istid: string; name: string }[];
  otherTeams: string[];
}) {
  const [plan, setPlan] = useState(initialPlan);
  const [todos, setTodos] = useState(initialTodos);
  const [externals, setExternals] = useState(initialExternals);
  const [busy, setBusy] = useState(false);

  const [objetivo, setObjetivo] = useState(initialPlan?.objetivo ?? "");
  const [estrutura, setEstrutura] = useState(initialPlan?.estrutura ?? "");
  const [newTodo, setNewTodo] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [externalName, setExternalName] = useState("");
  const [externalKind, setExternalKind] = useState<PlanExternal["kind"]>("orador");
  const [raisingFor, setRaisingFor] = useState<number | null>(null);
  const [raiseTarget, setRaiseTarget] = useState("");

  const canEdit = plan?.canEdit ?? true;
  const endpoint = `/api/workspace/events/plan?department=${encodeURIComponent(team)}`;

  const refresh = async () => {
    const response = await fetch(
      `/api/workspace/events/plan/read?department=${encodeURIComponent(team)}&eventId=${eventId}`
    );
    if (!response.ok) return;
    const body = await response.json();
    setPlan(body.plan);
    setTodos(body.todos);
    setExternals(body.externals);
  };

  /**
   * One place for the fetch/toast/refresh cycle. The server's message is surfaced verbatim: SQL
   * says "Esta tarefa já deu origem a um requerimento. Cancela o requerimento primeiro", which is
   * the whole explanation, and a generic failure would leave somebody guessing.
   */
  const act = async (init: RequestInit, ok?: string) => {
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (response.ok) {
        await refresh();
        if (ok) toast.success(ok, { closeButton: true });
        return true;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível.", { closeButton: true });
      return false;
    } catch {
      toast.error("Não foi possível.", { closeButton: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openTodos = todos.filter((todo) => !todo.done).length;

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Plano de Atividades</h2>
      <p className={styles.cardMeta}>
        O que é o evento, quem é responsável, e o que falta fazer. A data e o local vêm do evento —
        não são escritos aqui.
      </p>

      {canEdit ? (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="objetivo">
              Objetivo(s)
            </label>
            <textarea
              id="objetivo"
              className={styles.notesArea}
              value={objetivo}
              disabled={busy}
              rows={5}
              placeholder="Para que serve este evento?"
              onChange={(inputEvent) => setObjetivo(inputEvent.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="estrutura">
              Estrutura
            </label>
            <textarea
              id="estrutura"
              className={styles.notesArea}
              value={estrutura}
              disabled={busy}
              rows={4}
              placeholder="Como vai decorrer"
              onChange={(inputEvent) => setEstrutura(inputEvent.target.value)}
            />
          </div>
          <button
            type="button"
            className={styles.grantBtn}
            disabled={busy}
            onClick={() =>
              act(
                {
                  method: "POST",
                  body: JSON.stringify({
                    eventId,
                    objetivo: objetivo.trim() || null,
                    estrutura: estrutura.trim() || null,
                    coordinatorIstid: plan?.coordinatorIstid ?? null,
                  }),
                },
                "Plano guardado."
              )
            }>
            Guardar plano
          </button>
        </>
      ) : (
        <>
          {/* A collaborating team reads the plan — a poster designer needs the objetivo — but the
              plan is the owning team's statement of what the event is. */}
          <p className={styles.notesRead}>{plan?.objetivo || "Sem objetivo escrito."}</p>
          {plan?.estrutura ? <p className={styles.notesRead}>{plan.estrutura}</p> : null}
        </>
      )}

      <h2 className={styles.sectionTitle} style={{ marginTop: "1.5rem" }}>
        Comunicação externa ({externals.length})
      </h2>
      {externals.length === 0 ? (
        <p className={styles.empty}>Sem oradores, patrocínios ou parceiros.</p>
      ) : (
        <ul className={styles.memberList}>
          {externals.map((external) => (
            <li key={external.id} className={styles.member}>
              <span className={styles.memberName}>
                {external.name}
                <span className={styles.cardMeta}> · {EXTERNAL_LABELS[external.kind]}</span>
              </span>
              {canEdit ? (
                <button
                  type="button"
                  className={styles.revokeBtn}
                  disabled={busy}
                  onClick={() =>
                    act({
                      method: "DELETE",
                      body: JSON.stringify({ kind: "external", id: external.id }),
                    })
                  }>
                  Remover
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className={styles.grantRow}>
          <select
            className={styles.inlineSelect}
            value={externalKind}
            disabled={busy}
            aria-label="Tipo"
            onChange={(inputEvent) =>
              setExternalKind(inputEvent.target.value as PlanExternal["kind"])
            }>
            {Object.entries(EXTERNAL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="text"
            className={styles.grantInput}
            value={externalName}
            disabled={busy}
            maxLength={200}
            placeholder="Nome"
            aria-label="Nome"
            onChange={(inputEvent) => setExternalName(inputEvent.target.value)}
          />
          <button
            type="button"
            className={styles.grantBtn}
            disabled={busy || externalName.trim() === ""}
            onClick={() =>
              act({
                method: "POST",
                body: JSON.stringify({
                  action: "external",
                  eventId,
                  kind: externalKind,
                  name: externalName,
                }),
              }).then((ok) => ok && setExternalName(""))
            }>
            Adicionar
          </button>
        </div>
      ) : null}

      <h2 className={styles.sectionTitle} style={{ marginTop: "1.5rem" }}>
        To Dos ({openTodos} por fazer)
      </h2>
      {todos.length === 0 ? (
        <p className={styles.empty}>Nada planeado ainda.</p>
      ) : (
        <ul className={styles.memberList}>
          {todos.map((todo) => (
            <li key={todo.id} className={styles.member}>
              <span className={styles.memberName}>
                <label>
                  <input
                    type="checkbox"
                    checked={todo.done}
                    disabled={busy || !canEdit}
                    onChange={(inputEvent) =>
                      act({
                        method: "POST",
                        body: JSON.stringify({
                          action: "todo-done",
                          todoId: todo.id,
                          done: inputEvent.target.checked,
                        }),
                      })
                    }
                  />{" "}
                  {todo.task}
                </label>
                <span className={styles.cardMeta}>
                  {todo.assigneeName ? ` · ${todo.assigneeName}` : ""}
                  {/* The join: this to-do produced a requerimento, and says which. */}
                  {todo.requirementId
                    ? ` · requerimento a ${todo.requirementTeam} (${todo.requirementStatus})`
                    : ""}
                </span>
              </span>
              <span className={styles.memberRoles}>
                {canEdit && !todo.requirementId ? (
                  raisingFor === todo.id ? (
                    <>
                      <select
                        className={styles.inlineSelect}
                        value={raiseTarget}
                        disabled={busy}
                        aria-label="Equipa"
                        onChange={(inputEvent) => setRaiseTarget(inputEvent.target.value)}>
                        <option value="">Escolhe a equipa…</option>
                        {otherTeams.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className={styles.grantBtn}
                        disabled={busy || raiseTarget === ""}
                        onClick={() =>
                          act(
                            {
                              method: "POST",
                              body: JSON.stringify({
                                action: "raise",
                                todoId: todo.id,
                                targetDepartment: raiseTarget,
                                title: todo.task,
                              }),
                            },
                            "Requerimento criado."
                          ).then((ok) => {
                            if (ok) {
                              setRaisingFor(null);
                              setRaiseTarget("");
                            }
                          })
                        }>
                        Criar
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.grantBtn}
                      disabled={busy}
                      onClick={() => setRaisingFor(todo.id)}>
                      Fazer requerimento
                    </button>
                  )
                ) : null}
                {canEdit && !todo.requirementId ? (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    disabled={busy}
                    onClick={() =>
                      act({ method: "DELETE", body: JSON.stringify({ id: todo.id }) })
                    }>
                    Remover
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className={styles.grantRow}>
          <input
            type="text"
            className={styles.grantInput}
            value={newTodo}
            disabled={busy}
            maxLength={300}
            placeholder="O que é preciso fazer"
            aria-label="Nova tarefa"
            onChange={(inputEvent) => setNewTodo(inputEvent.target.value)}
          />
          <select
            className={styles.inlineSelect}
            value={newAssignee}
            disabled={busy}
            aria-label="Responsável"
            onChange={(inputEvent) => setNewAssignee(inputEvent.target.value)}>
            <option value="">Sem responsável</option>
            {roster.map((person) => (
              <option key={person.istid} value={person.istid}>
                {person.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.grantBtn}
            disabled={busy || newTodo.trim() === ""}
            onClick={() =>
              act({
                method: "POST",
                body: JSON.stringify({
                  action: "todo",
                  eventId,
                  task: newTodo,
                  assigneeIstid: newAssignee || null,
                }),
              }).then((ok) => ok && setNewTodo(""))
            }>
            Adicionar
          </button>
        </div>
      ) : null}
    </section>
  );
}
