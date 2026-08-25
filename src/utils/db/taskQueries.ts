import { db_query } from "@/utils/db/dbClient";

/**
 * Tasks (#130, Phase 2).
 *
 * **A sixth module rather than more of `eventQueries.ts`**, per CLAUDE.md §4: "Add a query to the
 * module that owns its domain. If it fits none of them, that is a signal to add a sixth module,
 * not to widen an existing one." `eventQueries.ts` is already carrying activities, the Notion
 * bridge and all of #129; tasks are their own domain and relate to events by an optional FK, not
 * by belonging to them.
 *
 * Two rules hold here, both inherited from #129 deliberately:
 *
 *  - **Every reader takes a department, or is keyed to one person's own scopes.** There is no
 *    "all tasks" function, so a caller cannot receive another team's by omitting a filter.
 *  - **Errors throw.** The SQL raises NEI16/NEI17 with messages written to be read; swallowing
 *    them would turn "that event is not your team's" into a generic 500.
 */
export type TaskStatus = "not_started" | "in_progress" | "done";

export type TaskAssignee = { istid: string; name: string };

export type TeamTask = {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  dueAt: string | null;
  eventId: number | null;
  eventName: string | null;
  createdByIstid: string;
  completedAt: string | null;
  assignees: TaskAssignee[];
};

/** A task as the member dashboard shows it: what, when, and which team it belongs to. */
export type UserTask = {
  id: number;
  title: string;
  status: TaskStatus;
  dueAt: string | null;
  departmentName: string;
  eventId: number | null;
  eventName: string | null;
};

export const createTask = async (input: {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  dueAt?: string | null;
  departmentName: string;
  eventId?: number | null;
  createdByIstid: string;
  assignees?: string[];
}): Promise<number> => {
  const { rows } = await db_query<{ create_task: number }>(
    `SELECT neiist.create_task(
       $1::TEXT, $2::TEXT, $3::TEXT, $4::TIMESTAMPTZ, $5::VARCHAR(30), $6::INT,
       $7::VARCHAR(50), $8::VARCHAR(50)[]
     )`,
    [
      input.title,
      input.description ?? null,
      input.status ?? "not_started",
      input.dueAt ?? null,
      input.departmentName,
      input.eventId ?? null,
      input.createdByIstid,
      input.assignees ?? [],
    ]
  );
  return rows[0].create_task;
};

export const getTeamTasks = async (departmentName: string): Promise<TeamTask[]> => {
  const { rows } = await db_query<{
    id: number;
    title: string;
    description: string | null;
    status: TaskStatus;
    due_at: string | null;
    event_id: number | null;
    event_name: string | null;
    created_by_istid: string;
    completed_at: string | null;
    assignees: TaskAssignee[];
  }>("SELECT * FROM neiist.get_team_tasks($1::VARCHAR(30))", [departmentName]);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: row.due_at,
    eventId: row.event_id,
    eventName: row.event_name,
    createdByIstid: row.created_by_istid,
    completedAt: row.completed_at,
    // jsonb_agg already returns parsed JSON through `pg`; the coalesce in SQL guarantees an array.
    assignees: row.assignees,
  }));
};

/**
 * "My tasks", across every team this person belongs to.
 *
 * Being assigned is necessary but **not sufficient**: the SQL also requires a live scope in the
 * owning team, so someone who has left keeps nothing because a task was once assigned to them.
 */
export const getUserTasks = async (istid: string): Promise<UserTask[]> => {
  const { rows } = await db_query<{
    id: number;
    title: string;
    status: TaskStatus;
    due_at: string | null;
    department_name: string;
    event_id: number | null;
    event_name: string | null;
  }>("SELECT * FROM neiist.get_user_tasks($1::VARCHAR(50))", [istid]);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    dueAt: row.due_at,
    departmentName: row.department_name,
    eventId: row.event_id,
    eventName: row.event_name,
  }));
};

/** Which team owns this task — read before any mutation, so authorization uses the row's owner. */
export const getTaskOwner = async (taskId: number): Promise<string | null> => {
  const { rows } = await db_query<{ get_task_owner: string | null }>(
    "SELECT neiist.get_task_owner($1::INT)",
    [taskId]
  );
  return rows[0]?.get_task_owner ?? null;
};

export const setTaskStatus = async (taskId: number, status: TaskStatus): Promise<void> => {
  await db_query("SELECT neiist.set_task_status($1::INT, $2::TEXT)", [taskId, status]);
};

export const setTaskAssignee = async (
  taskId: number,
  istid: string,
  assign: boolean
): Promise<void> => {
  await db_query("SELECT neiist.set_task_assignee($1::INT, $2::VARCHAR(50), $3::BOOLEAN)", [
    taskId,
    istid,
    assign,
  ]);
};

export const deleteTask = async (taskId: number): Promise<void> => {
  await db_query("SELECT neiist.delete_task($1::INT)", [taskId]);
};
