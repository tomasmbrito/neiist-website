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
