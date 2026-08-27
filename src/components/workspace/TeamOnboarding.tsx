"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { PendingOnboarding } from "@/utils/db/onboardingQueries";
import styles from "@/styles/pages/Workspace.module.css";

/**
 * People who accepted and are waiting to be added (#224), and the team's WhatsApp link (#225).
 *
 * The button says **"Já adicionei"**, not "Adicionar", and the difference is deliberate: this
 * screen records that a human did the work in the members screen. It does not do it. #134 decided
 * that onboarding never creates a membership, because the page feeding this queue is reachable by
 * someone with no account (#193).
 */
export default function TeamOnboarding({
  team,
  initialPending,
  initialLink,
}: {
  team: string;
  initialPending: PendingOnboarding[];
  initialLink: string | null;
}) {
  const [pending, setPending] = useState(initialPending);
  const [link, setLink] = useState(initialLink ?? "");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await fetch(
      `/api/workspace/onboarding?department=${encodeURIComponent(team)}`
    );
    if (response.ok) {
      const body = await response.json();
      setPending(body.pending);
      setLink(body.link?.whatsappUrl ?? "");
    }
  };

  const saveLink = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentName: team, whatsappUrl: link.trim() || null }),
      });
      if (response.ok) {
        toast.success("Link guardado.", { closeButton: true });
        return;
      }
      // SQL rejects anything that is not a WhatsApp invite; the message says so verbatim.
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível guardar.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  const markAdded = async (applicationId: number) => {
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark", applicationId, departmentName: team }),
      });
      if (response.ok) {
        await refresh();
        toast.success("Tirado da lista.", { closeButton: true });
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Por adicionar ({pending.length})</h2>
      <p className={styles.cardMeta}>
        Quem já aceitou o convite e preencheu os dados. Adiciona-os em Gestão de Membros e depois
        marca aqui — esta lista não cria membros, só regista que já foram criados.
      </p>

      {pending.length === 0 ? (
        <p className={styles.empty}>Ninguém à espera.</p>
      ) : (
        <ul className={styles.memberList}>
          {pending.map((person) => (
            <li key={person.applicationId} className={styles.member}>
              <span className={styles.memberName}>
                {person.preferredName}
                <span className={styles.cardMeta}>
                  {" "}
                  · {person.fullName} · {person.istid} · {person.email}
                  {person.phone ? ` · ${person.phone}` : ""}
                </span>
              </span>
              <span className={styles.memberRoles}>
                {/* #213's rule, previewed rather than re-derived. Nothing is reserved until a
                    coordinator actually creates the member. */}
                <span className={styles.cardMeta}>{person.suggestedEmail}@neiist.pt</span>
                <button
                  type="button"
                  className={styles.grantBtn}
                  disabled={busy}
                  onClick={() => markAdded(person.applicationId)}>
                  Já adicionei
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className={styles.sectionTitle} style={{ marginTop: "1.5rem" }}>
        Grupo de WhatsApp da equipa
      </h2>
      <p className={styles.cardMeta}>
        Enviado a quem entra na equipa, no fim da inscrição. Qualquer pessoa com o link entra no
        grupo, por isso troca-o quando precisares.
      </p>
      <div className={styles.grantRow}>
        <input
          type="url"
          className={styles.grantInput}
          value={link}
          disabled={busy}
          placeholder="https://chat.whatsapp.com/…"
          aria-label="Link do grupo de WhatsApp"
          onChange={(inputEvent) => setLink(inputEvent.target.value)}
        />
        <button type="button" className={styles.grantBtn} disabled={busy} onClick={saveLink}>
          Guardar
        </button>
      </div>
    </section>
  );
}
