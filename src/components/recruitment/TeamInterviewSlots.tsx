"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import styles from "@/styles/components/recruitment/RecruitmentPipeline.module.css";
import type { Dictionary } from "@/i18n/dictionaries";
import type { InterviewSlot } from "@/types/recruitment";

interface TeamInterviewSlotsProps {
  departmentName: string;
  dict: Dictionary["recruitment_management"];
  locale: string;
}

export default function TeamInterviewSlots({
  departmentName,
  dict,
  locale,
}: TeamInterviewSlotsProps) {
  const [slots, setSlots] = useState<InterviewSlot[] | null>(null);
  const [newStartsAt, setNewStartsAt] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [busySlotId, setBusySlotId] = useState<number | null>(null);

  const loadSlots = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/recruitment/interview-slots?departmentName=${encodeURIComponent(departmentName)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_load_interview_slots);
      setSlots(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_load_interview_slots, {
        closeButton: true,
      });
    }
  }, [departmentName, dict.error_load_interview_slots]);

  useEffect(() => {
    loadSlots();
  }, [loadSlots]);

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishing(true);
    try {
      const res = await fetch("/api/recruitment/interview-slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departmentName,
          startsAt: new Date(newStartsAt).toISOString(),
          location: newLocation || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_add_interview_slot);
      setNewStartsAt("");
      setNewLocation("");
      await loadSlots();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_add_interview_slot, {
        closeButton: true,
      });
    } finally {
      setPublishing(false);
    }
  };

  const handleRemove = async (slotId: number) => {
    setBusySlotId(slotId);
    try {
      const res = await fetch(`/api/recruitment/interview-slots/${slotId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_remove_interview_slot);
      await loadSlots();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_remove_interview_slot, {
        closeButton: true,
      });
    } finally {
      setBusySlotId(null);
    }
  };

  const handleCancelBooking = async (slotId: number) => {
    setBusySlotId(slotId);
    try {
      const res = await fetch(`/api/recruitment/interview-slots/${slotId}/booking`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_cancel_booking);
      await loadSlots();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_cancel_booking, {
        closeButton: true,
      });
    } finally {
      setBusySlotId(null);
    }
  };

  const handleConfirm = async (slotId: number) => {
    setBusySlotId(slotId);
    try {
      const res = await fetch(`/api/recruitment/interview-slots/${slotId}/confirm`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || dict.error_confirm_booking);
      await loadSlots();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : dict.error_confirm_booking, {
        closeButton: true,
      });
    } finally {
      setBusySlotId(null);
    }
  };

  const formatSlotTime = (value: Date | string) =>
    new Date(value).toLocaleString(locale === "en" ? "en-GB" : "pt-PT", {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div>
      {slots === null ? null : slots.length === 0 ? (
        <p className={styles.emptyState}>{dict.interview_no_slots}</p>
      ) : (
        slots.map((slot) => (
          <div key={slot.id} className={styles.teamDecisionRow}>
            <span className={styles.teamDecisionName}>{formatSlotTime(slot.startsAt)}</span>
            <span className={styles.teamDecisionSide}>
              {slot.location && <span>{slot.location}</span>}
              {slot.bookedApplicantName ? (
                <>
                  <span>
                    {dict.interview_booked_by_label}: {slot.bookedApplicantName}
                  </span>
                  <span>
                    {slot.confirmedAt
                      ? dict.interview_confirmed_label
                      : dict.interview_request_pending_label}
                  </span>
                  {!slot.confirmedAt && (
                    <button
                      className={styles.decisionButton}
                      disabled={busySlotId === slot.id}
                      onClick={() => handleConfirm(slot.id)}>
                      {dict.interview_confirm_button}
                    </button>
                  )}
                  <button
                    className={styles.decisionButton}
                    disabled={busySlotId === slot.id}
                    onClick={() => handleCancelBooking(slot.id)}>
                    {dict.interview_cancel_booking_button}
                  </button>
                </>
              ) : (
                <>
                  <span>{dict.interview_free_label}</span>
                  <button
                    className={styles.decisionButton}
                    disabled={busySlotId === slot.id}
                    onClick={() => handleRemove(slot.id)}>
                    {dict.interview_remove_button}
                  </button>
                </>
              )}
            </span>
          </div>
        ))
      )}

      <form onSubmit={handlePublish} className={styles.teamDecisionRow}>
        <div className={styles.formGroup}>
          <label>{dict.interview_starts_label}</label>
          <input
            type="datetime-local"
            className={styles.input}
            value={newStartsAt}
            onChange={(e) => setNewStartsAt(e.target.value)}
            required
          />
        </div>
        <div className={styles.formGroup}>
          <label>{dict.interview_location_label}</label>
          <input
            type="text"
            className={styles.input}
            value={newLocation}
            onChange={(e) => setNewLocation(e.target.value)}
            placeholder={dict.interview_location_placeholder}
          />
        </div>
        <button type="submit" className={styles.decisionButton} disabled={publishing}>
          {publishing ? dict.interview_publishing : dict.interview_publish_button}
        </button>
      </form>
    </div>
  );
}
