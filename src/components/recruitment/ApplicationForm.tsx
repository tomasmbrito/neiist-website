"use client";

import { useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import styles from "@/styles/components/recruitment/ApplicationForm.module.css";
import banner from "@/assets/recruitment/banner.png";
import type { Dictionary } from "@/i18n/dictionaries";
import type { User } from "@/types/user";
import type { ApplicationCampus } from "@/types/recruitment";

interface Team {
  name: string;
  description: string;
}

interface ApplicationFormProps {
  user: User;
  teams: Team[];
  editionId: number;
  dict: Dictionary["recruitment"];
}

const CAMPUSES: ApplicationCampus[] = ["Alameda", "Taguspark"];
const YEARS = [1, 2, 3, 4, 5] as const;

export default function ApplicationForm({ user, teams, dict }: ApplicationFormProps) {
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);
  const [campus, setCampus] = useState<ApplicationCampus | "">("");
  const [course, setCourse] = useState(user.courses?.[0] ?? "");
  const [year, setYear] = useState<number | "">("");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [priorExperience, setPriorExperience] = useState("");
  const [motivation, setMotivation] = useState("");
  const [funFact, setFunFact] = useState("");
  const [wantsWaitlist, setWantsWaitlist] = useState(true);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

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
    if (!campus) {
      toast.error(dict.error_no_teams, { closeButton: true });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/recruitment/applications", {
        method: "POST",
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

      const data = (await res.json()) as { id?: number; error?: string };
      if (!res.ok) throw new Error(data?.error || dict.error_submit);

      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_submit, { closeButton: true });
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className={styles.pageContainer}>
        <div className={styles.successCard}>
          <h1 className={styles.successTitle}>{dict.success_title}</h1>
          <p className={styles.successDescription}>{dict.success_description}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pageContainer}>
      <div className={styles.banner}>
        <Image src={banner} alt={dict.title} className={styles.bannerImage} priority />
      </div>

      <form className={styles.container} onSubmit={handleSubmit}>
        <h1 className={styles.title}>{dict.title}</h1>
        <p className={styles.subtitle}>{dict.subtitle}</p>

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
              <input type="text" value={user.name} disabled className={styles.input} />
            </div>
            <div className={styles.formGroup}>
              <label>{dict.istid_label}</label>
              <input type="text" value={user.istid} disabled className={styles.input} />
            </div>
            <div className={styles.formGroup}>
              <label>{dict.email_label}</label>
              <input type="text" value={user.email} disabled className={styles.input} />
            </div>
            <div className={styles.formGroup}>
              <label htmlFor="phone">{dict.phone_label}</label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={dict.phone_placeholder}
                className={styles.input}
                required
              />
            </div>
            <div className={styles.formGroup}>
              <label htmlFor="course">{dict.course_label}</label>
              <input
                id="course"
                type="text"
                value={course}
                onChange={(e) => setCourse(e.target.value)}
                placeholder={dict.course_placeholder}
                className={styles.input}
                required
              />
            </div>
            <div className={styles.formGroup}>
              <label htmlFor="year">{dict.year_label}</label>
              <select
                id="year"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className={styles.input}
                required>
                <option value="" disabled>
                  {dict.year_label}
                </option>
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
                  name="campus"
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
            <label htmlFor="experience">{dict.experience_label}</label>
            <textarea
              id="experience"
              className={styles.textarea}
              value={priorExperience}
              onChange={(e) => setPriorExperience(e.target.value)}
              placeholder={dict.experience_placeholder}
              rows={2}
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="motivation">{dict.motivation_label}</label>
            <textarea
              id="motivation"
              className={styles.textarea}
              value={motivation}
              onChange={(e) => setMotivation(e.target.value)}
              rows={3}
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="funFact">{dict.fun_fact_label}</label>
            <textarea
              id="funFact"
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

        <button type="submit" className={styles.submitButton} disabled={loading}>
          {loading ? dict.submitting : dict.submit}
        </button>
      </form>
    </div>
  );
}
