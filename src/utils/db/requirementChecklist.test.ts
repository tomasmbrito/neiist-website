import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * #242 — the shared checklist, the To-do List from the Notion protocol.
 *
 * Every one of the five brief templates ends with one, under the same instruction:
 *
 *   Para quem faz o requerimento: colocar na To-do List o que se espera receber.
 *   Para quem recebe: ir atualizando consoante o que já foi feito.
 *
 * So the asymmetry is not a detail, it IS the feature: **the requester says what is expected, the
 * doer says what is done.** Collapsing that into "anyone can edit the list" would turn a contract
 * between two teams into a shared scratchpad, and it is the same inversion #232 refuses when it
 * stops the requester marking its own request done.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const ASKER = "Organização de Eventos";
const DOER = "Visuais";
const THIRD = "Fotografia";
const AUTHOR = "ist9994901";
const DOER_MEMBER = "ist9994902";
const PEOPLE = [AUTHOR, DOER_MEMBER];

let owner: Client;
let eventId = 0;
let requirementId = 0;

const add = (item: string, team = ASKER, source = "manual", key: string | null = null) =>
  owner.query<{ add_checklist_item: number }>(
    `SELECT neiist.add_checklist_item($1::INT, $2::TEXT, $3::VARCHAR(30), $4::TEXT, $5::TEXT)`,
    [requirementId, item, team, source, key]
  );

const tick = (id: number, done: boolean, team = DOER) =>
  owner.query(
    "SELECT neiist.set_checklist_item_done($1::INT, $2::BOOLEAN, $3::VARCHAR(50), $4::VARCHAR(30))",
    [id, done, DOER_MEMBER, team]
  );

const list = async (team = ASKER) => {
  const { rows } = await owner.query<{
    id: number;
    item: string;
    done: boolean;
    done_by_name: string | null;
    source: string;
  }>("SELECT * FROM neiist.get_requirement_checklist($1::INT, $2::VARCHAR(30))", [
    requirementId,
    team,
  ]);
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
});

