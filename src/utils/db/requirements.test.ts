import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * #232 — the requerimento lifecycle, slice A of #131.
 *
 * The Requerimento protocol is how NEIIST's teams work together: Organização de Eventos creates an
 * event, then raises a requerimento to each team it needs. Two properties carry the whole slice:
 *
 *  1. **Only the TARGET team owns the status.** The requesting team asked; letting it mark its own
 *     request `done` would make the status meaningless as a signal — Organização de Eventos could
 *     close a poster nobody drew.
 *  2. **A third team sees nothing**, because the WHERE clause cannot return it — not because a
 *     route remembered to check.
 *
 * Plus the one #131 states outright: creating an event with N requerimentos is atomic.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const ASKER = "Organização de Eventos";
const DOER = "Visuais";
const THIRD = "Fotografia";
const AUTHOR = "ist9994801";
const DOER_MEMBER = "ist9994802";
const OUTSIDER = "ist9994803";
const PEOPLE = [AUTHOR, DOER_MEMBER, OUTSIDER];

let owner: Client;
let eventId = 0;

const raise = (targets: string[], event = eventId, requesting = ASKER) =>
  owner.query<{ raise_requirements: number }>(
    `SELECT neiist.raise_requirements($1::INT, $2::VARCHAR(30), $3::VARCHAR(30)[],
       $4::TEXT[], $5::TEXT[], $6::TIMESTAMPTZ[], $7::VARCHAR(50))`,
    [
      event,
      requesting,
      targets,
      targets.map((t) => `Preciso de ${t}`),
      targets.map(() => "Briefing por escrever"),
      targets.map(() => new Date(Date.now() + 7 * 86_400_000).toISOString()),
      AUTHOR,
    ]
  );

const idsFor = async (department: string) => {
  const { rows } = await owner.query<{ id: number; direction: string; status: string }>(
    "SELECT id, direction, status FROM neiist.get_team_requirements($1::VARCHAR(30))",
    [department]
  );
  return rows;
};

const setStatus = (id: number, status: string, team: string) =>
  owner.query(
    "SELECT neiist.set_requirement_status($1::INT, $2::TEXT, $3::VARCHAR(50), $4::VARCHAR(30))",
    [id, status, AUTHOR, team]
  );

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
  await owner.query(
    `INSERT INTO neiist.membership (user_istid, department_name, role_name, from_date)
     VALUES ($1, $2, 'Membro', CURRENT_DATE) ON CONFLICT DO NOTHING`,
    [DOER_MEMBER, DOER]
  );
});

