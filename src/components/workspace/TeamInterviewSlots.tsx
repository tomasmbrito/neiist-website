"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { TeamSlot } from "@/utils/db/interviewQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * A coordinator's interview availability (#218).
 *
 * Availability belongs to a **person**, not a team: three coordinators of one team have three
 * different calendars, and a candidate is meeting one of them. So the list shows everyone's, and
 * publishing always happens in the caller's own name — the route does not accept a coordinator
 * parameter, and withdrawing is scoped to your own slots inside SQL.
 */
const formatSlot = (iso: string) =>
  new Date(iso).toLocaleString("pt-PT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** `<input type="datetime-local">` gives a local wall-clock string; the API wants an instant. */
const toInstant = (localValue: string) => new Date(localValue).toISOString();

export default function TeamInterviewSlots({
  team,
  initialSlots,
}: {
  team: string;
  initialSlots: TeamSlot[];
}) {
  const [slots, setSlots] = useState(initialSlots);
  const [startsAt, setStartsAt] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch(
      `/api/workspace/interviews?department=${encodeURIComponent(team)}`
    );
    if (response.ok) setSlots(await response.json());
  };

  const publish = async () => {
    if (!startsAt) return;
    setBusy(true);
    try {
      const start = new Date(startsAt);
      const response = await fetch("/api/workspace/interviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departmentName: team,
          startsAt: toInstant(startsAt),
          endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
          location: location.trim() || undefined,
        }),
      });
      if (response.ok) {
        await refresh();
        setStartsAt("");
        setLocation("");
        toast.success("Horário publicado.", { closeButton: true });
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível publicar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (slotId: number) => {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/workspace/interviews?department=${encodeURIComponent(team)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotId }),
        }
      );
      if (response.ok) {
        await refresh();
        toast.success("Horário retirado.", { closeButton: true });
        return;
      }
      // SQL refuses a booked slot and a slot that is not yours; the message says which.
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível retirar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const free = slots.filter((slot) => !slot.bookedName).length;

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        Horários para entrevistas ({free} {free === 1 ? "livre" : "livres"})
      </h2>
      <p className={styles.cardMeta}>
        Os horários que publicares aqui aparecem ao candidato quando o convidares para entrevista.
        Ele escolhe, e o horário fica logo ocupado — ninguém precisa de trocar emails.
      </p>

      {slots.length === 0 ? (
        <p className={styles.empty}>Ainda não há horários publicados.</p>
      ) : (
        <ul className={styles.memberList}>
          {slots.map((slot) => (
            <li key={slot.id} className={styles.member}>
              <span className={styles.memberName}>
                {formatSlot(slot.startsAt)}
                <span className={styles.cardMeta}>
                  {" "}
                  · {slot.coordinatorName}
                  {slot.location ? ` · ${slot.location}` : ""}
                </span>
              </span>
              <span className={styles.memberRoles}>
                {slot.bookedName ? (
                  `Marcada — ${slot.bookedName}`
                ) : slot.held ? (
                  // Shown so a name appearing a minute later is not a surprise.
                  <span className={styles.cardMeta}>alguém está a escolher…</span>
                ) : (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    disabled={busy}
                    onClick={() => withdraw(slot.id)}>
                    Retirar
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.grantRow}>
        <input
          type="datetime-local"
          className={styles.grantInput}
          value={startsAt}
          disabled={busy}
          aria-label="Início do horário"
          onChange={(inputEvent) => setStartsAt(inputEvent.target.value)}
        />
        <select
          className={styles.inlineSelect}
          value={minutes}
          disabled={busy}
          aria-label="Duração"
          onChange={(inputEvent) => setMinutes(Number(inputEvent.target.value))}>
          <option value={20}>20 min</option>
          <option value={30}>30 min</option>
          <option value={45}>45 min</option>
          <option value={60}>1 hora</option>
        </select>
        <input
          type="text"
          className={styles.grantInput}
          value={location}
          disabled={busy}
          placeholder="Local (opcional)"
          aria-label="Local"
          onChange={(inputEvent) => setLocation(inputEvent.target.value)}
        />
        <button
          type="button"
          className={styles.grantBtn}
          disabled={busy || startsAt === ""}
          onClick={publish}>
          Publicar
        </button>
      </div>
    </section>
  );
}
