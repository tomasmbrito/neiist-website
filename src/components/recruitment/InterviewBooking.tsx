"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { FreeSlot } from "@/utils/db/interviewQueries";
import styles from "@/styles/pages/Candidatura.module.css";

/**
 * The candidate's booking page (#218).
 *
 * Two things shape it:
 *
 *  - **Losing a slot is normal, not an error.** Two people can want 20:00. When the claim comes
 *    back 409 the page says so plainly and re-fetches, rather than showing a failure that implies
 *    the candidate did something wrong.
 *  - **The token is the whole authorization**, so it is never used to *name* anything. The team,
 *    the candidate and the slots all come from the server's reading of the token.
 */
type Booking = {
  slotId: number;
  coordinatorName: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
};

const formatSlot = (iso: string) =>
  new Date(iso).toLocaleString("pt-PT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function InterviewBooking({ token }: { token: string }) {
  const [state, setState] = useState<{
    name: string;
    team: string;
    slots: FreeSlot[];
    booking: Booking | null;
  } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/recruitment/interview?t=${encodeURIComponent(token)}`);
      if (!response.ok) {
        setInvalid(true);
        return;
      }
      setState(await response.json());
    } catch {
      setInvalid(true);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const book = async (slotId: number) => {
    setBusy(true);
    try {
      const response = await fetch("/api/recruitment/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, slotId }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok) {
        await load();
        toast.success(
          body.emailed
            ? "Entrevista marcada! Enviámos-te a confirmação por email."
            : "Entrevista marcada! (O email de confirmação falhou — o horário está guardado.)",
          { closeButton: true }
        );
        return;
      }
      // 409 means somebody else was faster. Re-fetch so the list shows what is actually left.
      if (response.status === 409) await load();
      toast.error(body.error || "Não foi possível marcar.", { closeButton: true });
    } catch {
      toast.error("Não foi possível marcar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (slotId: number) => {
    setBusy(true);
    try {
      const response = await fetch("/api/recruitment/interview", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, slotId }),
      });
      if (response.ok) {
        await load();
        toast.success("Entrevista desmarcada. Podes escolher outro horário.", {
          closeButton: true,
        });
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível desmarcar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <section className={styles.done}>
        <h1 className={styles.title}>Link inválido</h1>
        <p>
          Este link já não é válido. Pode ter expirado, já ter sido usado, ou a tua candidatura já
          ter sido decidida. Se achas que é engano, responde ao email que recebeste.
        </p>
      </section>
    );
  }

  if (!state) return <p className={styles.intro}>A carregar…</p>;

  if (state.booking) {
    return (
      <section className={styles.done}>
        <h1 className={styles.title}>Entrevista marcada</h1>
        <p>
          {state.name.split(/\s+/)[0]}, a tua entrevista para a equipa <strong>{state.team}</strong>{" "}
          é <strong>{formatSlot(state.booking.startsAt)}</strong>
          {state.booking.location ? `, em ${state.booking.location}` : ""}, com{" "}
          {state.booking.coordinatorName}.
        </p>
        <button
          type="button"
          className={styles.submit}
          disabled={busy}
          onClick={() => cancel(state.booking!.slotId)}>
          Desmarcar e escolher outro horário
        </button>
      </section>
    );
  }

  return (
    <section className={styles.done}>
      <h1 className={styles.title}>Marcar entrevista</h1>
      <p>
        Olá, {state.name.split(/\s+/)[0]}! Escolhe um horário para a tua entrevista com a equipa{" "}
        <strong>{state.team}</strong>. Os horários são por ordem de chegada.
      </p>

      {state.slots.length === 0 ? (
        <p className={styles.empty}>
          Neste momento não há horários disponíveis. Vamos abrir mais — volta a este link daqui a
          pouco, ou responde ao email que recebeste.
        </p>
      ) : (
        <ul className={styles.slotList}>
          {state.slots.map((slot) => (
            <li key={slot.id} className={styles.slot}>
              <span>
                <strong>{formatSlot(slot.startsAt)}</strong>
                <span className={styles.slotMeta}>
                  {" "}
                  · {slot.coordinatorName}
                  {slot.location ? ` · ${slot.location}` : ""}
                </span>
              </span>
              <button
                type="button"
                className={styles.submit}
                disabled={busy}
                onClick={() => book(slot.id)}>
                Escolher
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
