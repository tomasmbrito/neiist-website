"use client";

import { useState } from "react";
import { toast } from "sonner";
import ConfirmDialog from "@/components/layout/ConfirmDialog";
import {
  EVENT_VISIBILITY,
  VISIBILITY_LABELS,
  type EventVisibility,
  type InternalEvent,
} from "@/utils/db/eventQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * A team's events and meetings (#129) — the first Notion material to actually live here.
 *
 * `canCreateMeeting`, `canCreateEvent` and `canPublish` are decided on the server and only shape
 * what is offered. Every one is re-checked in the route, so a wrong answer here is a bad offer,
 * never a bad write.
 */
const LOCATION_SUGGESTIONS = ["Online", "Alameda", "TagusPark", "Externo", "V1.32 Edifício Civil"];

const formatWhen = (startsAt: string, endsAt: string | null) => {
  const start = new Date(startsAt);
  const date = start.toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = start.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  if (!endsAt) return `${date}, ${time}`;
  const end = new Date(endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  const endLabel = sameDay
    ? end.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })
    : end.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
  return `${date}, ${time}–${endLabel}`;
};

export default function TeamEvents({
  team,
  initialEvents,
  canCreateMeeting,
  canCreateEvent,
  canPublish,
  canDelete,
  canSetVisibility,
}: {
  team: string;
  initialEvents: InternalEvent[];
  canCreateMeeting: boolean;
  canCreateEvent: boolean;
  canPublish: boolean;
  /** Deletion is not grantable (#208), so it is decided separately from `canCreateEvent`. */
  canDelete: boolean;
  /** #219 — may change who sees an event. Narrowing only; the route re-checks `publish`. */
  canSetVisibility: boolean;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [kind, setKind] = useState<"meeting" | "event">(canCreateEvent ? "event" : "meeting");
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [location, setLocation] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<InternalEvent | null>(null);

  const mayCreate = canCreateMeeting || canCreateEvent;

  /** Change who can see an event. The route re-checks, and publishing is stricter than editing. */
  const changeVisibility = async (eventId: number, visibility: EventVisibility) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/workspace/events/${eventId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "visibility", visibility }),
      });
      if (response.ok) {
        await refresh();
        toast.success("Visibilidade alterada.", { closeButton: true });
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível alterar.", { closeButton: true });
    } catch {
      toast.error("Não foi possível alterar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    const response = await fetch(`/api/workspace/events?department=${encodeURIComponent(team)}`);
    if (response.ok) setEvents(await response.json());
  };

  const submit = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name: name.trim(),
          departmentName: team,
          // `datetime-local` has no zone; the browser's own offset is the right reading of what
          // the person typed, and the column is TIMESTAMPTZ.
          startsAt: new Date(startsAt).toISOString(),
          endsAt: endsAt ? new Date(endsAt).toISOString() : null,
          isPublic: kind === "event" && canPublish ? isPublic : false,
          locations: location.trim() ? [location.trim()] : [],
          attendees: [],
        }),
      });
      if (response.ok) {
        setName("");
        setStartsAt("");
        setEndsAt("");
        setLocation("");
        setIsPublic(false);
        await refresh();
        toast.success(kind === "meeting" ? "Reunião criada." : "Evento criado.", {
          closeButton: true,
        });
      } else {
        const body = await response.json();
        toast.error(body.error || "Não foi possível criar.", { closeButton: true });
      }
    } catch {
      toast.error("Não foi possível criar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    // try/catch, matching TeamAccessGrants.confirmRevoke. Without it a dropped network gives an
    // unhandled rejection out of ConfirmDialog's onConfirm: no toast, the row stays on screen,
    // and the user reasonably concludes the deletion worked.
    try {
      const response = await fetch("/api/workspace/events", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: target.id }),
      });
      if (response.ok) {
        await refresh();
        toast.success("Removido.", { closeButton: true });
      } else {
        const body = await response.json().catch(() => ({}));
        toast.error(body.error || "Não foi possível remover.", { closeButton: true });
      }
    } catch {
      toast.error("Não foi possível remover.", { closeButton: true });
    }
  };

  return (
    <section className={styles.section}>
      <ConfirmDialog
        open={pendingDelete !== null}
        message={pendingDelete ? `Remover "${pendingDelete.name}"? Esta ação é definitiva.` : ""}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <h2 className={styles.sectionTitle}>Eventos e reuniões</h2>

      {events.length === 0 ? (
        <p className={styles.empty}>Ainda não há eventos nem reuniões nesta equipa.</p>
      ) : (
        <ul className={styles.memberList}>
          {events.map((item) => (
            <li key={item.id} className={styles.member}>
              <span className={styles.memberName}>
                {/* Links to the detail page (#129 slice B): agenda, attendance, documents. */}
                <a href={`/workspace/${encodeURIComponent(team)}/events/${item.id}`}>{item.name}</a>
                <span className={styles.cardMeta}>
                  {" "}
                  {item.kind === "meeting" ? "· reunião" : "· evento"}
                  {item.isPublic ? " · público" : ""}
                </span>
              </span>
              <span className={styles.memberRoles}>
                {/* A collaborator is told plainly that the event is not theirs — they can see it
                    and work on it, but the owning team decides its fate. */}
                {!item.isOwner ? <span className={styles.cardMeta}>a colaborar · </span> : null}
                {canSetVisibility && item.isOwner ? (
                  <select
                    className={styles.inlineSelect}
                    value={item.visibility}
                    disabled={busy}
                    aria-label={`Quem vê ${item.name}`}
                    onChange={(inputEvent) =>
                      changeVisibility(item.id, inputEvent.target.value as EventVisibility)
                    }>
                    {EVENT_VISIBILITY.map((level) => (
                      <option key={level} value={level}>
                        {VISIBILITY_LABELS[level]}
                      </option>
                    ))}
                  </select>
                ) : null}
                {formatWhen(item.startsAt, item.endsAt)}
                {item.locations.length > 0 ? ` · ${item.locations.join(", ")}` : ""}
                {canDelete ? (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    onClick={() => setPendingDelete(item)}>
                    Remover
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mayCreate ? (
        <form className={styles.grantForm} onSubmit={submit}>
          <div className={styles.grantRow}>
            <select
              className={styles.grantInput}
              value={kind}
              onChange={(inputEvent) => setKind(inputEvent.target.value as "meeting" | "event")}
              disabled={busy}
              aria-label="Tipo">
              {canCreateMeeting ? <option value="meeting">Reunião</option> : null}
              {canCreateEvent ? <option value="event">Evento</option> : null}
            </select>
            <input
              className={styles.grantInput}
              value={name}
              onChange={(inputEvent) => setName(inputEvent.target.value)}
              placeholder="Nome"
              disabled={busy}
              required
            />
          </div>
          <div className={styles.grantRow}>
            <input
              className={styles.grantInput}
              type="datetime-local"
              value={startsAt}
              onChange={(inputEvent) => setStartsAt(inputEvent.target.value)}
              disabled={busy}
              aria-label="Início"
              required
            />
            <input
              className={styles.grantInput}
              type="datetime-local"
              value={endsAt}
              onChange={(inputEvent) => setEndsAt(inputEvent.target.value)}
              disabled={busy}
              aria-label="Fim (opcional)"
            />
            <input
              className={styles.grantInput}
              value={location}
              onChange={(inputEvent) => setLocation(inputEvent.target.value)}
              placeholder="Local"
              list="workspace-event-locations"
              disabled={busy}
            />
            <datalist id="workspace-event-locations">
              {LOCATION_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
          </div>
          <div className={styles.grantRow}>
            {kind === "event" && canPublish ? (
              <label className={styles.cardMeta}>
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(inputEvent) => setIsPublic(inputEvent.target.checked)}
                  disabled={busy}
                />{" "}
                Público — aparecerá no calendário dos estudantes
              </label>
            ) : (
              <span className={styles.cardMeta}>Visível apenas para a equipa.</span>
            )}
            <button type="submit" className={styles.grantBtn} disabled={busy || !name.trim()}>
              {busy ? "A criar..." : "Criar"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
