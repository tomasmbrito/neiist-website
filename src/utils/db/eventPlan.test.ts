import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * #247 — the Plano de Atividades, the document above the requerimentos.
 *
 * Found in the Organização de Eventos Drive: every event folder holds one, and it is what the team
 * writes FIRST. Two properties carry the slice, and both come straight from the real plans:
 *
 *  1. **A to-do that means "raise a requerimento" links to the one it produced.** In Drive that
 *     line reads "Fazer o requerimento de visuais — Guilherme Carreira" and somebody has to
 *     remember to act on it. Here it becomes the requerimento, with the to-do pointing at it: one
 *     thing in two states, not two lists of the same intent.
 *  2. **Derive, never retype.** The plan stores no local, data or hora — those are the event's. A
 *     copy is the bug where the poster says 16:00 and the event says 17:00.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const OWNER = "Organização de Eventos";
const HELPER = "Visuais";
const THIRD = "Contacto";
const AUTHOR = "ist9995001";
const MEMBER = "ist9995002";
const OUTSIDER = "ist9995003";
const PEOPLE = [AUTHOR, MEMBER, OUTSIDER];

let owner: Client;
let eventId = 0;

const plan = (objetivo = "Ensinar Linux", coordinator: string | null = AUTHOR, team = OWNER) =>
  owner.query(
    `SELECT neiist.upsert_event_plan($1::INT, $2::TEXT, 'Estrutura', $3::VARCHAR(50),
       $4::VARCHAR(50), $5::VARCHAR(30))`,
    [eventId, objetivo, coordinator, AUTHOR, team]
  );

const todo = (task: string, assignee: string | null = MEMBER, team = OWNER) =>
  owner.query<{ add_plan_todo: number }>(
    "SELECT neiist.add_plan_todo($1::INT, $2::TEXT, $3::VARCHAR(50), $4::VARCHAR(30))",
    [eventId, task, assignee, team]
  );

const todos = async (team = OWNER) => {
  const { rows } = await owner.query<{
    id: number;
    task: string;
    assignee_name: string | null;
    done: boolean;
    requirement_id: number | null;
    requirement_team: string | null;
    requirement_status: string | null;
  }>("SELECT * FROM neiist.get_plan_todos($1::INT, $2::VARCHAR(30))", [eventId, team]);
  return rows;
};

const readPlan = async (team = OWNER) => {
  const { rows } = await owner.query<{
    objetivo: string | null;
    coordinator_name: string | null;
    can_edit: boolean;
  }>("SELECT * FROM neiist.get_event_plan($1::INT, $2::VARCHAR(30))", [eventId, team]);
  return rows;
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  for (const istid of PEOPLE) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), 'Pessoa', $2)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, `${istid}@tecnico.ulisboa.pt`]
    );
  }
  const join = (istid: string, department: string) =>
    owner.query(
      `INSERT INTO neiist.membership (user_istid, department_name, role_name, from_date)
       VALUES ($1, $2, 'Membro', CURRENT_DATE) ON CONFLICT DO NOTHING`,
      [istid, department]
    );
  await join(AUTHOR, OWNER);
  await join(MEMBER, OWNER);
  await join(OUTSIDER, HELPER);
});

beforeEach(async () => {
  const { rows } = await owner.query<{ id: number }>(
    `SELECT neiist.create_internal_event('event', 'ZZ Evento Plano', NULL,
       NOW() + INTERVAL '30 days', NULL, FALSE, $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
    [OWNER, AUTHOR]
  );
  eventId = rows[0].id;
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE name = 'ZZ Evento Plano'");
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [PEOPLE]);
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = ANY($1)", [
    PEOPLE,
  ]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [PEOPLE]);
  await owner.end();
});

describe("writing the plan", () => {
  it("creates and then updates in place", async () => {
    await plan("Ensinar Linux");
    await plan("Ensinar Linux, e instalar");
    const rows = await readPlan();
    expect(rows).toHaveLength(1);
    expect(rows[0].objetivo).toBe("Ensinar Linux, e instalar");
  });

  it("REFUSES a team that does not own the event", async () => {
    await expect(plan("Ensinar Linux", AUTHOR, HELPER)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("refuses an event that does not exist", async () => {
    await expect(
      owner.query(
        `SELECT neiist.upsert_event_plan(999999, 'x', 'y', NULL, $1::VARCHAR(50), $2::VARCHAR(30))`,
        [AUTHOR, OWNER]
      )
    ).rejects.toMatchObject({ code: "NEI15" });
  });

  it("stores no local, data or hora — those are the event's", async () => {
    // Rule R1. A copy is the bug where the poster says 16:00 and the event says 17:00.
    const { rows } = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'neiist' AND table_name = 'event_plans'`
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).not.toContain("local");
    expect(columns).not.toContain("starts_at");
    expect(columns).not.toContain("data");
  });
});

