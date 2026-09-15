"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FaCheckCircle } from "react-icons/fa";
import styles from "@/styles/components/recruitment/ApplicationReview.module.css";
import ApplicationEditForm from "@/components/recruitment/ApplicationEditForm";
import type { Dictionary } from "@/i18n/dictionaries";
import type { BookableInterviewSlot, MyApplicationFull, TeamDecision } from "@/types/recruitment";

interface Team {
  name: string;
  description: string;
}

interface ApplicationReviewClientProps {
  applicationId: number;
  application: MyApplicationFull;
  slotsByTeam: Record<string, BookableInterviewSlot[]>;
  teams: Team[];
  dict: Dictionary["recruitment"];
  locale: string;
}

const DECISION_BADGE_CLASS: Record<
  TeamDecision,
  "badgePending" | "badgeAccepted" | "badgeRejected"
> = {
  pending: "badgePending",
  accepted: "badgeAccepted",
  rejected: "badgeRejected",
};

export default function ApplicationReviewClient({
  applicationId,
  application,
  slotsByTeam,
  teams,
  dict,
  locale,
}: ApplicationReviewClientProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [bookingSlotId, setBookingSlotId] = useState<number | null>(null);
  const [cancellingSlotId, setCancellingSlotId] = useState<number | null>(null);

  const formatDateTime = (value: Date | string) =>
    new Date(value).toLocaleString(locale === "en" ? "en-GB" : "pt-PT", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleBook = async (slotId: number) => {
    setBookingSlotId(slotId);
    try {
      const res = await fetch(`/api/recruitment/applications/${applicationId}/interview-slots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_book_interview);
      toast.success(
        dict.interview_booked_confirmation.replace("{date}", formatDateTime(data.startsAt))
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_book_interview, {
        closeButton: true,
      });
    } finally {
      setBookingSlotId(null);
    }
  };

  const handleCancelInterview = async (slotId: number) => {
    setCancellingSlotId(slotId);
    try {
      const res = await fetch(`/api/recruitment/interview-slots/${slotId}/booking`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_cancel_interview);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_cancel_interview, {
        closeButton: true,
      });
    } finally {
      setCancellingSlotId(null);
    }
  };

  const handleSaved = () => {
    setEditing(false);
    router.refresh();
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <FaCheckCircle className={styles.icon} />
          <h1 className={styles.title}>{dict.review_title}</h1>
        </div>
        <p className={styles.description}>{dict.review_description}</p>

        {application.isLocked && (
          <div className={styles.lockedNotice}>{dict.application_locked_notice}</div>
        )}

        {!editing && !application.isLocked && (
          <div className={styles.actionsRow}>
            <button className={styles.editButton} onClick={() => setEditing(true)}>
              {dict.edit_button}
            </button>
          </div>
        )}

        {editing ? (
          <ApplicationEditForm
            applicationId={applicationId}
            application={application}
            teams={teams}
            dict={dict}
            onSaved={handleSaved}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className={styles.detailGrid}>
              <div className={styles.detailField}>
                <dt>{dict.istid_label}</dt>
                <dd>{application.applicantIstid}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{dict.email_label}</dt>
                <dd>{application.email}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{dict.phone_label}</dt>
                <dd>{application.phone}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{dict.campus_label}</dt>
                <dd>{application.campus}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{dict.course_label}</dt>
                <dd>{application.course}</dd>
              </div>
              <div className={styles.detailField}>
                <dt>{dict.year_label}</dt>
                <dd>{application.curricularYear}</dd>
              </div>
              {application.priorExperience && (
                <div className={`${styles.detailField} ${styles.detailFull}`}>
                  <dt>{dict.experience_label}</dt>
                  <dd>{application.priorExperience}</dd>
                </div>
              )}
              <div className={`${styles.detailField} ${styles.detailFull}`}>
                <dt>{dict.motivation_label}</dt>
                <dd>{application.motivation}</dd>
              </div>
              <div className={`${styles.detailField} ${styles.detailFull}`}>
                <dt>{dict.fun_fact_label}</dt>
                <dd>{application.funFact}</dd>
              </div>
            </dl>

            <div className={styles.divider} />

            {application.teams.map((team) => {
              const bookable = slotsByTeam[team.name] ?? [];
              const interview = team.interview;
              const interviewStepClass =
                interview?.status === "confirmed"
                  ? styles.stepDone
                  : interview
                    ? styles.stepActive
                    : "";
              const resultStepClass =
                team.outcome === "accepted"
                  ? styles.stepDone
                  : team.outcome === "rejected"
                    ? styles.stepRejected
                    : "";

              return (
                <div key={team.name} className={styles.teamSection}>
                  <h2 className={styles.teamName}>{team.name}</h2>

                  <div className={styles.stepper}>
                    <span className={`${styles.step} ${styles.stepDone}`}>
                      <span className={styles.stepDot} />
                      {dict.step_submitted}
                    </span>
                    <span className={styles.stepConnector} />
                    <span className={`${styles.step} ${interviewStepClass}`}>
                      <span className={styles.stepDot} />
                      {dict.step_interview}
                    </span>
                    <span className={styles.stepConnector} />
                    <span className={`${styles.step} ${resultStepClass}`}>
                      <span className={styles.stepDot} />
                      {dict.step_result}
                    </span>
                  </div>

                  <div className={styles.decisionRow}>
                    <span>
                      {dict.decision_coordinator_label}:
                      <span
                        className={`${styles.badge} ${styles[DECISION_BADGE_CLASS[team.coordinatorDecision]]}`}>
                        {dict[`decision_${team.coordinatorDecision}`]}
                      </span>
                    </span>
                    <span>
                      {dict.decision_board_label}:
                      <span
                        className={`${styles.badge} ${styles[DECISION_BADGE_CLASS[team.boardDecision]]}`}>
                        {dict[`decision_${team.boardDecision}`]}
                      </span>
                    </span>
                    <span>
                      {dict.decision_outcome_label}:
                      <span
                        className={`${styles.badge} ${styles[DECISION_BADGE_CLASS[team.outcome]]}`}>
                        {dict[`decision_${team.outcome}`]}
                      </span>
                    </span>
                  </div>

                  {interview ? (
                    <div className={styles.interviewBox}>
                      <span>
                        {interview.status === "confirmed"
                          ? dict.interview_confirmed_for.replace(
                              "{date}",
                              formatDateTime(interview.startsAt)
                            )
                          : `${dict.interview_requested_for.replace("{date}", formatDateTime(interview.startsAt))} — ${dict.interview_request_pending}`}
                      </span>
                      <button
                        className={styles.smallButton}
                        disabled={cancellingSlotId === interview.slotId}
                        onClick={() => handleCancelInterview(interview.slotId)}>
                        {dict.interview_cancel_button}
                      </button>
                    </div>
                  ) : bookable.length > 0 ? (
                    <div>
                      {bookable.map((slot) => (
                        <div key={slot.id} className={styles.interviewSlotRow}>
                          <span>{formatDateTime(slot.startsAt)}</span>
                          <button
                            className={styles.smallButton}
                            disabled={bookingSlotId === slot.id}
                            onClick={() => handleBook(slot.id)}>
                            {bookingSlotId === slot.id
                              ? dict.interview_booking
                              : dict.interview_book_button}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
