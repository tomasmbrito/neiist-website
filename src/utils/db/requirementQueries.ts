import { db_query } from "@/utils/db/dbClient";

/**
 * Requerimentos — how NEIIST's teams ask each other for work (#232, slice A of #131).
 *
 * One asymmetry runs through every function here and is the whole authorization model:
 *
 *   **the REQUESTING team asks; the TARGET team owns the status and the deliverables.**
 *
 * Letting the requesting team mark its own request `done` would make the status meaningless as a
 * signal — Organização de Eventos could close a poster nobody drew. The exception is cancelling,
 * which either side may do: withdrawing your own request is not a claim about somebody else's work.
 *
 * Every guard is in SQL, not here. These functions pass the caller's team through; they do not
 * decide anything.
 */

export const REQUIREMENT_STATUSES = [
  "requested",
  "accepted",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export type TeamRequirement = {
  id: number;
  eventId: number;
  eventName: string;
  /** `inbox` = asked of my team; `outbox` = my team asked somebody. */
  direction: "inbox" | "outbox";
  requestingDepartment: string;
  targetDepartment: string;
  title: string;
  detail: string | null;
  deadline: string | null;
  status: RequirementStatus;
  assigneeName: string | null;
  deliverableCount: number;
  createdAt: string;
};

export type RequirementDeliverable = {
  id: number;
  url: string;
  label: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
};

/** One input row for `raiseRequirements`. The arrays are unzipped in the query below. */
export type RequirementRequest = {
  targetDepartment: string;
  title: string;
  detail?: string | null;
  deadline?: string | null;
};

/**
 * Raise N requerimentos on one event, atomically — a stated acceptance criterion of #131.
 *
 * The atomicity is in SQL rather than `withTransaction` because it is one statement's worth of
 * work behind one guard, and a plpgsql function is already one implicit transaction. Threading a
 * `Querier` here would buy nothing and add a way to get it wrong.
 */
export const raiseRequirements = async (
  eventId: number,
  requestingDepartment: string,
  requests: RequirementRequest[],
  createdByIstid: string
): Promise<number> => {
  const { rows } = await db_query<{ raise_requirements: number }>(
    `SELECT neiist.raise_requirements($1::INT, $2::VARCHAR(30), $3::VARCHAR(30)[],
       $4::TEXT[], $5::TEXT[], $6::TIMESTAMPTZ[], $7::VARCHAR(50))`,
    [
      eventId,
      requestingDepartment,
      requests.map((r) => r.targetDepartment),
      requests.map((r) => r.title),
      requests.map((r) => r.detail ?? null),
      requests.map((r) => r.deadline ?? null),
      createdByIstid,
    ]
  );
  return rows[0].raise_requirements;
};

/** Everything one team can see, both directions. A third team gets nothing — enforced in SQL. */
export const getTeamRequirements = async (departmentName: string): Promise<TeamRequirement[]> => {
  const { rows } = await db_query<{
    id: number;
    event_id: number;
    event_name: string;
    direction: "inbox" | "outbox";
    requesting_department: string;
    target_department: string;
    title: string;
    detail: string | null;
    deadline: string | null;
    status: RequirementStatus;
    assignee_name: string | null;
    deliverable_count: number;
    created_at: string;
  }>("SELECT * FROM neiist.get_team_requirements($1::VARCHAR(30))", [departmentName]);

  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    eventName: row.event_name,
    direction: row.direction,
    requestingDepartment: row.requesting_department,
    targetDepartment: row.target_department,
    title: row.title,
    detail: row.detail,
    deadline: row.deadline,
    status: row.status,
    assigneeName: row.assignee_name,
    deliverableCount: row.deliverable_count,
    createdAt: row.created_at,
  }));
};

/** `team` is the caller's team, checked in SQL — not a filter applied afterwards. */
export const setRequirementStatus = async (
  requirementId: number,
  status: RequirementStatus,
  actorIstid: string,
  team: string
): Promise<void> => {
  await db_query(
    "SELECT neiist.set_requirement_status($1::INT, $2::TEXT, $3::VARCHAR(50), $4::VARCHAR(30))",
    [requirementId, status, actorIstid, team]
  );
};

/** `null` unassigns. SQL refuses anyone who is not on the target team. */
export const assignRequirement = async (
  requirementId: number,
  assigneeIstid: string | null,
  team: string
): Promise<void> => {
  await db_query("SELECT neiist.assign_requirement($1::INT, $2::VARCHAR(50), $3::VARCHAR(30))", [
    requirementId,
    assigneeIstid,
    team,
  ]);
};

export const addRequirementDeliverable = async (
  requirementId: number,
  url: string,
  label: string | null,
  actorIstid: string,
  team: string
): Promise<number> => {
  const { rows } = await db_query<{ add_requirement_deliverable: number }>(
    `SELECT neiist.add_requirement_deliverable($1::INT, $2::TEXT, $3::TEXT, $4::VARCHAR(50),
       $5::VARCHAR(30))`,
    [requirementId, url, label, actorIstid, team]
  );
  return rows[0].add_requirement_deliverable;
};

/** Keyed by requirement AND asking team, like `event_teams` (#219): an unrelated id returns none. */
export const getRequirementDeliverables = async (
  requirementId: number,
  departmentName: string
): Promise<RequirementDeliverable[]> => {
  const { rows } = await db_query<{
    id: number;
    url: string;
    label: string | null;
    uploaded_by_name: string | null;
    uploaded_at: string;
  }>("SELECT * FROM neiist.get_requirement_deliverables($1::INT, $2::VARCHAR(30))", [
    requirementId,
    departmentName,
  ]);
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    label: row.label,
    uploadedByName: row.uploaded_by_name,
    uploadedAt: row.uploaded_at,
  }));
};