describe("colaboradores responsáveis", () => {
  const setCollaborator = (istid: string, add: boolean, team = OWNER) =>
    owner.query(
      "SELECT neiist.set_plan_collaborator($1::INT, $2::VARCHAR(50), $3::BOOLEAN, $4::VARCHAR(30))",
      [eventId, istid, add, team]
    );

  it("adds somebody from the owning team", async () => {
    await plan();
    await setCollaborator(MEMBER, true);
    const { rows } = await owner.query(
      "SELECT * FROM neiist.get_plan_collaborators($1::INT, $2::VARCHAR(30))",
      [eventId, OWNER]
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses somebody who is not on the owning team", async () => {
    // A plan listing them would list work nobody there owns.
    await plan();
    await expect(setCollaborator(OUTSIDER, true)).rejects.toMatchObject({ code: "NEI19" });
  });

  it("refuses another team editing the list", async () => {
    await plan();
    await expect(setCollaborator(MEMBER, true, HELPER)).rejects.toMatchObject({ code: "NEI21" });
  });
});

describe("the to-dos", () => {
  it("records an assignee, as the real plans do", async () => {
    await plan();
    await todo("Fazer a reserva de espaços do tagus");
    expect((await todos())[0].assignee_name).toBeTruthy();
  });

  it("refuses an assignee who is not on the owning team", async () => {
    await plan();
    await expect(todo("Qualquer coisa", OUTSIDER)).rejects.toMatchObject({ code: "NEI19" });
  });

  it("sorts open before done", async () => {
    await plan();
    const first = await todo("Primeiro");
    await todo("Segundo");
    await owner.query(
      "SELECT neiist.set_plan_todo_done($1::INT, TRUE, $2::VARCHAR(50), $3::VARCHAR(30))",
      [first.rows[0].add_plan_todo, AUTHOR, OWNER]
    );
    expect((await todos()).map((t) => t.task)).toEqual(["Segundo", "Primeiro"]);
  });

  it("refuses another team adding or ticking", async () => {
    await plan();
    await expect(todo("Nada", MEMBER, HELPER)).rejects.toMatchObject({ code: "NEI21" });
  });
});

describe("a to-do becomes a requerimento — the point of the slice", () => {
  const raise = (todoId: number, target = HELPER, team = OWNER) =>
    owner.query<{ raise_requirement_from_todo: number }>(
      `SELECT neiist.raise_requirement_from_todo($1::INT, $2::VARCHAR(30), $3::TEXT, $4::TEXT,
         $5::TIMESTAMPTZ, $6::VARCHAR(50), $7::VARCHAR(30))`,
      [todoId, target, "Cartaz e stories", "Briefing", null, AUTHOR, team]
    );

  it("raises the requerimento and links the to-do to it", async () => {
    await plan();
    const { rows } = await todo("Fazer o requerimento de visuais");
    const created = await raise(rows[0].add_plan_todo);

    const [item] = await todos();
    expect(item.requirement_id).toBe(created.rows[0].raise_requirement_from_todo);
    expect(item.requirement_team).toBe(HELPER);
    expect(item.requirement_status).toBe("requested");
  });

  it("marks the to-do done — the intention WAS to raise it", async () => {
    // Whether the work lands is the requerimento's own status to carry, not the plan's.
    await plan();
    const { rows } = await todo("Fazer o requerimento de visuais");
    await raise(rows[0].add_plan_todo);
    expect((await todos())[0].done).toBe(true);
  });

  it("refuses to raise twice from the same to-do", async () => {
    await plan();
    const { rows } = await todo("Fazer o requerimento de visuais");
    await raise(rows[0].add_plan_todo);
    await expect(raise(rows[0].add_plan_todo)).rejects.toMatchObject({ code: "NEI19" });
  });

  it("refuses another team raising from this plan", async () => {
    await plan();
    const { rows } = await todo("Fazer o requerimento de visuais");
    await expect(raise(rows[0].add_plan_todo, THIRD, HELPER)).rejects.toMatchObject({
      code: "NEI21",
    });
  });

  it("refuses to delete a to-do that already produced a requerimento", async () => {
    // Another team is working from it now; cancelling is a conversation with them.
    await plan();
    const { rows } = await todo("Fazer o requerimento de visuais");
    await raise(rows[0].add_plan_todo);
    await expect(
      owner.query("SELECT neiist.remove_plan_todo($1::INT, $2::VARCHAR(30))", [
        rows[0].add_plan_todo,
        OWNER,
      ])
    ).rejects.toMatchObject({ code: "NEI19" });
  });

  it("still applies slice A's rules — no requerimento to yourself", async () => {
    // Delegates to raise_requirements rather than reimplementing, so its constraints hold.
    await plan();
    const { rows } = await todo("Requerimento a nós próprios");
    await expect(raise(rows[0].add_plan_todo, OWNER)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("who can read it", () => {
  it("lets a COLLABORATING team read it, but not edit", async () => {
    // A poster designer needs the objetivo. Making them ask by message is the coordination cost
    // this whole migration removes.
    await plan();
    await owner.query("SELECT neiist.set_event_collaborator($1::INT, $2::VARCHAR(30), TRUE)", [
      eventId,
      HELPER,
    ]);

    const rows = await readPlan(HELPER);
    expect(rows).toHaveLength(1);
    expect(rows[0].can_edit).toBe(false);
    expect((await readPlan(OWNER))[0].can_edit).toBe(true);
  });

  it("hides it from a collaborator when the owner narrows visibility to `owner`", async () => {
    await plan();
    await owner.query("SELECT neiist.set_event_collaborator($1::INT, $2::VARCHAR(30), TRUE)", [
      eventId,
      HELPER,
    ]);
    await owner.query("SELECT neiist.set_event_visibility($1::INT, 'owner')", [eventId]);
    expect(await readPlan(HELPER)).toEqual([]);
  });

  it("shows NOTHING to a third team", async () => {
    await plan();
    await todo("Segredo");
    expect(await readPlan(THIRD)).toEqual([]);
    expect(await todos(THIRD)).toEqual([]);
  });
});
