"use client";

import { useState } from "react";
import { toast } from "sonner";
import styles from "@/styles/components/recruitment/ApplicationForm.module.css";
import type { Dictionary } from "@/i18n/dictionaries";
import type { ApplicationCampus, MyApplicationFull } from "@/types/recruitment";

interface Team {
  name: string;
  description: string;
}

interface ApplicationEditFormProps {
  applicationId: number;
  application: MyApplicationFull;
  teams: Team[];
  dict: Dictionary["recruitment"];
  onSaved: () => void;
  onCancel: () => void;
}

const CAMPUSES: ApplicationCampus[] = ["Alameda", "Taguspark"];
const YEARS = [1, 2, 3, 4, 5] as const;

export default function ApplicationEditForm({
  applicationId,
  application,
  teams,
  dict,
  onSaved,
  onCancel,
}: ApplicationEditFormProps) {
  const [selectedTeams, setSelectedTeams] = useState<string[]>(
    application.teams.map((t) => t.name)
  );
  const [campus, setCampus] = useState<ApplicationCampus>(application.campus);
  const [course, setCourse] = useState(application.course);
  const [year, setYear] = useState<number>(application.curricularYear);
  const [phone, setPhone] = useState(application.phone);
  const [priorExperience, setPriorExperience] = useState(application.priorExperience ?? "");
  const [motivation, setMotivation] = useState(application.motivation);
  const [funFact, setFunFact] = useState(application.funFact);
  const [wantsWaitlist, setWantsWaitlist] = useState(application.wantsWaitlist);
  const [saving, setSaving] = useState(false);

  const toggleTeam = (name: string) => {
    setSelectedTeams((prev) => {
      if (prev.includes(name)) return prev.filter((t) => t !== name);
      if (prev.length >= 3) {
        toast.error(dict.error_too_many_teams, { closeButton: true });
        return prev;
      }
      return [...prev, name];
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (selectedTeams.length === 0) {
      toast.error(dict.error_no_teams, { closeButton: true });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/recruitment/applications/${applicationId}/edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departments: selectedTeams,
          campus,
          course,
          curricularYear: year,
          phone,
          priorExperience: priorExperience || undefined,
          motivation,
          funFact,
          wantsWaitlist,
        }),
      });

      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data?.error || dict.error_update);

      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_update, { closeButton: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{dict.section_teams}</h2>
        <p className={styles.hint}>{dict.teams_hint}</p>
        {selectedTeams.length >= 3 && <p className={styles.hint}>{dict.teams_max_hint}</p>}

        <div className={styles.teamsGrid}>
          {teams.map((team) => {
            const checked = selectedTeams.includes(team.name);
            return (
              <label
                key={team.name}
                className={`${styles.teamCard} ${checked ? styles.teamCardSelected : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleTeam(team.name)}
                  className={styles.teamCheckbox}
                />
                <span className={styles.teamName}>{team.name}</span>
                <span className={styles.teamDescription}>{team.description}</span>
              </label>
            );
          })}
        </div>
      </section>

      <div className={styles.divider} />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{dict.section_about_you}</h2>

        <div className={styles.formGrid}>
          <div className={styles.formGroup}>
            <label>{dict.name_label}</label>
            <input type="text" value={application.name} disabled className={styles.input} />
          </div>
          <div className={styles.formGroup}>
            <label>{dict.email_label}</label>
            <input type="text" value={application.email} disabled className={styles.input} />
          </div>
          <div className={styles.formGroup}>
            <label htmlFor="edit-phone">{dict.phone_label}</label>
            <input
              id="edit-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={dict.phone_placeholder}
              className={styles.input}
              required
            />
          </div>
          <div className={styles.formGroup}>
            <label htmlFor="edit-course">{dict.course_label}</label>
            <input
              id="edit-course"
              type="text"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
              placeholder={dict.course_placeholder}
              className={styles.input}
              required
            />
          </div>
          <div className={styles.formGroup}>
            <label htmlFor="edit-year">{dict.year_label}</label>
            <select
              id="edit-year"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className={styles.input}
              required>
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {dict[`year_${y}` as keyof typeof dict]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.radioGroup}>
          {CAMPUSES.map((c) => (
            <label key={c} className={styles.radioOption}>
              <input
                type="radio"
                name="edit-campus"
                checked={campus === c}
                onChange={() => setCampus(c)}
                className={styles.radioInput}
                required
              />
              <span className={styles.radioLabel}>{c}</span>
            </label>
          ))}
        </div>
      </section>

      <div className={styles.divider} />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{dict.section_more}</h2>

        <div className={styles.formGroup}>
          <label htmlFor="edit-experience">{dict.experience_label}</label>
          <textarea
            id="edit-experience"
            className={styles.textarea}
            value={priorExperience}
            onChange={(e) => setPriorExperience(e.target.value)}
            placeholder={dict.experience_placeholder}
            rows={2}
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="edit-motivation">{dict.motivation_label}</label>
          <textarea
            id="edit-motivation"
            className={styles.textarea}
            value={motivation}
            onChange={(e) => setMotivation(e.target.value)}
            rows={3}
            required
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="edit-funFact">{dict.fun_fact_label}</label>
          <textarea
            id="edit-funFact"
            className={styles.textarea}
            value={funFact}
            onChange={(e) => setFunFact(e.target.value)}
            rows={3}
            required
          />
        </div>

        <div className={styles.formGroup}>
          <p className={styles.hint}>{dict.waitlist_hint}</p>
          <label className={styles.radioOption}>
            <input
              type="checkbox"
              checked={wantsWaitlist}
              onChange={(e) => setWantsWaitlist(e.target.checked)}
              className={styles.radioInput}
            />
            <span className={styles.radioLabel}>{dict.waitlist_label}</span>
          </label>
        </div>
      </section>

      <div className={styles.buttonRow}>
        <button type="submit" className={styles.submitButton} disabled={saving}>
          {saving ? dict.saving_changes : dict.save_changes_button}
        </button>
        <button
          type="button"
          className={`${styles.submitButton} ${styles.cancelButton}`}
          onClick={onCancel}
          disabled={saving}>
          {dict.cancel_edit_button}
        </button>
      </div>
    </form>
  );
}
