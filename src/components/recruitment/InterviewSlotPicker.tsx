"use client";

import { useState } from "react";
import { toast } from "sonner";
import styles from "@/styles/components/recruitment/StatusCard.module.css";
import type { Dictionary } from "@/i18n/dictionaries";
import type { BookableInterviewSlot } from "@/types/recruitment";

interface InterviewSlotPickerProps {
  applicationId: number;
  slotsByTeam: Record<string, BookableInterviewSlot[]>;
  dict: Dictionary["recruitment"];
  locale: string;
}

export default function InterviewSlotPicker({
  applicationId,
  slotsByTeam,
  dict,
  locale,
}: InterviewSlotPickerProps) {
  const [teams, setTeams] = useState(slotsByTeam);
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});
  const [bookingSlotId, setBookingSlotId] = useState<number | null>(null);

  const formatSlotTime = (value: Date | string) =>
    new Date(value).toLocaleString(locale === "en" ? "en-GB" : "pt-PT", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  const handleBook = async (teamName: string, slotId: number) => {
    setBookingSlotId(slotId);
    try {
      const res = await fetch(`/api/recruitment/applications/${applicationId}/interview-slots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_book_interview);

      setTeams((prev) => {
        const next = { ...prev };
        delete next[teamName];
        return next;
      });
      setConfirmed((prev) => ({
        ...prev,
        [teamName]: dict.interview_booked_confirmation.replace(
          "{date}",
          formatSlotTime(data.startsAt)
        ),
      }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_book_interview, {
        closeButton: true,
      });
    } finally {
      setBookingSlotId(null);
    }
  };

  const teamNames = Object.keys(teams);
  if (teamNames.length === 0 && Object.keys(confirmed).length === 0) return null;

  return (
    <div className={styles.slotsSection}>
      <h2 className={styles.slotsTitle}>{dict.interview_slots_title}</h2>
      <p className={styles.slotsHint}>{dict.interview_slots_hint}</p>

      {Object.entries(confirmed).map(([teamName, message]) => (
        <div key={teamName} className={styles.teamGroup}>
          <div className={styles.teamGroupName}>{teamName}</div>
          <p className={styles.slotConfirmed}>{message}</p>
        </div>
      ))}

      {teamNames.map((teamName) => (
        <div key={teamName} className={styles.teamGroup}>
          <div className={styles.teamGroupName}>{teamName}</div>
          {teams[teamName].map((slot) => (
            <div key={slot.id} className={styles.slotRow}>
              <span>{formatSlotTime(slot.startsAt)}</span>
              <button
                className={styles.slotButton}
                disabled={bookingSlotId === slot.id}
                onClick={() => handleBook(teamName, slot.id)}>
                {bookingSlotId === slot.id ? dict.interview_booking : dict.interview_book_button}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
