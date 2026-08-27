"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import styles from "@/styles/pages/Candidatura.module.css";

/**
 * The page an accepted candidate lands on (#224), and where they are given the team's WhatsApp
 * link (#225).
 *
 * **It does not make them a member.** It collects what a coordinator needs and hands over the
 * link; somebody adds them by hand. That is the decision from #134, and the reason is that this
 * page is reachable by a person with no account, holding a token — a self-service page reachable
 * by a non-member that creates authority is #193.
 *
 * The link appears only after the form is submitted, because submitting is what spends the token.
 * A candidate who never completes onboarding never sees it.
 */
export default function OnboardingForm({ token }: { token: string }) {
  const [state, setState] = useState<{ name: string; team: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState<{ team: string; inviteUrl: string | null } | null>(null);
  const [preferredName, setPreferredName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/recruitment/onboarding?t=${encodeURIComponent(token)}`);
      if (!response.ok) {
        setInvalid(true);
        return;
      }
      const body = await response.json();
      setState(body);
      // Pre-filled with their first name, which is right far more often than empty is.
      setPreferredName((current) => current || body.name.split(/\s+/)[0]);
    } catch {
      setInvalid(true);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/recruitment/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, preferredName, phone: phone.trim() || undefined }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setDone({ team: body.team, inviteUrl: body.inviteUrl });
        return;
      }
      toast.error(body.error || "Não foi possível submeter.", { closeButton: true });
    } catch {
      toast.error("Não foi possível submeter.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <section className={styles.done}>
        <h1 className={styles.title}>Link inválido</h1>
        <p>
          Este link já não é válido — pode ter expirado ou já ter sido usado. Se já preencheste,
          está tudo bem: alguém da equipa entra em contacto contigo. Caso contrário, responde ao
          email que recebeste.
        </p>
      </section>
    );
  }

  if (done) {
    return (
      <section className={styles.done}>
        <h1 className={styles.title}>Bem-vindo(a) ao NEIIST!</h1>
        <p>
          Já temos os teus dados. Alguém da equipa <strong>{done.team}</strong> vai adicionar-te
          oficialmente e criar o teu endereço <strong>@neiist.pt</strong>.
        </p>
        {done.inviteUrl ? (
          <p>
            Entretanto, entra no grupo da equipa:{" "}
            <a href={done.inviteUrl} target="_blank" rel="noopener noreferrer">
              grupo de {done.team} no WhatsApp
            </a>
            .
          </p>
        ) : (
          // A team that has not set a link must not block anyone joining.
          <p>A equipa vai enviar-te o link do grupo assim que possível.</p>
        )}
      </section>
    );
  }

  if (!state) return <p className={styles.intro}>A carregar…</p>;

  return (
    <section className={styles.done}>
      <h1 className={styles.title}>Boas notícias, {state.name.split(/\s+/)[0]}!</h1>
      <p className={styles.intro}>
        Entraste para a equipa <strong>{state.team}</strong>. Só faltam dois campos para te podermos
        adicionar.
      </p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="preferredName">
          Como queres ser tratado(a)?
        </label>
        <input
          id="preferredName"
          className={styles.input}
          value={preferredName}
          disabled={busy}
          maxLength={80}
          onChange={(inputEvent) => setPreferredName(inputEvent.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="phone">
          Telemóvel <span className={styles.hint}>(opcional — para o grupo da equipa)</span>
        </label>
        <input
          id="phone"
          className={styles.input}
          value={phone}
          disabled={busy}
          maxLength={20}
          inputMode="tel"
          onChange={(inputEvent) => setPhone(inputEvent.target.value)}
        />
      </div>

      <button
        type="button"
        className={styles.submit}
        disabled={busy || preferredName.trim() === ""}
        onClick={submit}>
        {busy ? "A enviar…" : "Concluir inscrição"}
      </button>
    </section>
  );
}
