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
  /**
   * This team's decision. Other teams decide separately on the same application.
   *
   * **Derived, never assigned** (#217): it is a trigger's summary of the two signatures below,
   * and stays `pending` until both are in. Nothing writes it directly.
   */
  outcome: ApplicationOutcome;
  note: string | null;
  /** Names only — the other teams' decisions are theirs to make, not this team's business. */
  otherTeams: string[];
  /** The two signatures. `null` means that half has not signed yet. */
  teamDecision: ApprovalDecision | null;
  teamActor: string | null;
  boardDecision: ApprovalDecision | null;
  boardActor: string | null;
};

/** One row of the board's cross-team queue. Deliberately not the whole application (#217). */
export type BoardPendingApplication = {
  id: number;
  fullName: string;
  departmentName: string;
  submittedAt: string;
  teamDecision: ApprovalDecision;
  teamActor: string | null;
  teamNote: string | null;
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
    team_decision: ApprovalDecision | null;
    team_actor: string | null;
    board_decision: ApprovalDecision | null;
    board_actor: string | null;
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
    teamDecision: row.team_decision,
    teamActor: row.team_actor,
    boardDecision: row.board_decision,
    boardActor: row.board_actor,
  }));
};

/** Which half of the pair someone is signing (#217). */
export const APPROVAL_SIDES = ["team", "board"] as const;
export type ApprovalSide = (typeof APPROVAL_SIDES)[number];
export type ApprovalDecision = "accept" | "reject";

/**
 * Record one half of the two-signature approval.
 *
 * `side` is a **hint**, not an instruction: SQL checks it against the actor's real memberships
 * and refuses a side they do not hold. It exists only for the one person who is both a
 * coordinator of the team and on the board and therefore has a genuine choice — everyone else
 * can omit it. Passing it does not confer it.
 *
 * There is deliberately no function that writes `outcome`. It is derived by trigger from the
 * approvals, so no caller can record a decision that two people did not make.
 */
export const recordApplicationApproval = async (
  applicationId: number,
  departmentName: string,
  decision: ApprovalDecision,
  actorIstid: string,
  side?: ApprovalSide | null,
  note?: string | null
): Promise<ApprovalSide> => {
  const { rows } = await db_query<{ record_application_approval: ApprovalSide }>(
    `SELECT neiist.record_application_approval(
       $1::INT, $2::VARCHAR(30), $3::TEXT, $4::VARCHAR(50), $5::TEXT, $6::TEXT)`,
    [applicationId, departmentName, decision, actorIstid, side ?? null, note ?? null]
  );
  return rows[0].record_application_approval;
};

/** Take back your own signature. Reopens the application through the same trigger. */
export const withdrawApplicationApproval = async (
  applicationId: number,
  departmentName: string,
  actorIstid: string
): Promise<void> => {
  await db_query(
    "SELECT neiist.withdraw_application_approval($1::INT, $2::VARCHAR(30), $3::VARCHAR(50))",
    [applicationId, departmentName, actorIstid]
  );
};

/** Which sides this person may sign for this team. Empty means they may not decide at all. */
export const getApprovalSides = async (
  actorIstid: string,
  departmentName: string
): Promise<ApprovalSide[]> => {
  const { rows } = await db_query<{ side: ApprovalSide }>(
    "SELECT * FROM neiist.application_approval_sides($1::VARCHAR(50), $2::VARCHAR(30))",
    [actorIstid, departmentName]
  );
  return rows.map((row) => row.side);
};

/**
 * May this person give the BOARD signature at all?
 *
 * A question about the person, not about any team — which is why it does not go through
 * `getApprovalSides`, where a department has to be named and would only be ignored.
 *
 * Reads `board_member`, the same column `application_approval_sides` reads on the write (#217).
 * It used to infer the board from an `admin` grade inside a non-team department, and that
 * inference was wrong in exactly the way Tomás pointed out: the Diretores de Atividades are on
 * the Direção and are graded `coordinator`, so a grade-based rule left them out. Being on the
 * board and how much of the workspace a role opens are two different facts.
 */
export const isBoardSignatory = async (actorIstid: string): Promise<boolean> => {
  const { rows } = await db_query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM neiist.membership m
       JOIN neiist.valid_department_roles v
         ON v.department_name = m.department_name AND v.role_name = m.role_name
       WHERE m.user_istid = $1::VARCHAR(50)
         AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)
         AND v.active AND v.board_member
     ) AS ok`,
    [actorIstid]
  );
  return rows[0].ok;
};

/** The board's queue: team has signed, the board has not. Deliberately without the full record. */
export const getBoardPendingApplications = async (): Promise<BoardPendingApplication[]> => {
  const { rows } = await db_query<{
    id: number;
    full_name: string;
    department_name: string;
    submitted_at: string;
    team_decision: ApprovalDecision;
    team_actor: string | null;
    team_note: string | null;
  }>("SELECT * FROM neiist.get_board_pending_applications()");

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    departmentName: row.department_name,
    submittedAt: row.submitted_at,
    teamDecision: row.team_decision,
    teamActor: row.team_actor,
    teamNote: row.team_note,
  }));
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
