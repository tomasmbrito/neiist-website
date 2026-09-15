import {
  Application,
  BookableInterviewSlot,
  DbApplication,
  DbApplicationReviewUpdate,
  DbBookableInterviewSlot,
  DbInterviewBookingResult,
  DbInterviewSlot,
  DbMyApplicationFull,
  DbRecruitmentEdition,
  DbTeamDecisionUpdate,
  DecisionSide,
  InterviewBookingResult,
  InterviewSlot,
  MyApplicationFull,
  RecruitmentEdition,
  SubmitApplicationInput,
  UpdateMyApplicationInput,
  mapDbApplication,
  mapDbApplicationReviewUpdate,
  mapDbBookableInterviewSlot,
  mapDbInterviewBookingResult,
  mapDbInterviewSlot,
  mapDbMyApplicationFull,
  mapDbRecruitmentEdition,
  mapDbTeamDecisionUpdate,
} from "@/types/recruitment";
import { db_query } from "@/lib/db/connection";

export const getOpenRecruitmentEdition = async (): Promise<RecruitmentEdition | null> => {
  const {
    rows: [row],
  } = await db_query<DbRecruitmentEdition>(`SELECT * FROM neiist.get_open_recruitment_edition()`);
  return row ? mapDbRecruitmentEdition(row) : null;
};

export const getAllRecruitmentEditions = async (): Promise<RecruitmentEdition[]> => {
  const { rows } = await db_query<DbRecruitmentEdition>(
    `SELECT * FROM neiist.get_all_recruitment_editions()`
  );
  return rows.map(mapDbRecruitmentEdition);
};

export const getMyApplication = async (
  applicantIstid: string,
  editionId: number
): Promise<{ id: number; submittedAt: string } | null> => {
  const {
    rows: [row],
  } = await db_query<{ id: number; submitted_at: string }>(
    `SELECT * FROM neiist.get_my_application($1, $2)`,
    [applicantIstid, editionId]
  );
  return row ? { id: row.id, submittedAt: row.submitted_at } : null;
};

export const createRecruitmentEdition = async (
  name: string,
  opensAt: Date | string,
  closesAt: Date | string,
  actorIstid: string
): Promise<number> => {
  const {
    rows: [row],
  } = await db_query<{ create_recruitment_edition: number }>(
    `SELECT neiist.create_recruitment_edition($1, $2, $3, $4)`,
    [name, opensAt, closesAt, actorIstid]
  );
  return row.create_recruitment_edition;
};

