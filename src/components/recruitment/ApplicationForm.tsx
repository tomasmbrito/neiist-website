"use client";

import { useState } from "react";
import { toast } from "sonner";
import styles from "@/styles/pages/Candidatura.module.css";

/**
 * The public application form (#134).
 *
 * Written for someone who has never used this site: no jargon, `tu` throughout (this is a student
 * association, not a bank), and the multi-team rule stated in the copy rather than left to be
 * discovered — someone who does not realise they can pick several will pick one.
 */
export default function ApplicationForm({ teams }: { teams: string[] }) {
  const [fullName, setFullName] = useState("");
  const [istid, setIstid] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [course, setCourse] = useState("");
  const [year, setYear] = useState("");
  const [motivation, setMotivation] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const toggleTeam = (team: string) =>
    setChosen((current) =>
      current.includes(team) ? current.filter((name) => name !== team) : [...current, team]
    );

  const submit = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (chosen.length === 0) {
      toast.error("Escolhe pelo menos uma equipa.", { closeButton: true });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/recruitment/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          istid: istid.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          course: course.trim() || undefined,
          year: year ? Number(year) : undefined,
          motivation: motivation.trim() || undefined,
          teams: chosen,
        }),
      });
      if (response.ok) {
        setDone(true);
        return;
      }
      const body = await response.json().catch(() => ({}));
      toast.error(body.error || "Não foi possível enviar a candidatura.", { closeButton: true });
    } catch {
      toast.error("Não foi possível enviar a candidatura.", { closeButton: true });
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className={styles.done}>
        <h2>Candidatura enviada!</h2>
        <p>
          Recebemos a tua candidatura a <strong>{chosen.join(", ")}</strong>. Vamos analisá-la e
          entrar em contacto contigo por email — se for necessária uma entrevista, avisamos-te com
          antecedência.
        </p>
        <p>
          Cada equipa decide separadamente, por isso podes ter respostas diferentes de equipas
          diferentes.
        </p>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="fullName">
          Nome completo
        </label>
        <input
          id="fullName"
          className={styles.input}
          value={fullName}
          onChange={(inputEvent) => setFullName(inputEvent.target.value)}
          disabled={busy}
          required
        />
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="istid">
            Número de aluno
          </label>
          <input
            id="istid"
            className={styles.input}
            value={istid}
            onChange={(inputEvent) => setIstid(inputEvent.target.value)}
            placeholder="ist1100000"
            disabled={busy}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className={styles.input}
            type="email"
            value={email}
            onChange={(inputEvent) => setEmail(inputEvent.target.value)}
            disabled={busy}
            required
          />
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="phone">
            Telemóvel <span className={styles.hint}>(opcional)</span>
          </label>
          <input
            id="phone"
            className={styles.input}
            value={phone}
            onChange={(inputEvent) => setPhone(inputEvent.target.value)}
            placeholder="+351 912 345 678"
            disabled={busy}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="course">
            Curso <span className={styles.hint}>(opcional)</span>
          </label>
          <input
            id="course"
            className={styles.input}
            value={course}
            onChange={(inputEvent) => setCourse(inputEvent.target.value)}
            placeholder="LEIC-A"
            disabled={busy}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="year">
            Ano <span className={styles.hint}>(opcional)</span>
          </label>
          <input
            id="year"
            className={styles.input}
            type="number"
            min={1}
            max={10}
            value={year}
            onChange={(inputEvent) => setYear(inputEvent.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Equipas</span>
        <span className={styles.hint}>
          Podes escolher mais do que uma. Cada equipa decide separadamente.
        </span>
        <div className={styles.teams}>
          {teams.map((team) => (
            <label key={team} className={styles.team}>
              <input
                type="checkbox"
                checked={chosen.includes(team)}
                onChange={() => toggleTeam(team)}
                disabled={busy}
              />
              {team}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="motivation">
          Porque queres entrar? <span className={styles.hint}>(opcional)</span>
        </label>
        <textarea
          id="motivation"
          className={styles.textarea}
          rows={5}
          value={motivation}
          onChange={(inputEvent) => setMotivation(inputEvent.target.value)}
          disabled={busy}
        />
      </div>

      <button type="submit" className={styles.submit} disabled={busy}>
        {busy ? "A enviar..." : "Enviar candidatura"}
      </button>
    </form>
  );
}
