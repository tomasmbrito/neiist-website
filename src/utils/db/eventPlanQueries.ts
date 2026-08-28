import { db_query } from "@/utils/db/dbClient";

/**
 * Plano de Atividades (#247) — the document above the requerimentos.
 *
 * Two rules run through every function here, both from
 * `docs/ai-workflow/event-lifecycle-plan.md`:
 *
 * **Derive, never retype.** There is no local, data or hora. Those are the event's, and the page
 * renders them from there. A copy is the bug where the poster says 16:00 and the event says 17:00.
 *
 * **A to-do that means "raise a requerimento" links to the one it produced.**
 * `raiseRequirementFromTodo` is the whole point of the slice: the line stops being something
 * somebody has to remember to act on, and becomes the requerimento.
 */

export type EventPlan = {
  eventId: number;
  objetivo: string | null;
  estrutura: string | null;
  coordinatorName: string | null;
  coordinatorIstid: string | null;
  /** The owning team may write it; a collaborating team may only read (#219). */
  canEdit: boolean;
  updatedAt: string;
};

export type PlanExternal = {
  id: number;
  kind: "orador" | "patrocinio" | "parceiro" | "outro";
  name: string;
  detail: string | null;
};

export type PlanTodo = {
  id: number;
  task: string;
  assigneeName: string | null;
  assigneeIstid: string | null;
  done: boolean;
  doneByName: string | null;
  /** Set once this to-do has been turned into a requerimento. */
  requirementId: number | null;
  requirementTeam: string | null;
  requirementStatus: string | null;
};

export const getEventPlan = async (
  eventId: number,
  departmentName: string
): Promise<EventPlan | null> => {
  const { rows } = await db_query<{
    event_id: number;
    objetivo: string | null;
    estrutura: string | null;
    coordinator_name: string | null;
    coordinator_istid: string | null;
    can_edit: boolean;
    updated_at: string;
  }>("SELECT * FROM neiist.get_event_plan($1::INT, $2::VARCHAR(30))", [eventId, departmentName]);

  const row = rows[0];
  return row
    ? {
        eventId: row.event_id,
        objetivo: row.objetivo,
        estrutura: row.estrutura,
        coordinatorName: row.coordinator_name,
        coordinatorIstid: row.coordinator_istid,
        canEdit: row.can_edit,
        updatedAt: row.updated_at,
      }
    : null;
};

export const upsertEventPlan = async (
  eventId: number,
  objetivo: string | null,
  estrutura: string | null,
  coordinatorIstid: string | null,
  actorIstid: string,
  team: string
): Promise<void> => {
  await db_query(
    `SELECT neiist.upsert_event_plan($1::INT, $2::TEXT, $3::TEXT, $4::VARCHAR(50),
       $5::VARCHAR(50), $6::VARCHAR(30))`,
    [eventId, objetivo, estrutura, coordinatorIstid, actorIstid, team]
  );
};

export const getPlanCollaborators = async (eventId: number, departmentName: string) => {
  const { rows } = await db_query<{ istid: string; name: string }>(
    "SELECT * FROM neiist.get_plan_collaborators($1::INT, $2::VARCHAR(30))",
    [eventId, departmentName]
  );
  return rows;
};

/** SQL refuses anyone who is not on the owning team — a plan must not list work nobody owns. */
export const setPlanCollaborator = async (
  eventId: number,
  istid: string,
  add: boolean,
  team: string
): Promise<void> => {
  await db_query(
    "SELECT neiist.set_plan_collaborator($1::INT, $2::VARCHAR(50), $3::BOOLEAN, $4::VARCHAR(30))",
    [eventId, istid, add, team]
  );
};

export const getPlanExternals = async (
  eventId: number,
  departmentName: string
): Promise<PlanExternal[]> => {
  const { rows } = await db_query<PlanExternal>(
    "SELECT * FROM neiist.get_plan_externals($1::INT, $2::VARCHAR(30))",
    [eventId, departmentName]
  );
  return rows;
};

export const addPlanExternal = async (
  eventId: number,
  kind: PlanExternal["kind"],
  name: string,
  detail: string | null,
  team: string
): Promise<number> => {
  const { rows } = await db_query<{ add_plan_external: number }>(
    "SELECT neiist.add_plan_external($1::INT, $2::TEXT, $3::TEXT, $4::TEXT, $5::VARCHAR(30))",
    [eventId, kind, name, detail, team]
  );
  return rows[0].add_plan_external;
};

export const removePlanExternal = async (id: number, team: string): Promise<void> => {
  await db_query("SELECT neiist.remove_plan_external($1::INT, $2::VARCHAR(30))", [id, team]);
};

export const getPlanTodos = async (
  eventId: number,
  departmentName: string
): Promise<PlanTodo[]> => {
  const { rows } = await db_query<{
    id: number;
    task: string;
    assignee_name: string | null;
    assignee_istid: string | null;
    done: boolean;
    done_by_name: string | null;
    requirement_id: number | null;
    requirement_team: string | null;
    requirement_status: string | null;
  }>("SELECT * FROM neiist.get_plan_todos($1::INT, $2::VARCHAR(30))", [eventId, departmentName]);

  return rows.map((row) => ({
    id: row.id,
    task: row.task,
    assigneeName: row.assignee_name,
    assigneeIstid: row.assignee_istid,
    done: row.done,
    doneByName: row.done_by_name,
    requirementId: row.requirement_id,
    requirementTeam: row.requirement_team,
    requirementStatus: row.requirement_status,
  }));
};

export const addPlanTodo = async (
  eventId: number,
  task: string,
  assigneeIstid: string | null,
  team: string
): Promise<number> => {
  const { rows } = await db_query<{ add_plan_todo: number }>(
    "SELECT neiist.add_plan_todo($1::INT, $2::TEXT, $3::VARCHAR(50), $4::VARCHAR(30))",
    [eventId, task, assigneeIstid, team]
  );
  return rows[0].add_plan_todo;
};

export const setPlanTodoDone = async (
  todoId: number,
  done: boolean,
  actorIstid: string,
  team: string
): Promise<void> => {
  await db_query(
    "SELECT neiist.set_plan_todo_done($1::INT, $2::BOOLEAN, $3::VARCHAR(50), $4::VARCHAR(30))",
    [todoId, done, actorIstid, team]
  );
};

/** SQL refuses a to-do that already produced a requerimento — cancel that first. */
export const removePlanTodo = async (todoId: number, team: string): Promise<void> => {
  await db_query("SELECT neiist.remove_plan_todo($1::INT, $2::VARCHAR(30))", [todoId, team]);
};

/**
 * Turn a to-do into the requerimento it describes, atomically.
 *
 * The function this slice exists for. It delegates to `raise_requirements` rather than
 * reimplementing, so slice A's rules — the event must be the requesting team's, no requerimento to
 * yourself — hold without a second copy of them.
 */
export const raiseRequirementFromTodo = async (
  todoId: number,
  targetDepartment: string,
  title: string,
  detail: string | null,
  deadline: string | null,
  actorIstid: string,
  team: string
): Promise<number> => {
  const { rows } = await db_query<{ raise_requirement_from_todo: number }>(
    `SELECT neiist.raise_requirement_from_todo($1::INT, $2::VARCHAR(30), $3::TEXT, $4::TEXT,
       $5::TIMESTAMPTZ, $6::VARCHAR(50), $7::VARCHAR(30))`,
    [todoId, targetDepartment, title, detail, deadline, actorIstid, team]
  );
  return rows[0].raise_requirement_from_todo;
};