export const submitApplication = async (
  applicantIstid: string,
  input: SubmitApplicationInput
): Promise<number> => {
  const {
    rows: [row],
  } = await db_query<{ submit_application: number }>(
    `SELECT neiist.submit_application($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      applicantIstid,
      input.name,
      input.email,
      input.phone,
      input.campus,
      input.course,
      input.curricularYear,
      input.priorExperience ?? null,
      input.motivation,
      input.funFact,
      input.wantsWaitlist,
      input.departments,
    ]
  );
  return row.submit_application;
};

export const getRecruitmentPipeline = async (
  callerIstid: string,
  editionId: number
): Promise<Application[]> => {
  const { rows } = await db_query<DbApplication>(
    `SELECT * FROM neiist.get_recruitment_pipeline($1, $2)`,
    [callerIstid, editionId]
  );
  return rows.map(mapDbApplication);
};

export const setApplicationReviewStatus = async (
  applicationId: number,
  status: string,
  note: string | null,
  actorIstid: string
): Promise<ReturnType<typeof mapDbApplicationReviewUpdate> | null> => {
  const {
    rows: [row],
  } = await db_query<DbApplicationReviewUpdate>(
    `SELECT * FROM neiist.set_application_review_status($1,$2,$3,$4)`,
    [applicationId, status, note, actorIstid]
  );
  return row ? mapDbApplicationReviewUpdate(row) : null;
};

export const isRecruitmentBoardMember = async (istid: string): Promise<boolean> => {
  const {
    rows: [row],
  } = await db_query<{ is_recruitment_board_member: boolean }>(
    `SELECT neiist.is_recruitment_board_member($1)`,
    [istid]
  );
  return row?.is_recruitment_board_member ?? false;
};

export const getMyCoordinatedTeams = async (istid: string): Promise<string[]> => {
  const { rows } = await db_query<{ department_name: string }>(
    `SELECT * FROM neiist.get_my_coordinated_teams($1)`,
    [istid]
  );
  return rows.map((r) => r.department_name);
};

export const setTeamDecision = async (
  applicationId: number,
  departmentName: string,
  side: DecisionSide,
  decision: "accepted" | "rejected",
  actorIstid: string
): Promise<ReturnType<typeof mapDbTeamDecisionUpdate> | null> => {
  const {
    rows: [row],
  } = await db_query<DbTeamDecisionUpdate>(
    `SELECT * FROM neiist.set_team_decision($1,$2,$3,$4,$5)`,
    [applicationId, departmentName, side, decision, actorIstid]
  );
  return row ? mapDbTeamDecisionUpdate(row) : null;
};

export const addInterviewSlot = async (
  departmentName: string,
  actorIstid: string,
  startsAt: Date | string,
  location: string | null
): Promise<InterviewSlot> => {
  const {
    rows: [row],
  } = await db_query<DbInterviewSlot>(`SELECT * FROM neiist.add_interview_slot($1,$2,$3,$4)`, [
    departmentName,
    actorIstid,
    startsAt,
    location,
  ]);
  return mapDbInterviewSlot(row);
};

export const removeInterviewSlot = async (slotId: number, actorIstid: string): Promise<void> => {
  await db_query(`SELECT neiist.remove_interview_slot($1, $2)`, [slotId, actorIstid]);
};

export const getInterviewSlots = async (
  departmentName: string,
  actorIstid: string
): Promise<InterviewSlot[]> => {
  const { rows } = await db_query<DbInterviewSlot>(
    `SELECT * FROM neiist.get_interview_slots($1, $2)`,
    [departmentName, actorIstid]
  );
  return rows.map(mapDbInterviewSlot);
};

export const getBookableInterviewSlots = async (
  applicationId: number,
  applicantIstid: string
): Promise<BookableInterviewSlot[]> => {
  const { rows } = await db_query<DbBookableInterviewSlot>(
    `SELECT * FROM neiist.get_bookable_interview_slots($1, $2)`,
    [applicationId, applicantIstid]
  );
  return rows.map(mapDbBookableInterviewSlot);
};

export const bookInterviewSlot = async (
  slotId: number,
  applicationId: number,
  applicantIstid: string
): Promise<InterviewBookingResult> => {
  const {
    rows: [row],
  } = await db_query<DbInterviewBookingResult>(
    `SELECT * FROM neiist.book_interview_slot($1, $2, $3)`,
    [slotId, applicationId, applicantIstid]
  );
  return mapDbInterviewBookingResult(row);
};

export const cancelInterviewBooking = async (
  slotId: number,
  actorIstid: string
): Promise<InterviewBookingResult> => {
  const {
    rows: [row],
  } = await db_query<DbInterviewBookingResult>(
    `SELECT * FROM neiist.cancel_interview_booking($1, $2)`,
    [slotId, actorIstid]
  );
  return mapDbInterviewBookingResult(row);
};

export const confirmInterviewBooking = async (
  slotId: number,
  actorIstid: string
): Promise<InterviewBookingResult> => {
  const {
    rows: [row],
  } = await db_query<DbInterviewBookingResult>(
    `SELECT * FROM neiist.confirm_interview_booking($1, $2)`,
    [slotId, actorIstid]
  );
  return mapDbInterviewBookingResult(row);
};

export const getMyApplicationFull = async (
  applicationId: number,
  applicantIstid: string
): Promise<MyApplicationFull | null> => {
  const {
    rows: [row],
  } = await db_query<DbMyApplicationFull>(`SELECT * FROM neiist.get_my_application_full($1, $2)`, [
    applicationId,
    applicantIstid,
  ]);
  return row ? mapDbMyApplicationFull(row) : null;
};

export const updateMyApplication = async (
  applicationId: number,
  applicantIstid: string,
  input: UpdateMyApplicationInput
): Promise<void> => {
  await db_query(`SELECT neiist.update_my_application($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
    applicationId,
    applicantIstid,
    input.phone,
    input.campus,
    input.course,
    input.curricularYear,
    input.priorExperience ?? null,
    input.motivation,
    input.funFact,
    input.wantsWaitlist,
    input.departments,
  ]);
};
