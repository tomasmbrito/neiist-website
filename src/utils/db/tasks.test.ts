import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTask,
  deleteTask,
  getTaskOwner,
  getTeamTasks,
  getUserTasks,
  setTaskAssignee,
  setTaskStatus,
} from "@/utils/db/taskQueries";
import { createInternalEvent, getEventAttendees } from "@/utils/db/eventQueries";

/**
 * #130 Phase 2 — tasks, against the real database.
 *
 * The two properties worth pinning are the ones that are easy to get wrong and invisible when
 * they are: a task must not be reachable from another team, and "my tasks" must stop being mine
 * when I leave the team — being *assigned* is not the same as still belonging.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM_A = "Fotografia";
const TEAM_B = "Visuais";
const AUTHOR = "ist9998101";
const HELPER = "ist9998102"; // member of TEAM_A
const OUTSIDER = "ist9998103"; // a real account with NO membership — the shop customer

let owner: Client;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  for (const [istid, name] of [
    [AUTHOR, "Task Author"],
    [HELPER, "Task Helper"],
    [OUTSIDER, "Shop Customer"],
  ]) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), $2, $3)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, name, `${istid}@tecnico.ulisboa.pt`]
    );
  }
  // OUTSIDER deliberately gets none.
  for (const istid of [AUTHOR, HELPER]) {
    await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, 'Membro')", [
      istid,
      TEAM_A,
    ]);
  }
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.tasks WHERE created_by_istid = $1", [AUTHOR]);
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [
    [AUTHOR, HELPER, OUTSIDER],
  ]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [[AUTHOR, HELPER, OUTSIDER]]);
  await owner.end();
});

const make = (over: Partial<Parameters<typeof createTask>[0]> = {}) =>
  createTask({
    title: "Fazer os cartazes",
    departmentName: TEAM_A,
    createdByIstid: AUTHOR,
    ...over,
  });

describe("creating tasks", () => {
  it("writes the task and its assignees in one call", async () => {
    const id = await make({ assignees: [AUTHOR, HELPER], dueAt: inDays(7) });
    const task = (await getTeamTasks(TEAM_A)).find((candidate) => candidate.id === id);
    expect(task).toBeDefined();
    expect(task!.assignees.map((person) => person.istid).sort()).toEqual([AUTHOR, HELPER].sort());
    expect(task!.status).toBe("not_started");
  });

  it("refuses a blank title and an unknown status", async () => {
    await expect(make({ title: "   " })).rejects.toMatchObject({ code: "NEI16" });
    await expect(make({ status: "pending" as unknown as "done" })).rejects.toMatchObject({
      code: "NEI16",
    });
  });

  it("refuses an unknown team", async () => {
    await expect(make({ departmentName: "ZZ Nope" })).rejects.toMatchObject({ code: "NEI17" });
  });

  it("drops an assignee who is not a NEIIST member", async () => {
    // Same rule as event attendance (#208): accepting any existing istid would make this a
    // directory oracle over every account, shop customers included.
    const id = await make({ assignees: [AUTHOR, OUTSIDER] });
    const task = (await getTeamTasks(TEAM_A)).find((candidate) => candidate.id === id);
    expect(task!.assignees.map((person) => person.istid)).toEqual([AUTHOR]);
  });

  it("refuses assigning a non-member afterwards too", async () => {
    const id = await make();
    await expect(setTaskAssignee(id, OUTSIDER, true)).rejects.toMatchObject({ code: "NEI17" });
  });
});

describe("tasks and events", () => {
  it("links a task to an event of the same team", async () => {
    const eventId = await createInternalEvent({
      kind: "meeting",
      name: "Reunião",
      startsAt: inDays(2),
      isPublic: false,
      departmentName: TEAM_A,
      createdByIstid: AUTHOR,
    });
    const id = await make({ eventId });
    const task = (await getTeamTasks(TEAM_A)).find((candidate) => candidate.id === id);
    expect(task!.eventId).toBe(eventId);
    expect(task!.eventName).toBe("Reunião");
  });

  it("refuses linking to ANOTHER team's event", async () => {
    // Otherwise one team's board would name another team's internal meeting — the boundary #129
    // spent three slices holding.
    const otherEvent = await createInternalEvent({
      kind: "meeting",
      name: "Interno dos Visuais",
      startsAt: inDays(2),
      isPublic: false,
      departmentName: TEAM_B,
      createdByIstid: AUTHOR,
    });
    await expect(make({ eventId: otherEvent })).rejects.toMatchObject({ code: "NEI17" });
  });
});

describe("team scoping", () => {
  it("returns only the named team's tasks", async () => {
    await make({ title: "Da Fotografia", departmentName: TEAM_A });
    await make({ title: "Dos Visuais", departmentName: TEAM_B });
    const a = await getTeamTasks(TEAM_A);
    expect(a.some((task) => task.title === "Da Fotografia")).toBe(true);
    expect(a.some((task) => task.title === "Dos Visuais")).toBe(false);
  });

  it("reports the owning team from the row, for authorizing a mutation", async () => {
    const id = await make({ departmentName: TEAM_B });
    expect(await getTaskOwner(id)).toBe(TEAM_B);
    expect(await getTaskOwner(999_999_999)).toBeNull();
  });
});

describe("my tasks", () => {
  it("shows tasks assigned to me in teams I belong to", async () => {
    const id = await make({ assignees: [HELPER] });
    expect((await getUserTasks(HELPER)).some((task) => task.id === id)).toBe(true);
  });

  it("does NOT show tasks I was never assigned", async () => {
    const id = await make({ assignees: [AUTHOR] });
    expect((await getUserTasks(HELPER)).some((task) => task.id === id)).toBe(false);
  });

  it("stops showing them when I leave the team, even though I am still assigned", async () => {
    // Being assigned is necessary but not sufficient. Without the scope check, an ex-member would
    // keep reading a team's tasks because somebody once assigned them one.
    const id = await make({ assignees: [HELPER] });
    expect((await getUserTasks(HELPER)).some((task) => task.id === id)).toBe(true);

    await owner.query("UPDATE neiist.membership SET to_date = CURRENT_DATE WHERE user_istid = $1", [
      HELPER,
    ]);
    expect((await getUserTasks(HELPER)).some((task) => task.id === id)).toBe(false);

    await owner.query("UPDATE neiist.membership SET to_date = NULL WHERE user_istid = $1", [
      HELPER,
    ]);
  });
});

describe("status", () => {
  it("stamps completed_at when done, and clears it when reopened", async () => {
    // Derived by trigger, never passed in — a caller cannot claim a completion time, and cannot
    // forget to set one.
    const id = await make();
    expect((await getTeamTasks(TEAM_A)).find((t) => t.id === id)!.completedAt).toBeNull();

    await setTaskStatus(id, "done");
    expect((await getTeamTasks(TEAM_A)).find((t) => t.id === id)!.completedAt).not.toBeNull();

    await setTaskStatus(id, "in_progress");
    expect((await getTeamTasks(TEAM_A)).find((t) => t.id === id)!.completedAt).toBeNull();
  });

  it("refuses an unknown status", async () => {
    const id = await make();
    await expect(setTaskStatus(id, "cancelled" as unknown as "done")).rejects.toMatchObject({
      code: "NEI16",
    });
  });

  it("raises for a task that does not exist", async () => {
    await expect(setTaskStatus(999_999_999, "done")).rejects.toMatchObject({ code: "NEI17" });
  });
});

describe("deletion", () => {
  it("removes the task and its assignees", async () => {
    const id = await make({ assignees: [AUTHOR] });
    await deleteTask(id);
    expect((await getTeamTasks(TEAM_A)).some((task) => task.id === id)).toBe(false);
    const orphans = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.task_assignees WHERE task_id = $1",
      [id]
    );
    expect(orphans.rows[0].n).toBe(0);
  });

  it("survives its linked event being deleted", async () => {
    // ON DELETE SET NULL, not CASCADE: deleting a meeting must not silently delete the work that
    // came out of it.
    const eventId = await createInternalEvent({
      kind: "meeting",
      name: "Reunião",
      startsAt: inDays(2),
      isPublic: false,
      departmentName: TEAM_A,
      createdByIstid: AUTHOR,
    });
    const id = await make({ eventId });
    await owner.query("DELETE FROM neiist.internal_events WHERE id = $1", [eventId]);

    const task = (await getTeamTasks(TEAM_A)).find((candidate) => candidate.id === id);
    expect(task).toBeDefined();
    expect(task!.eventId).toBeNull();
  });
});

describe("the attendee oracle is closed on the CREATE path too", () => {
  it("drops a non-member passed to createInternalEvent", async () => {
    // #208 tightened `set_event_attendance` and left `create_internal_event` joining
    // `neiist.users`, so the same directory harvest worked by creating a meeting with candidate
    // istids. One rule, two write paths, one fixed.
    const eventId = await createInternalEvent({
      kind: "meeting",
      name: "Reunião",
      startsAt: inDays(2),
      isPublic: false,
      departmentName: TEAM_A,
      createdByIstid: AUTHOR,
      attendees: [AUTHOR, OUTSIDER],
    });
    const attendees = await getEventAttendees(eventId, TEAM_A);
    expect(attendees.map((person) => person.userIstid)).toEqual([AUTHOR]);
  });
});
