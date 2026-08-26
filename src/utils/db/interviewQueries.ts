import { db_query } from "@/utils/db/dbClient";

/**
 * Interview availability and booking (#218).
 *
 * Two things about this module are load-bearing and easy to undo by accident:
 *
 *  - **`claimInterviewSlot` is the only way a slot is taken, and it never reads first.** The SQL
 *    behind it is one conditional UPDATE whose WHERE clause is the availability test. Adding a
 *    "check if free" query in front of it would reintroduce exactly the check-then-act race the
 *    whole design exists to avoid (#79, #100).
 *  - **Nothing here sends email.** Booking creates an event and confirms the slot; the emails go
 *    out afterwards, from `interviewBooking.ts`, outside the transaction (CLAUDE.md §8).
 */

export type FreeSlot = {
  id: number;
  departmentName: string;
  coordinatorName: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
};

export type TeamSlot = FreeSlot & {
  /** The candidate who booked it, if any. */
  bookedName: string | null;
  /** Somebody is mid-booking right now. Shown so a coordinator is not surprised by a new name. */
  held: boolean;
};

export const addInterviewSlot = async (
  editionId: number,
  departmentName: string,
  coordinatorIstid: string,
  startsAt: string,
  endsAt: string,
  location?: string | null
): Promise<number> => {
  const { rows } = await db_query<{ id: number }>(
    `SELECT neiist.add_interview_slot($1::INT, $2::VARCHAR(30), $3::VARCHAR(50),
       $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6::TEXT) AS id`,
    [editionId, departmentName, coordinatorIstid, startsAt, endsAt, location ?? null]
  );
  return rows[0].id;
};

/** Withdraw your own unbooked slot. Scoped to the caller inside SQL, not by a parameter. */
export const removeInterviewSlot = async (
  slotId: number,
  coordinatorIstid: string
): Promise<void> => {
  await db_query("SELECT neiist.remove_interview_slot($1::INT, $2::VARCHAR(50))", [
    slotId,
    coordinatorIstid,
  ]);
};

export const getTeamInterviewSlots = async (departmentName: string): Promise<TeamSlot[]> => {
  const { rows } = await db_query<{
    id: number;
    coordinator_name: string;
    starts_at: string;
    ends_at: string;
    location: string | null;
    booked_name: string | null;
    held: boolean;
  }>("SELECT * FROM neiist.get_team_interview_slots($1::VARCHAR(30))", [departmentName]);

  return rows.map((row) => ({
    id: row.id,
    departmentName,
    coordinatorName: row.coordinator_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    bookedName: row.booked_name,
    held: row.held,
  }));
};

/** Free slots for this candidate. Keyed by application so another team cannot be enumerated. */
export const getFreeInterviewSlots = async (applicationId: number): Promise<FreeSlot[]> => {
  const { rows } = await db_query<{
    id: number;
    department_name: string;
    coordinator_name: string;
    starts_at: string;
    ends_at: string;
    location: string | null;
  }>("SELECT * FROM neiist.get_free_interview_slots($1::INT)", [applicationId]);

  return rows.map((row) => ({
    id: row.id,
    departmentName: row.department_name,
    coordinatorName: row.coordinator_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
  }));
};

/**
 * Take a slot. Returns the slot id, or **null when somebody else got there first**.
 *
 * Null is an ordinary outcome the page renders, not an error: two people can want 20:00 and only
 * one can have it. Do not "improve" this by checking availability first — the single statement
 * behind it is what makes the answer true.
 */
export const claimInterviewSlot = async (
  slotId: number,
  applicationId: number
): Promise<number | null> => {
  const { rows } = await db_query<{ id: number | null }>(
    "SELECT neiist.claim_interview_slot($1::INT, $2::INT) AS id",
    [slotId, applicationId]
  );
  return rows[0].id;
};

/** Turn a live hold into a booking. False if the hold expired and the slot went to someone else. */
export const confirmInterviewSlot = async (
  slotId: number,
  applicationId: number,
  eventId: number
): Promise<boolean> => {
  const { rows } = await db_query<{ confirm_interview_slot: boolean }>(
    "SELECT neiist.confirm_interview_slot($1::INT, $2::INT, $3::INT)",
    [slotId, applicationId, eventId]
  );
  return rows[0].confirm_interview_slot;
};

/** Cancel your own booking; the slot returns to the pool. Returns the orphaned event id. */
export const cancelInterviewBooking = async (
  slotId: number,
  applicationId: number
): Promise<number | null> => {
  const { rows } = await db_query<{ cancel_interview_booking: number | null }>(
    "SELECT neiist.cancel_interview_booking($1::INT, $2::INT)",
    [slotId, applicationId]
  );
  return rows[0].cancel_interview_booking;
};

export const getInterviewBooking = async (applicationId: number, departmentName: string) => {
  const { rows } = await db_query<{
    slot_id: number;
    coordinator_name: string;
    starts_at: string;
    ends_at: string;
    location: string | null;
  }>("SELECT * FROM neiist.get_interview_booking($1::INT, $2::VARCHAR(30))", [
    applicationId,
    departmentName,
  ]);
  const row = rows[0];
  return row
    ? {
        slotId: row.slot_id,
        coordinatorName: row.coordinator_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        location: row.location,
      }
    : null;
};

/** Tidy stale holds. Correctness never depends on this having run — the claim handles it. */
export const releaseExpiredInterviewHolds = async (): Promise<number> => {
  const { rows } = await db_query<{ release_expired_interview_holds: number }>(
    "SELECT neiist.release_expired_interview_holds()"
  );
  return rows[0].release_expired_interview_holds;
};