beforeEach(async () => {
  const { rows } = await owner.query<{ id: number }>(
    `SELECT neiist.create_internal_event('event', 'ZZ Evento Requerimentos', NULL,
       NOW() + INTERVAL '20 days', NULL, FALSE, $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
    [ASKER, AUTHOR]
  );
  eventId = rows[0].id;
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE name = 'ZZ Evento Requerimentos'");
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [PEOPLE]);
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = ANY($1)", [
    PEOPLE,
  ]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [PEOPLE]);
  await owner.end();
});

describe("raising them, atomically", () => {
  it("raises one requerimento per team in a single call", async () => {
    const { rows } = await raise([DOER, THIRD, "Divulgação"]);
    expect(rows[0].raise_requirements).toBe(3);
  });

  it("raises NOTHING when one team in the batch does not exist", async () => {
    // #131's stated criterion. An event needing a poster AND a campaign AND a photographer is one
    // decision — half of it landing means Visuais starts on something Divulgação never heard of,
    // and the person who submitted has no way to know which half took.
    await expect(raise([DOER, "Equipa Inexistente"])).rejects.toMatchObject({ code: "23503" });
    expect(await idsFor(DOER)).toHaveLength(0);
  });

  it("refuses an empty list rather than succeeding with nothing", async () => {
    await expect(raise([])).rejects.toMatchObject({ code: "NEI19" });
  });

  it("refuses to raise against another team's event", async () => {
    // A requerimento names the event it belongs to; raising one against somebody else's event puts
    // work in an inbox referencing something the receiving team cannot open.
    await expect(raise([DOER], eventId, THIRD)).rejects.toMatchObject({ code: "NEI15" });
  });

  it("refuses a team asking itself", async () => {
    // That is just doing the work, and it would make "only the target team may change status"
    // meaningless for those rows.
    await expect(raise([ASKER])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("only the target team owns the status", () => {
  it("lets the target team move it along", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await setStatus(req.id, "in_progress", DOER);
    expect((await idsFor(DOER))[0].status).toBe("in_progress");
  });

  it("REFUSES the requesting team marking its own request done", async () => {
    // The heart of the slice. Organização de Eventos could otherwise close a poster nobody drew.
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(setStatus(req.id, "done", ASKER)).rejects.toMatchObject({ code: "NEI21" });
    expect((await idsFor(DOER))[0].status).toBe("requested");
  });

  it("refuses a third team entirely", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(setStatus(req.id, "done", THIRD)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("lets EITHER side cancel", async () => {
    // Withdrawing your own request is not a claim about somebody else's work, so the asker may
    // cancel even though it may not advance.
    await raise([DOER, THIRD]);
    const mine = await idsFor(DOER);
    await setStatus(mine[0].id, "cancelled", ASKER);
    expect((await idsFor(DOER))[0].status).toBe("cancelled");

    const theirs = (await idsFor(THIRD))[0];
    await setStatus(theirs.id, "cancelled", THIRD);
    expect((await idsFor(THIRD))[0].status).toBe("cancelled");
  });

  it("makes cancelled terminal", async () => {
    // As `cancelled` is terminal for orders (#78). Reopening should be a new request, so the
    // history says what actually happened.
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await setStatus(req.id, "cancelled", ASKER);
    await expect(setStatus(req.id, "in_progress", DOER)).rejects.toMatchObject({ code: "NEI19" });
  });

  it("rejects a status outside the set", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(setStatus(req.id, "quase", DOER)).rejects.toMatchObject({ code: "NEI19" });
  });
});

describe("assignment", () => {
  const assign = (id: number, assignee: string | null, team: string) =>
    owner.query("SELECT neiist.assign_requirement($1::INT, $2::VARCHAR(50), $3::VARCHAR(30))", [
      id,
      assignee,
      team,
    ]);

  it("assigns somebody on the target team", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await assign(req.id, DOER_MEMBER, DOER);
    const { rows } = await owner.query<{ assignee_name: string }>(
      "SELECT assignee_name FROM neiist.get_team_requirements($1::VARCHAR(30)) WHERE id = $2",
      [DOER, req.id]
    );
    expect(rows[0].assignee_name).toBeTruthy();
  });

  it("refuses somebody who is not on that team", async () => {
    // Otherwise an inbox shows work owned by a person who is not there.
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(assign(req.id, OUTSIDER, DOER)).rejects.toMatchObject({ code: "NEI19" });
  });

  it("refuses the requesting team assigning somebody on the target team", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(assign(req.id, DOER_MEMBER, ASKER)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("allows unassignment", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await assign(req.id, DOER_MEMBER, DOER);
    await assign(req.id, null, DOER);
    const { rows } = await owner.query<{ assignee_name: string | null }>(
      "SELECT assignee_name FROM neiist.get_team_requirements($1::VARCHAR(30)) WHERE id = $2",
      [DOER, req.id]
    );
    expect(rows[0].assignee_name).toBeNull();
  });
});

describe("deliverables", () => {
  const deliver = (id: number, url: string, team: string) =>
    owner.query<{ add_requirement_deliverable: number }>(
      `SELECT neiist.add_requirement_deliverable($1::INT, $2::TEXT, 'Cartaz', $3::VARCHAR(50),
         $4::VARCHAR(30))`,
      [id, url, DOER_MEMBER, team]
    );

  it("records who delivered and when", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await deliver(req.id, "https://drive.google.com/file/abc", DOER);

    const { rows } = await owner.query<{ uploaded_by_name: string; uploaded_at: string }>(
      "SELECT * FROM neiist.get_requirement_deliverables($1::INT, $2::VARCHAR(30))",
      [req.id, DOER]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].uploaded_by_name).toBeTruthy();
    expect(rows[0].uploaded_at).toBeTruthy();
  });

  it("is visible to the REQUESTING team too", async () => {
    // The point of delivering is that the asker can see it. A requerimento is a conversation
    // between two teams and neither should have to ask what happened.
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await deliver(req.id, "https://drive.google.com/file/abc", DOER);

    const { rows } = await owner.query(
      "SELECT * FROM neiist.get_requirement_deliverables($1::INT, $2::VARCHAR(30))",
      [req.id, ASKER]
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses the requesting team delivering its own request", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(deliver(req.id, "https://x.pt/a", ASKER)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("refuses a link that is not a URL", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await expect(deliver(req.id, "vou mandar por whatsapp", DOER)).rejects.toMatchObject({
      code: "NEI19",
    });
  });

  it("shows nothing to a third team", async () => {
    await raise([DOER]);
    const [req] = await idsFor(DOER);
    await deliver(req.id, "https://drive.google.com/file/abc", DOER);
    const { rows } = await owner.query(
      "SELECT * FROM neiist.get_requirement_deliverables($1::INT, $2::VARCHAR(30))",
      [req.id, THIRD]
    );
    expect(rows).toEqual([]);
  });
});

describe("who can see what", () => {
  it("shows the target team an inbox and the requesting team an outbox", async () => {
    await raise([DOER]);
    expect((await idsFor(DOER))[0].direction).toBe("inbox");
    expect((await idsFor(ASKER))[0].direction).toBe("outbox");
  });

  it("shows a third team NOTHING", async () => {
    // Structural, not filtered afterwards: the WHERE clause cannot return it.
    await raise([DOER]);
    expect(await idsFor(THIRD)).toHaveLength(0);
  });

  it("sorts open work before closed, by deadline", async () => {
    await raise([DOER, THIRD, "Divulgação"]);
    const first = (await idsFor(DOER))[0];
    await setStatus(first.id, "done", DOER);
    const mine = await idsFor(ASKER);
    // The done one sinks to the bottom of the asker's outbox.
    expect(mine[mine.length - 1].status).toBe("done");
  });
});
