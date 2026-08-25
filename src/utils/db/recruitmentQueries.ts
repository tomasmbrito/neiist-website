import { db_query } from "@/utils/db/dbClient";

/**
 * Recruitment applications (#134, slice A).
 *
 * Its own module, following `taskQueries.ts` rather than widening an existing one (CLAUDE.md §4).
 *
 * One thing here is unlike everything else in the workspace family: **`submitApplication` is
 * called by nobody in particular.** It is the one public write, so every rule that matters lives
 * in `neiist.submit_application` rather than in the route — there is no session to check.
 */
export type ApplicationOutcome = "pending" | "accepted" | "rejected";

export type TeamApplication = {
  id: number;
  fullName: string;
  istid: string;
  email: string;
  phone: string | null;
  course: string | null;
  year: number | null;
  motivation: string | null;
  status: "submitted" | "screened_out" | "interviewing" | "closed";
  submittedAt: string;
  /** This team's decision. Other teams decide separately on the same application. */
  outcome: ApplicationOutcome;
  note: string | null;
  /** Names only — the other teams' decisions are theirs to make, not this team's business. */
  otherTeams: string[];
};

/** Errors throw: "applications are closed" and "that team does not exist" both need saying. */
export const submitApplication = async (input: {
  fullName: string;
  istid: string;
  email: string;
  phone?: string | null;
  course?: string | null;
  year?: number | null;
  motivation?: string | null;
  teams: string[];
}): Promise<number> => {
  const { rows } = await db_query<{ submit_application: number }>(
    `SELECT neiist.submit_application(
       $1::TEXT, $2::VARCHAR(50), $3::TEXT, $4::TEXT, $5::TEXT, $6::INT, $7::TEXT, $8::VARCHAR(30)[]
     )`,
    [
      input.fullName,
      input.istid,
      input.email,
      input.phone ?? null,
      input.course ?? null,
      input.year ?? null,
      input.motivation ?? null,
      input.teams,
    ]
  );
  return rows[0].submit_application;
};

/**
 * Applications this team can see.
 *
 * Keyed by department, like every reader in this family. There is deliberately no "all
 * applications" function: an application to Visuais is not Dev-Team's business, and the board
 * reaches every team through `canForTeam`'s organisation-wide short-circuit rather than through a
 * wider query.
 */
export const getTeamApplications = async (departmentName: string): Promise<TeamApplication[]> => {
  const { rows } = await db_query<{
    id: number;
    full_name: string;
    istid: string;
    email: string;
    phone: string | null;
    course: string | null;
    year: number | null;
    motivation: string | null;
    status: TeamApplication["status"];
    submitted_at: string;
    outcome: ApplicationOutcome;
    note: string | null;
    other_teams: string[];
  }>("SELECT * FROM neiist.get_team_applications($1::VARCHAR(30))", [departmentName]);

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    istid: row.istid,
    email: row.email,
    phone: row.phone,
    course: row.course,
    year: row.year,
    motivation: row.motivation,
    status: row.status,
    submittedAt: row.submitted_at,
    outcome: row.outcome,
    note: row.note,
    otherTeams: row.other_teams,
  }));
};

/** Decide this team's part. The application closes once every team has decided — in SQL. */
export const decideApplicationTeam = async (
  applicationId: number,
  departmentName: string,
  outcome: ApplicationOutcome,
  actorIstid: string,
  note?: string | null
): Promise<void> => {
  await db_query(
    "SELECT neiist.decide_application_team($1::INT, $2::VARCHAR(30), $3::TEXT, $4::VARCHAR(50), $5::TEXT)",
    [applicationId, departmentName, outcome, actorIstid, note ?? null]
  );
};

/** Is recruitment open? Drives whether the public page shows a form or an explanation. */
export const getOpenEdition = async (): Promise<{
  id: number;
  name: string;
  closesAt: string;
} | null> => {
  const { rows } = await db_query<{ id: number; name: string; closes_at: string }>(
    `SELECT id, name, closes_at FROM neiist.recruitment_editions
     WHERE NOW() BETWEEN opens_at AND closes_at LIMIT 1`
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, closesAt: row.closes_at } : null;
};
