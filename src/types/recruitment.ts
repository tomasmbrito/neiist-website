export type ApplicationReviewStatus = "new" | "contacted" | "archived";
export type ApplicationCampus = "Alameda" | "Taguspark";
export type TeamDecision = "pending" | "accepted" | "rejected";
export type DecisionSide = "coordinator" | "board";

// Built by get_recruitment_pipeline's jsonb_build_object with these exact camelCase keys, so
// this is both the DB row shape and the app-facing shape — no separate Db* type or mapper
// needed for this nested part.
export interface ApplicationTeamState {
  name: string;
  coordinatorDecision: TeamDecision;
  boardDecision: TeamDecision;
  outcome: TeamDecision;
}

export interface DbRecruitmentEdition {
  id: number;
  name: string;
  opens_at: string;
  closes_at: string;
}

export interface RecruitmentEdition {
  id: number;
  name: string;
  opensAt: Date | string;
  closesAt: Date | string;
}

export interface DbApplication {
  id: number;
  applicant_istid: string;
  name: string;
  email: string;
  phone: string;
  campus: ApplicationCampus;
  course: string;
  curricular_year: number;
  prior_experience: string | null;
  motivation: string;
  fun_fact: string;
  wants_waitlist: boolean;
  review_status: ApplicationReviewStatus;
  review_note: string | null;
  reviewed_by_istid: string | null;
  submitted_at: string;
  teams: ApplicationTeamState[];
}

export interface Application {
  id: number;
  applicantIstid: string;
  name: string;
  email: string;
  phone: string;
  campus: ApplicationCampus;
  course: string;
  curricularYear: number;
  priorExperience: string | null;
  motivation: string;
  funFact: string;
  wantsWaitlist: boolean;
  reviewStatus: ApplicationReviewStatus;
  reviewNote: string | null;
  reviewedByIstid: string | null;
  submittedAt: Date | string;
  teams: ApplicationTeamState[];
}

export interface SubmitApplicationInput {
  name: string;
  email: string;
  phone: string;
  campus: ApplicationCampus;
  course: string;
  curricularYear: number;
  priorExperience?: string | null;
  motivation: string;
  funFact: string;
  wantsWaitlist: boolean;
  departments: string[];
}

export function mapDbRecruitmentEdition(row: DbRecruitmentEdition): RecruitmentEdition {
  return {
    id: row.id,
    name: row.name,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
  };
}

// set_application_review_status returns SETOF neiist.applications directly — the raw table
// row, with no `teams` array (that's computed only inside get_recruitment_pipeline). Kept as
// its own type instead of reusing DbApplication so the missing field can't be silently assumed.
export interface DbApplicationReviewUpdate {
  id: number;
  review_status: ApplicationReviewStatus;
  review_note: string | null;
  reviewed_by_istid: string | null;
}

export function mapDbApplicationReviewUpdate(row: DbApplicationReviewUpdate) {
  return {
    id: row.id,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
    reviewedByIstid: row.reviewed_by_istid,
  };
}

export interface DbTeamDecisionUpdate {
  application_id: number;
  department_name: string;
  coordinator_decision: TeamDecision;
  board_decision: TeamDecision;
  outcome: TeamDecision;
  just_finalized: boolean;
  applicant_name: string;
  applicant_email: string;
}

export function mapDbTeamDecisionUpdate(row: DbTeamDecisionUpdate) {
  return {
    applicationId: row.application_id,
    departmentName: row.department_name,
    coordinatorDecision: row.coordinator_decision,
    boardDecision: row.board_decision,
    outcome: row.outcome,
    justFinalized: row.just_finalized,
    applicantName: row.applicant_name,
    applicantEmail: row.applicant_email,
  };
}

// The coordinator's own team view — every published slot, booked or not.
export interface DbInterviewSlot {
  id: number;
  starts_at: string;
  ends_at: string;
  location: string | null;
  booked_application_id: number | null;
  booked_applicant_name: string | null;
  booked_at: string | null;
  confirmed_at: string | null;
}

export interface InterviewSlot {
  id: number;
  startsAt: Date | string;
  endsAt: Date | string;
  location: string | null;
  bookedApplicationId: number | null;
  bookedApplicantName: string | null;
  bookedAt: Date | string | null;
  confirmedAt: Date | string | null;
}

export function mapDbInterviewSlot(row: DbInterviewSlot): InterviewSlot {
  return {
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    bookedApplicationId: row.booked_application_id,
    bookedApplicantName: row.booked_applicant_name,
    bookedAt: row.booked_at,
    confirmedAt: row.confirmed_at,
  };
}

