import {
  Application,
  DbApplication,
  DbApplicationReviewUpdate,
  DbRecruitmentEdition,
  RecruitmentEdition,
  SubmitApplicationInput,
  mapDbApplication,
  mapDbApplicationReviewUpdate,
  mapDbRecruitmentEdition,
} from "@/types/recruitment";
import { db_query } from "@/lib/db/connection";

export const getOpenRecruitmentEdition = async (): Promise<RecruitmentEdition | null> => {
  const {
    rows: [row],
  } = await db_query<DbRecruitmentEdition>(`SELECT * FROM neiist.get_open_recruitment_edition()`);
  return row ? mapDbRecruitmentEdition(row) : null;
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