beforeEach(async () => {
  const ev = await owner.query<{ id: number }>(
    `SELECT neiist.create_internal_event('event', 'ZZ Evento Checklist', NULL,
       NOW() + INTERVAL '20 days', NULL, FALSE, $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
    [ASKER, AUTHOR]
  );
  eventId = ev.rows[0].id;
  await owner.query(
    `SELECT neiist.raise_requirements($1::INT, $2::VARCHAR(30), $3::VARCHAR(30)[],
       $4::TEXT[], $5::TEXT[], $6::TIMESTAMPTZ[], $7::VARCHAR(50))`,
    [eventId, ASKER, [DOER], ["Cartazes"], [null], [null], AUTHOR]
  );
  const req = await owner.query<{ id: number }>(
    "SELECT id FROM neiist.requirements WHERE event_id = $1",
    [eventId]
  );
  requirementId = req.rows[0].id;
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE name = 'ZZ Evento Checklist'");
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = ANY($1)", [
    PEOPLE,
  ]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [PEOPLE]);
  await owner.end();
});

describe("the requester says what is expected", () => {
  it("lets the requesting team add items", async () => {
    await add("Cartaz A3");
    await add("Stories Instagram");
    expect((await list()).map((r) => r.item)).toEqual(["Cartaz A3", "Stories Instagram"]);
  });

  it("REFUSES the target team adding to it", async () => {
    // Otherwise Visuais decides what Organização de Eventos asked for.
    await expect(add("Faço só o cartaz", DOER)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("refuses a third team entirely", async () => {
    await expect(add("Nada a ver", THIRD)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("refuses a blank item", async () => {
    await expect(add("   ")).rejects.toMatchObject({ code: "NEI19" });
  });

  it("keeps the order they were added in", async () => {
    for (const item of ["Cartaz A3", "Cartaz A4", "Stories"]) await add(item);
    expect((await list()).map((r) => r.item)).toEqual(["Cartaz A3", "Cartaz A4", "Stories"]);
  });
});

describe("the doer says what is done", () => {
  it("lets the target team tick, recording who and when", async () => {
    const { rows } = await add("Cartaz A3");
    await tick(rows[0].add_checklist_item, true);

    const [item] = await list();
    expect(item.done).toBe(true);
    expect(item.done_by_name).toBeTruthy();
  });

  it("REFUSES the requesting team ticking its own request", async () => {
    // The mirror of #232: the requester may not mark somebody else's work finished.
    const { rows } = await add("Cartaz A3");
    await expect(tick(rows[0].add_checklist_item, true, ASKER)).rejects.toMatchObject({
      code: "NEI21",
    });
  });

  it("clears who and when on untick", async () => {
    const { rows } = await add("Cartaz A3");
    const id = rows[0].add_checklist_item;
    await tick(id, true);
    await tick(id, false);

    const [item] = await list();
    expect(item.done).toBe(false);
    expect(item.done_by_name).toBeNull();
  });
});

describe("brief items versus manual items", () => {
  it("does not duplicate when the same brief option is regenerated", async () => {
    await add("Cartaz A3", ASKER, "brief", "formato:cartaz_a3");
    await add("Cartaz A3", ASKER, "brief", "formato:cartaz_a3");
    expect(await list()).toHaveLength(1);
  });

  it("keeps work done when a brief item is regenerated", async () => {
    // Regeneration updates the text; it must not quietly un-tick something already finished.
    const { rows } = await add("Cartaz A3", ASKER, "brief", "formato:cartaz_a3");
    await tick(rows[0].add_checklist_item, true);
    await add("Cartaz A3 (bilingue)", ASKER, "brief", "formato:cartaz_a3");

    const [item] = await list();
    expect(item.item).toBe("Cartaz A3 (bilingue)");
    expect(item.done).toBe(true);
  });

  it("prunes only the brief items an option no longer selects", async () => {
    await add("Cartaz A3", ASKER, "brief", "formato:cartaz_a3");
    await add("Stories", ASKER, "brief", "formato:stories");
    await add("Falar com o orador", ASKER); // manual

    await owner.query("SELECT neiist.prune_brief_checklist_items($1::INT, $2::TEXT[])", [
      requirementId,
      ["formato:cartaz_a3"],
    ]);

    // The manual note survives. That is the entire reason `source` exists.
    expect((await list()).map((r) => r.item).sort()).toEqual(
      ["Cartaz A3", "Falar com o orador"].sort()
    );
  });

  it("removes every brief item when the brief selects nothing", async () => {
    await add("Cartaz A3", ASKER, "brief", "formato:cartaz_a3");
    await add("Nota", ASKER);
    await owner.query("SELECT neiist.prune_brief_checklist_items($1::INT, $2::TEXT[])", [
      requirementId,
      [],
    ]);
    expect((await list()).map((r) => r.item)).toEqual(["Nota"]);
  });

  it("refuses to delete a brief item by hand", async () => {
    // Deleting it here would put the checklist and the brief in disagreement until the next
    // regeneration silently brought it back.
    const { rows } = await add("Cartaz A3", ASKER, "brief", "formato:cartaz_a3");
    await expect(
      owner.query("SELECT neiist.remove_checklist_item($1::INT, $2::VARCHAR(30))", [
        rows[0].add_checklist_item,
        ASKER,
      ])
    ).rejects.toMatchObject({ code: "NEI19" });
  });

  it("lets the requester delete a manual item", async () => {
    const { rows } = await add("Enganei-me");
    await owner.query("SELECT neiist.remove_checklist_item($1::INT, $2::VARCHAR(30))", [
      rows[0].add_checklist_item,
      ASKER,
    ]);
    expect(await list()).toEqual([]);
  });

  it("refuses the target team deleting anything", async () => {
    const { rows } = await add("Cartaz A3");
    await expect(
      owner.query("SELECT neiist.remove_checklist_item($1::INT, $2::VARCHAR(30))", [
        rows[0].add_checklist_item,
        DOER,
      ])
    ).rejects.toMatchObject({ code: "NEI21" });
  });
});

describe("who can see it", () => {
  it("shows it to BOTH teams", async () => {
    // The point of a shared list is that it is shared: the asker sees progress without asking.
    await add("Cartaz A3");
    expect(await list(ASKER)).toHaveLength(1);
    expect(await list(DOER)).toHaveLength(1);
  });

  it("shows NOTHING to a third team", async () => {
    await add("Cartaz A3");
    expect(await list(THIRD)).toEqual([]);
  });
});

describe("progress in the list", () => {
  it("reports total and done, so the inbox can say 1/2 rather than 'em curso'", async () => {
    const first = await add("Cartaz A3");
    await add("Stories");
    await tick(first.rows[0].add_checklist_item, true);

    const { rows } = await owner.query<{ checklist_total: number; checklist_done: number }>(
      "SELECT checklist_total, checklist_done FROM neiist.get_team_requirements($1::VARCHAR(30)) WHERE id = $2",
      [DOER, requirementId]
    );
    expect(rows[0]).toMatchObject({ checklist_total: 2, checklist_done: 1 });
  });

  it("reports zero for a requerimento with no checklist", async () => {
    const { rows } = await owner.query<{ checklist_total: number; checklist_done: number }>(
      "SELECT checklist_total, checklist_done FROM neiist.get_team_requirements($1::VARCHAR(30)) WHERE id = $2",
      [DOER, requirementId]
    );
    expect(rows[0]).toMatchObject({ checklist_total: 0, checklist_done: 0 });
  });
});