// The candidate's own bookable view — unbooked, future slots for teams their application
// actually applied to.
export interface DbBookableInterviewSlot {
  id: number;
  department_name: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
}

export interface BookableInterviewSlot {
  id: number;
  departmentName: string;
  startsAt: Date | string;
  endsAt: Date | string;
  location: string | null;
}

export function mapDbBookableInterviewSlot(row: DbBookableInterviewSlot): BookableInterviewSlot {
  return {
    id: row.id,
    departmentName: row.department_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
  };
}

// book_interview_slot / confirm_interview_booking / cancel_interview_booking all return
// everything an API route needs to email both sides, without a second query. was_confirmed is
// only present on cancel_interview_booking's result (picks "request declined" vs "confirmed
// interview cancelled" email copy).
export interface DbInterviewBookingResult {
  id: number;
  department_name: string;
  starts_at: string;
  ends_at?: string;
  location: string | null;
  applicant_name: string;
  applicant_email: string;
  coordinator_name: string;
  coordinator_email: string;
  was_confirmed?: boolean;
}

export interface InterviewBookingResult {
  id: number;
  departmentName: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  location: string | null;
  applicantName: string;
  applicantEmail: string;
  coordinatorName: string;
  coordinatorEmail: string;
  wasConfirmed: boolean | null;
}

export function mapDbInterviewBookingResult(row: DbInterviewBookingResult): InterviewBookingResult {
  return {
    id: row.id,
    departmentName: row.department_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? null,
    location: row.location,
    applicantName: row.applicant_name,
    applicantEmail: row.applicant_email,
    coordinatorName: row.coordinator_name,
    coordinatorEmail: row.coordinator_email,
    wasConfirmed: row.was_confirmed ?? null,
  };
}

export function mapDbApplication(row: DbApplication): Application {
  return {
    id: row.id,
    applicantIstid: row.applicant_istid,
    name: row.name,
    email: row.email,
    phone: row.phone,
    campus: row.campus,
    course: row.course,
    curricularYear: row.curricular_year,
    priorExperience: row.prior_experience,
    motivation: row.motivation,
    funFact: row.fun_fact,
    wantsWaitlist: row.wants_waitlist,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
    reviewedByIstid: row.reviewed_by_istid,
    submittedAt: row.submitted_at,
    teams: row.teams ?? [],
  };
}

export type InterviewRequestStatus = "requested" | "confirmed";

export interface ApplicationTeamInterview {
  slotId: number;
  startsAt: string;
  location: string | null;
  status: InterviewRequestStatus;
}

// get_my_application_full's per-team JSONB — ApplicationTeamState plus the interview sub-object
// (null when the candidate hasn't booked a slot for that team yet), built with the same
// camelCase-keys-match-the-app-shape approach as ApplicationTeamState itself.
export interface ApplicationTeamFullState extends ApplicationTeamState {
  interview: ApplicationTeamInterview | null;
}

export interface DbMyApplicationFull {
  id: number;
  applicant_istid: string;
  name: string;
  email: string;
  phone: string;
  campus: ApplicationCampus;
  course: string;
  curricular_year: number;
  prior_experience: string | null;
  motivation: string;
  fun_fact: string;
  wants_waitlist: boolean;
  review_status: ApplicationReviewStatus;
  submitted_at: string;
  is_locked: boolean;
  teams: ApplicationTeamFullState[];
}

export interface MyApplicationFull {
  id: number;
  applicantIstid: string;
  name: string;
  email: string;
  phone: string;
  campus: ApplicationCampus;
  course: string;
  curricularYear: number;
  priorExperience: string | null;
  motivation: string;
  funFact: string;
  wantsWaitlist: boolean;
  reviewStatus: ApplicationReviewStatus;
  submittedAt: Date | string;
  isLocked: boolean;
  teams: ApplicationTeamFullState[];
}

export function mapDbMyApplicationFull(row: DbMyApplicationFull): MyApplicationFull {
  return {
    id: row.id,
    applicantIstid: row.applicant_istid,
    name: row.name,
    email: row.email,
    phone: row.phone,
    campus: row.campus,
    course: row.course,
    curricularYear: row.curricular_year,
    priorExperience: row.prior_experience,
    motivation: row.motivation,
    funFact: row.fun_fact,
    wantsWaitlist: row.wants_waitlist,
    reviewStatus: row.review_status,
    submittedAt: row.submitted_at,
    isLocked: row.is_locked,
    teams: row.teams ?? [],
  };
}

export interface UpdateMyApplicationInput {
  phone: string;
  campus: ApplicationCampus;
  course: string;
  curricularYear: number;
  priorExperience?: string | null;
  motivation: string;
  funFact: string;
  wantsWaitlist: boolean;
  departments: string[];
}
