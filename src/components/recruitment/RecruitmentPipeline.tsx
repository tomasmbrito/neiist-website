"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import styles from "@/styles/components/recruitment/RecruitmentPipeline.module.css";
import type { Dictionary } from "@/i18n/dictionaries";
import type {
  Application,
  ApplicationReviewStatus,
  DecisionSide,
  RecruitmentEdition,
  TeamDecision,
} from "@/types/recruitment";

interface RecruitmentPipelineProps {
  edition: RecruitmentEdition | null;
  initialApplications: Application[];
  teamNames: string[];
  isAdmin: boolean;
  coordinatedTeams: string[];
  isBoardMember: boolean;
  dict: Dictionary["recruitment_management"];
  recruitmentDict: Dictionary["recruitment"];
  locale: string;
}

const DECISION_BADGE_CLASS: Record<TeamDecision, string> = {
  pending: "decisionPending",
  accepted: "decisionAccepted",
  rejected: "decisionRejected",
};

const STATUS_BADGE_CLASS: Record<ApplicationReviewStatus, string> = {
  new: "statusNew",
  contacted: "statusContacted",
  archived: "statusArchived",
};

export default function RecruitmentPipeline({
  edition,
  initialApplications,
  teamNames,
  isAdmin,
  coordinatedTeams,
  isBoardMember,
  dict,
  recruitmentDict,
  locale,
}: RecruitmentPipelineProps) {
  const [applications, setApplications] = useState(initialApplications);
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<Application | null>(null);
  const [reviewStatus, setReviewStatus] = useState<ApplicationReviewStatus>("new");
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [decidingKey, setDecidingKey] = useState<string | null>(null);

  const canDecideCoordinator = (teamName: string) => isAdmin || coordinatedTeams.includes(teamName);

  // Editable until BOTH sides have voted (locked once final), not "until my own side has
  // voted" — otherwise a coordinator could never correct a mis-click while the board side is
  // still pending, contradicting the whole point of the editable-until-final rule.
  const isTeamLocked = (team: { coordinatorDecision: TeamDecision; boardDecision: TeamDecision }) =>
    team.coordinatorDecision !== "pending" && team.boardDecision !== "pending";

  const [newEditionName, setNewEditionName] = useState("");
  const [newOpensAt, setNewOpensAt] = useState("");
  const [newClosesAt, setNewClosesAt] = useState("");
  const [creatingEdition, setCreatingEdition] = useState(false);

  const statusLabels: Record<ApplicationReviewStatus, string> = {
    new: dict.status_new,
    contacted: dict.status_contacted,
    archived: dict.status_archived,
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return applications.filter((app) => {
      if (q && !app.name.toLowerCase().includes(q) && !app.email.toLowerCase().includes(q))
        return false;
      if (teamFilter && !app.teams.some((t) => t.name === teamFilter)) return false;
      if (statusFilter && app.reviewStatus !== statusFilter) return false;
      return true;
    });
  }, [applications, search, teamFilter, statusFilter]);

  const openDetail = (app: Application) => {
    setSelected(app);
    setReviewStatus(app.reviewStatus);
    setReviewNote(app.reviewNote ?? "");
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/recruitment/applications/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_save);

      setApplications((prev) =>
        prev.map((app) =>
          app.id === selected.id ? { ...app, reviewStatus, reviewNote: reviewNote || null } : app
        )
      );
      setSelected(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_save, { closeButton: true });
    } finally {
      setSaving(false);
    }
  };

  const handleDecision = async (
    departmentName: string,
    side: DecisionSide,
    decision: "accepted" | "rejected"
  ) => {
    if (!selected) return;
    const key = `${side}:${departmentName}`;
    setDecidingKey(key);
    try {
      const res = await fetch(`/api/recruitment/applications/${selected.id}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentName, side, decision }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_decision);

      const updateTeams = (app: Application) => ({
        ...app,
        teams: app.teams.map((t) =>
          t.name === departmentName
            ? {
                ...t,
                coordinatorDecision: data.coordinatorDecision,
                boardDecision: data.boardDecision,
                outcome: data.outcome,
              }
            : t
        ),
      });

      setApplications((prev) =>
        prev.map((app) => (app.id === selected.id ? updateTeams(app) : app))
      );
      setSelected((prev) => (prev ? updateTeams(prev) : prev));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_decision, { closeButton: true });
    } finally {
      setDecidingKey(null);
    }
  };

  const handleCreateEdition = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingEdition(true);
    try {
      const res = await fetch("/api/recruitment/editions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newEditionName,
          opensAt: new Date(newOpensAt).toISOString(),
          closesAt: new Date(newClosesAt).toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_create_edition);
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_create_edition, {
        closeButton: true,
      });
    } finally {
      setCreatingEdition(false);
    }
  };

  const formatDate = (value: Date | string) =>
    new Date(value).toLocaleDateString(locale === "en" ? "en-GB" : "pt-PT");

  if (!edition) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>{dict.title}</h1>
        <div className={styles.emptyState}>{dict.no_editions}</div>
        {isAdmin && (
          <NewEditionForm
            dict={dict}
            name={newEditionName}
            setName={setNewEditionName}
            opensAt={newOpensAt}
            setOpensAt={setNewOpensAt}
            closesAt={newClosesAt}
            setClosesAt={setNewClosesAt}
            creating={creatingEdition}
            onSubmit={handleCreateEdition}
          />
        )}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>{dict.title}</h1>
      <p className={styles.editionName}>{edition.name}</p>

      <div className={styles.controlsRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder={dict.search_placeholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className={styles.filterSelect}
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}>
          <option value="">{dict.filter_team_all}</option>
          {teamNames.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className={styles.filterSelect}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{dict.filter_status_all}</option>
          <option value="new">{dict.status_new}</option>
          <option value="contacted">{dict.status_contacted}</option>
          <option value="archived">{dict.status_archived}</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyState}>{dict.empty}</div>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{dict.col_name}</th>
                <th>{dict.col_teams}</th>
                <th>{dict.col_campus}</th>
                <th>{dict.col_course}</th>
                <th>{dict.col_year}</th>
                <th>{dict.col_status}</th>
                <th>{dict.col_submitted}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((app) => (
                <tr key={app.id} className={styles.row} onClick={() => openDetail(app)}>
                  <td>{app.name}</td>
                  <td>{app.teams.map((t) => t.name).join(", ")}</td>
                  <td>{app.campus}</td>
                  <td>{app.course}</td>
                  <td>{app.curricularYear}</td>
                  <td>
                    <span
                      className={`${styles.statusBadge} ${styles[STATUS_BADGE_CLASS[app.reviewStatus]]}`}>
                      {statusLabels[app.reviewStatus]}
                    </span>
                  </td>
                  <td>{formatDate(app.submittedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && (
        <>
          <div className={styles.divider} />
          <NewEditionForm
            dict={dict}
            name={newEditionName}
            setName={setNewEditionName}
            opensAt={newOpensAt}
            setOpensAt={setNewOpensAt}
            closesAt={newClosesAt}
            setClosesAt={setNewClosesAt}
            creating={creatingEdition}
            onSubmit={handleCreateEdition}
          />
        </>
      )}

      {selected && (
        <div className={styles.overlay} onClick={() => setSelected(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>{selected.name}</h2>
              <button className={styles.closeButton} onClick={() => setSelected(null)}>
                ×
              </button>
            </div>

            <dl className={styles.detailGrid}>
              <div className={styles.detailField}>
                <dt>{recruitmentDict.istid_label}</dt>
                <dd>{selected.applicantIstid}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{recruitmentDict.email_label}</dt>
                <dd>{selected.email}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{recruitmentDict.phone_label}</dt>
                <dd>{selected.phone}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{recruitmentDict.campus_label}</dt>
                <dd>{selected.campus}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{recruitmentDict.course_label}</dt>
                <dd>{selected.course}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{recruitmentDict.year_label}</dt>
                <dd>{selected.curricularYear}</dd>
              </div>
              {selected.priorExperience && (
                <div className={`${styles.detailField} ${styles.detailFull}`}>
                  <dt>{recruitmentDict.experience_label}</dt>
                  <dd>{selected.priorExperience}</dd>
                </div>
              )}
              <div className={`${styles.detailField} ${styles.detailFull}`}>
                <dt>{recruitmentDict.motivation_label}</dt>
                <dd>{selected.motivation}</dd>
              </div>
              <div className={`${styles.detailField} ${styles.detailFull}`}>
                <dt>{recruitmentDict.fun_fact_label}</dt>
                <dd>{selected.funFact}</dd>
              </div>
            </dl>

            <div className={styles.divider} />

            <h3 className={styles.createEditionTitle}>{dict.decisions_title}</h3>
            {selected.teams.map((team) => (
              <div key={team.name} className={styles.teamDecisionRow}>
                <span className={styles.teamDecisionName}>{team.name}</span>

                <span className={styles.teamDecisionSide}>
                  {dict.decision_coordinator_label}:
                  <span
                    className={`${styles.statusBadge} ${styles[DECISION_BADGE_CLASS[team.coordinatorDecision]]}`}>
                    {dict[`decision_${team.coordinatorDecision}`]}
                  </span>
                  {!isTeamLocked(team) && canDecideCoordinator(team.name) && (
                    <span className={styles.decisionButtons}>
                      <button
                        className={styles.decisionButton}
                        disabled={decidingKey === `coordinator:${team.name}`}
                        onClick={() => handleDecision(team.name, "coordinator", "accepted")}>
                        {dict.decision_accept_button}
                      </button>
                      <button
                        className={styles.decisionButton}
                        disabled={decidingKey === `coordinator:${team.name}`}
                        onClick={() => handleDecision(team.name, "coordinator", "rejected")}>
                        {dict.decision_reject_button}
                      </button>
                    </span>
                  )}
                </span>

                <span className={styles.teamDecisionSide}>
                  {dict.decision_board_label}:
                  <span
                    className={`${styles.statusBadge} ${styles[DECISION_BADGE_CLASS[team.boardDecision]]}`}>
                    {dict[`decision_${team.boardDecision}`]}
                  </span>
                  {!isTeamLocked(team) && isBoardMember && (
                    <span className={styles.decisionButtons}>
                      <button
                        className={styles.decisionButton}
                        disabled={decidingKey === `board:${team.name}`}
                        onClick={() => handleDecision(team.name, "board", "accepted")}>
                        {dict.decision_accept_button}
                      </button>
                      <button
                        className={styles.decisionButton}
                        disabled={decidingKey === `board:${team.name}`}
                        onClick={() => handleDecision(team.name, "board", "rejected")}>
                        {dict.decision_reject_button}
                      </button>
                    </span>
                  )}
                </span>

                <span className={styles.teamDecisionSide}>
                  {dict.decision_outcome_label}:
                  <span
                    className={`${styles.statusBadge} ${styles[DECISION_BADGE_CLASS[team.outcome]]}`}>
                    {dict[`decision_${team.outcome}`]}
                  </span>
                </span>
              </div>
            ))}

            <div className={styles.divider} />

            <div className={styles.formGroup}>
              <label>{dict.review_status_label}</label>
              <select
                className={styles.input}
                value={reviewStatus}
                onChange={(e) => setReviewStatus(e.target.value as ApplicationReviewStatus)}>
                <option value="new">{dict.status_new}</option>
                <option value="contacted">{dict.status_contacted}</option>
                <option value="archived">{dict.status_archived}</option>
              </select>
            </div>

            <div className={styles.formGroup}>
              <label>{dict.review_note_label}</label>
              <textarea
                className={styles.input}
                rows={3}
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder={dict.review_note_placeholder}
              />
            </div>

            <div className={styles.modalActions}>
              <button className={styles.submitButton} onClick={handleSave} disabled={saving}>
                {saving ? dict.saving : dict.save_button}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewEditionForm({
  dict,
  name,
  setName,
  opensAt,
  setOpensAt,
  closesAt,
  setClosesAt,
  creating,
  onSubmit,
}: {
  dict: Dictionary["recruitment_management"];
  name: string;
  setName: (_v: string) => void;
  opensAt: string;
  setOpensAt: (_v: string) => void;
  closesAt: string;
  setClosesAt: (_v: string) => void;
  creating: boolean;
  onSubmit: (_e: React.FormEvent) => void;
}) {
  return (
    <div className={styles.createEditionCard}>
      <h2 className={styles.createEditionTitle}>{dict.create_edition_title}</h2>
      <form onSubmit={onSubmit}>
        <div className={styles.formGroup}>
          <label>{dict.edition_name_label}</label>
          <input
            type="text"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={dict.edition_name_placeholder}
            required
          />
        </div>
        <div className={styles.formGroup}>
          <label>{dict.opens_at_label}</label>
          <input
            type="datetime-local"
            className={styles.input}
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
            required
          />
        </div>
        <div className={styles.formGroup}>
          <label>{dict.closes_at_label}</label>
          <input
            type="datetime-local"
            className={styles.input}
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            required
          />
        </div>
        <button type="submit" className={styles.submitButton} disabled={creating}>
          {creating ? dict.creating_edition : dict.create_edition_button}
        </button>
      </form>
    </div>
  );
}
