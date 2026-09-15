export type ApplicationReviewStatus = "new" | "contacted" | "archived";
export type ApplicationCampus = "Alameda" | "Taguspark";

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
  teams: string[];
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
  teams: string[];
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
