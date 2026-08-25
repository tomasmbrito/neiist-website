"use client";

import { useState } from "react";
import { toast } from "sonner";
import ConfirmDialog from "@/components/layout/ConfirmDialog";
import type { TaskStatus, TeamTask } from "@/utils/db/taskQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * A team's task board (#130).
 *
 * Grouped by status rather than listed flat: the question a board answers is "what is outstanding",
 * and a single ordered list buries that under everything already done.
 *
 * `canManage` and `canDelete` only shape what is offered; both are re-checked in the route
 * against the task's own owning team.
 */
const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "Por começar",
  in_progress: "Em curso",
  done: "Concluída",
};

const STATUS_ORDER: TaskStatus[] = ["not_started", "in_progress", "done"];

const formatDue = (dueAt: string | null) => {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  const label = due.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
  // Overdue is worth surfacing: a due date nobody notices is not a due date.
  const isOverdue = due.getTime() < Date.now();
  return { label, isOverdue };
};

export default function TeamTasks({
  team,
  initialTasks,
  roster,
  events,
  canManage,
  canDelete,
}: {
  team: string;
  initialTasks: TeamTask[];
  roster: Array<{ istid: string; name: string }>;
  events: Array<{ id: number; name: string }>;
  canManage: boolean;
  canDelete: boolean;
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assignee, setAssignee] = useState("");
  const [eventId, setEventId] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<TeamTask | null>(null);

  const refresh = async () => {
    const response = await fetch(`/api/workspace/tasks?department=${encodeURIComponent(team)}`);
    if (response.ok) setTasks(await response.json());
  };

  const call = async (init: RequestInit, onOk?: () => void) => {
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/tasks", {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (response.ok) {
        onOk?.();
        await refresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível guardar.", { closeButton: true });
    } catch {
      toast.error("Não foi possível guardar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const create = (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    return call(
      {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          departmentName: team,
          // The date input has no time; a task is due by the end of its day.
          dueAt: dueAt ? new Date(`${dueAt}T23:59:59`).toISOString() : null,
          eventId: eventId ? Number(eventId) : null,
          assignees: assignee ? [assignee] : [],
        }),
      },
      () => {
        setTitle("");
        setDueAt("");
        setAssignee("");
        setEventId("");
        toast.success("Tarefa criada.", { closeButton: true });
      }
    );
  };

  return (
    <section className={styles.section}>
      <ConfirmDialog
        open={pendingDelete !== null}
        message={
          pendingDelete ? `Remover a tarefa "${pendingDelete.title}"? Esta ação é definitiva.` : ""
        }
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) call({ method: "DELETE", body: JSON.stringify({ taskId: target.id }) });
        }}
        onCancel={() => setPendingDelete(null)}
      />

      <h2 className={styles.sectionTitle}>Tarefas</h2>

      {tasks.length === 0 ? (
        <p className={styles.empty}>Ainda não há tarefas nesta equipa.</p>
      ) : (
        STATUS_ORDER.map((status) => {
          const inStatus = tasks.filter((task) => task.status === status);
          if (inStatus.length === 0) return null;
          return (
            <div key={status} className={styles.taskGroup}>
              <h3 className={styles.taskGroupTitle}>
                {STATUS_LABELS[status]} ({inStatus.length})
              </h3>
              <ul className={styles.memberList}>
                {inStatus.map((task) => {
                  const due = formatDue(task.dueAt);
                  return (
                    <li key={task.id} className={styles.member}>
                      <span className={styles.memberName}>
                        {task.title}
                        {task.eventName ? (
                          <span className={styles.cardMeta}> · {task.eventName}</span>
                        ) : null}
                      </span>
                      <span className={styles.memberRoles}>
                        {task.assignees.length > 0
                          ? task.assignees.map((person) => person.name).join(", ")
                          : "sem responsável"}
                        {due ? (
                          <span
                            className={due.isOverdue && status !== "done" ? styles.overdue : ""}>
                            {" · "}
                            {due.label}
                          </span>
                        ) : null}
                        {canManage ? (
                          <select
                            className={styles.inlineSelect}
                            value={task.status}
                            disabled={busy}
                            aria-label={`Estado de ${task.title}`}
                            onChange={(inputEvent) =>
                              call({
                                method: "PATCH",
                                body: JSON.stringify({
                                  taskId: task.id,
                                  status: inputEvent.target.value,
                                }),
                              })
                            }>
                            {STATUS_ORDER.map((option) => (
                              <option key={option} value={option}>
                                {STATUS_LABELS[option]}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {canDelete ? (
                          <button
                            type="button"
                            className={styles.revokeBtn}
                            disabled={busy}
                            onClick={() => setPendingDelete(task)}>
                            Remover
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}

      {canManage ? (
        <form className={styles.grantForm} onSubmit={create}>
          <div className={styles.grantRow}>
            <input
              className={styles.grantInput}
              value={title}
              onChange={(inputEvent) => setTitle(inputEvent.target.value)}
              placeholder="O que é preciso fazer"
              disabled={busy}
              required
            />
            <select
              className={styles.grantInput}
              value={assignee}
              onChange={(inputEvent) => setAssignee(inputEvent.target.value)}
              disabled={busy}
              aria-label="Responsável">
              <option value="">Sem responsável</option>
              {roster.map((member) => (
                <option key={member.istid} value={member.istid}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.grantRow}>
            <input
              className={styles.grantInput}
              type="date"
              value={dueAt}
              onChange={(inputEvent) => setDueAt(inputEvent.target.value)}
              disabled={busy}
              aria-label="Data limite"
            />
            <select
              className={styles.grantInput}
              value={eventId}
              onChange={(inputEvent) => setEventId(inputEvent.target.value)}
              disabled={busy}
              aria-label="Evento">
              <option value="">Sem evento associado</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
            <button type="submit" className={styles.grantBtn} disabled={busy || !title.trim()}>
              {busy ? "A criar..." : "Criar tarefa"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
