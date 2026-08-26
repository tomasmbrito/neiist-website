import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getApprovalSides,
  getBoardPendingApplications,
  isBoardSignatory,
  getOpenEdition,
  getTeamApplications,
  recordApplicationApproval,
  submitApplication,
  withdrawApplicationApproval,
} from "@/utils/db/recruitmentQueries";

/**
 * #134 slice A — recruitment applications.
 *
 * The property this whole slice exists for is that **one application has an independent outcome
 * per team**. Someone who applies to three teams may be accepted by one and rejected by another,
 * and neither decision may leak into the other. Most of what follows tests that.
 *
 * The second property is retention: these rows hold personal data belonging to people who may
 * never join, and the 6-month purge (decided 2026-08-25) has to actually work.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM_A = "Fotografia";
const TEAM_B = "Visuais";
const TEAM_C = "Divulgação";
// The two signatures need two real people with real memberships (#217) — the side someone signs
// is derived from `membership`, not from what the caller says, so a test that fakes it would be
// testing nothing. COORD_A/B/C coordinate their own team and nothing else; BOARD is a Vogal, which
// `valid_department_roles` grades `admin` inside an `admin_body`. BOTH is both, deliberately.
const COORD_A = "ist9994101";
const COORD_B = "ist9994102";
const COORD_C = "ist9994103";
const BOARD = "ist9994104";
const BOTH = "ist9994105";
const OUTSIDER = "ist9994106";
// #217, after Tomás corrected the rule: a Diretor de Atividades is ON the board and is graded
// `coordinator`. DEVLEAD is the opposite case — graded `admin` (#189) and NOT on the board.
const ATIVIDADES = "ist9994107";
const TESOUREIRO = "ist9994108";
const DEVLEAD = "ist9994109";
const PEOPLE = [COORD_A, COORD_B, COORD_C, BOARD, BOTH, OUTSIDER, ATIVIDADES, TESOUREIRO, DEVLEAD];

/** Sign one half. `side` stays undefined except where the test is about someone holding both. */
const sign = (
  id: number,
  team: string,
  decision: "accept" | "reject",
  actor: string,
  side?: "team" | "board",
  note?: string
) => recordApplicationApproval(id, team, decision, actor, side ?? null, note ?? null);

/** Both signatures, the ordinary path: the team looks first, then the board. */
const signBoth = async (id: number, team: string, decision: "accept" | "reject") => {
  const coordinator = { Fotografia: COORD_A, Visuais: COORD_B, Divulgação: COORD_C }[team]!;
  await sign(id, team, decision, coordinator);
  await sign(id, team, decision, BOARD);
};

let owner: Client;
let edition = 0;

const apply = (over: Partial<Parameters<typeof submitApplication>[0]> = {}) =>
  submitApplication({
    fullName: "Candidata Teste",
    istid: `ist${Math.floor(Math.random() * 8_000_000) + 1_000_000}`,
    email: "candidata@tecnico.ulisboa.pt",
    teams: [TEAM_A],
    ...over,
  });

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();

  for (const istid of PEOPLE) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), 'Assinante', $2)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, `${istid}@tecnico.ulisboa.pt`]
    );
  }

  const join = (istid: string, department: string, role: string) =>
    owner.query(
      `INSERT INTO neiist.membership (user_istid, department_name, role_name, from_date)
       VALUES ($1, $2, $3, CURRENT_DATE) ON CONFLICT DO NOTHING`,
      [istid, department, role]
    );
  await join(COORD_A, TEAM_A, "Coordenador");
  await join(COORD_B, TEAM_B, "Coordenador");
  await join(COORD_C, TEAM_C, "Coordenador");
  await join(BOARD, "Direção", "Vogal");
  await join(BOTH, TEAM_A, "Coordenador");
  await join(BOTH, "Direção", "Vogal");
  await join(OUTSIDER, TEAM_A, "Membro");
  await join(ATIVIDADES, "Direção", "Diretor de Atividades (Taguspark)");
  await join(TESOUREIRO, "Direção", "Tesoureiro");
  await join(DEVLEAD, "Dev-Team", "Coordenador");

  // Clear any leftover test edition first. The overlap trigger refuses a second open round, so a
  // previous run that died before `afterAll` would otherwise block every subsequent run — which
  // is exactly what happened once during mutation testing, and the failure looks like a broken
  // suite rather than stale state.
  await owner.query("DELETE FROM neiist.recruitment_editions WHERE name LIKE 'ZZ %'");

  // An open round, so applications are possible at all.
  const { rows } = await owner.query<{ id: number }>(
    `INSERT INTO neiist.recruitment_editions (name, opens_at, closes_at)
     VALUES ('ZZ Test Edition', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days')
     RETURNING id`
  );
  edition = rows[0].id;
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.recruitment_applications WHERE edition_id = $1", [edition]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.recruitment_editions WHERE id = $1", [edition]);
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [PEOPLE]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [PEOPLE]);
  await owner.end();
});

describe("submitting", () => {
  it("records the application and every team chosen", async () => {
    const id = await apply({ teams: [TEAM_A, TEAM_B, TEAM_C] });
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.recruitment_application_teams WHERE application_id = $1",
      [id]
    );
    expect(rows[0].n).toBe(3);
  });

  it("refuses an application with no teams", async () => {
    await expect(apply({ teams: [] })).rejects.toMatchObject({ code: "NEI19" });
  });

  it("refuses a team that does not exist, rather than dropping it silently", async () => {
    // Dropping it would mean the candidate never learns their choice vanished.
    await expect(apply({ teams: [TEAM_A, "ZZ Nope"] })).rejects.toMatchObject({ code: "NEI20" });
  });

  it("refuses an admin body — those are elected, not applied to", async () => {
    await expect(apply({ teams: ["Direção"] })).rejects.toMatchObject({ code: "NEI20" });
  });

  it("refuses a second application from the same person in the same round", async () => {
    // A second attempt should edit the first, not create a rival that some teams see and others
    // do not.
    const istid = "ist9994199";
    await apply({ istid, teams: [TEAM_A] });
    await expect(apply({ istid, teams: [TEAM_B] })).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a blank name", async () => {
    await expect(apply({ fullName: "   " })).rejects.toMatchObject({ code: "NEI19" });
  });
});

describe("the per-team outcome — the whole point of the slice", () => {
  it("lets one team accept while another rejects the SAME application", async () => {
    const id = await apply({ teams: [TEAM_A, TEAM_B] });

    await signBoth(id, TEAM_A, "accept");
    await signBoth(id, TEAM_B, "reject");

    const inA = (await getTeamApplications(TEAM_A)).find((a) => a.id === id);
    const inB = (await getTeamApplications(TEAM_B)).find((a) => a.id === id);
    expect(inA!.outcome).toBe("accepted");
    expect(inB!.outcome).toBe("rejected");
  });

  it("does not let one team's decision touch another's", async () => {
    const id = await apply({ teams: [TEAM_A, TEAM_B, TEAM_C] });
    await signBoth(id, TEAM_A, "reject");

    expect((await getTeamApplications(TEAM_B)).find((a) => a.id === id)!.outcome).toBe("pending");
    expect((await getTeamApplications(TEAM_C)).find((a) => a.id === id)!.outcome).toBe("pending");
  });

  it("refuses a decision from a team that is not on the application", async () => {
    // The route checks canForTeam on the department being decided; this is the SQL half, so a
    // coordinator of a team the candidate never applied to cannot invent a decision.
    const id = await apply({ teams: [TEAM_A] });
    await expect(sign(id, TEAM_B, "accept", COORD_B)).rejects.toMatchObject({ code: "NEI20" });
  });

  it("records who decided and when, and clears both when a signature is withdrawn", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await signBoth(id, TEAM_A, "accept");

    const decided = await owner.query<{ by: string | null; at: string | null }>(
      `SELECT decided_by_istid AS by, decided_at AS at
       FROM neiist.recruitment_application_teams WHERE application_id = $1`,
      [id]
    );
    // Whoever completed the pair. The full pair is in the approvals table; this is a summary.
    expect(decided.rows[0].by).toBe(BOARD);
    expect(decided.rows[0].at).not.toBeNull();

    await withdrawApplicationApproval(id, TEAM_A, BOARD);
    const undone = await owner.query<{ by: string | null; at: string | null }>(
      `SELECT decided_by_istid AS by, decided_at AS at
       FROM neiist.recruitment_application_teams WHERE application_id = $1`,
      [id]
    );
    // A pending row must not claim to have been decided by anyone.
    expect(undone.rows[0].by).toBeNull();
    expect(undone.rows[0].at).toBeNull();
  });

  it("closes the application only once EVERY team has decided", async () => {
    // Derived in SQL from the rows, so it cannot drift from what it summarises.
    const id = await apply({ teams: [TEAM_A, TEAM_B] });

    await signBoth(id, TEAM_A, "accept");
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.status).toBe("submitted");

    await signBoth(id, TEAM_B, "reject");
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.status).toBe("closed");
  });
});

describe("team scoping", () => {
  it("shows a team only the applications that named it", async () => {
    const onlyA = await apply({ teams: [TEAM_A] });
    expect((await getTeamApplications(TEAM_B)).some((a) => a.id === onlyA)).toBe(false);
    expect((await getTeamApplications(TEAM_A)).some((a) => a.id === onlyA)).toBe(true);
  });

  it("names the other teams applied to, without leaking their decisions", async () => {
    // A coordinator should know the person is being considered elsewhere; what those teams
    // decided is theirs, and seeing it would influence this decision.
    const id = await apply({ teams: [TEAM_A, TEAM_B] });
    await signBoth(id, TEAM_B, "reject");

    const inA = (await getTeamApplications(TEAM_A)).find((a) => a.id === id)!;
    expect(inA.otherTeams).toEqual([TEAM_B]);
    expect(JSON.stringify(inA)).not.toContain("rejected");
  });
});

describe("editions", () => {
  it("reports the open round", async () => {
    const open = await getOpenEdition();
    expect(open?.name).toBe("ZZ Test Edition");
  });

  it("refuses an application when no round is open", async () => {
    // Saying so is better than silently accepting an application nobody will read.
    await owner.query(
      "UPDATE neiist.recruitment_editions SET closes_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [edition]
    );
    await expect(apply()).rejects.toMatchObject({ code: "NEI20" });
    await owner.query(
      "UPDATE neiist.recruitment_editions SET closes_at = NOW() + INTERVAL '30 days' WHERE id = $1",
      [edition]
    );
  });

  it("refuses two rounds that overlap", async () => {
    // Two open rounds means neither the applicant nor the reviewer can tell which one applies.
    await expect(
      owner.query(
        `INSERT INTO neiist.recruitment_editions (name, opens_at, closes_at)
         VALUES ('ZZ Overlapping', NOW(), NOW() + INTERVAL '5 days')`
      )
    ).rejects.toMatchObject({ code: "NEI20" });
  });
});

/**
 * #217 — no decision reaches a candidate on one person's say-so.
 *
 *   "in order for the emails (of rejection or acceptance) to be sent, both the coordinator of
 *    that team and at least one member of the board should accept their candidatura"
 *
 * Note the "or rejection": a rejection email is still an email, so it needs both signatures too.
 * That is why `rejected` here requires the pair and not just the team, which is the one place
 * this deviates from the assumption written into the issue.
 */
describe("dual approval", () => {
  it("stays PENDING on a single signature, from either side", async () => {
    const teamOnly = await apply({ istid: "ist9994181", teams: [TEAM_A] });
    await sign(teamOnly, TEAM_A, "accept", COORD_A);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === teamOnly)!.outcome).toBe(
      "pending"
    );

    const boardOnly = await apply({ istid: "ist9994182", teams: [TEAM_A] });
    await sign(boardOnly, TEAM_A, "accept", BOARD);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === boardOnly)!.outcome).toBe(
      "pending"
    );
  });

  it("accepts only when BOTH accept", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    await sign(id, TEAM_A, "accept", BOARD);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("accepted");
  });

  it("rejects when either side rejects, once both have signed", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    await sign(id, TEAM_A, "reject", BOARD);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("rejected");
  });

  it("refuses to let ONE person supply both signatures", async () => {
    // The whole point is a second pair of eyes. BOTH is genuinely a coordinator of TEAM_A *and* a
    // Vogal, so every authorization check passes for them twice — and it must still not work.
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", BOTH, "team");
    await expect(sign(id, TEAM_A, "accept", BOTH, "board")).rejects.toMatchObject({
      code: "NEI22",
    });
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("pending");
  });

  it("refuses a side the person does not hold, however they ask for it", async () => {
    // A coordinator of TEAM_A is not the board. If this were trusted from the route, two
    // coordinators could accept a candidate with no board involvement at all.
    const id = await apply({ teams: [TEAM_A] });
    await expect(sign(id, TEAM_A, "accept", COORD_A, "board")).rejects.toMatchObject({
      code: "NEI21",
    });
    // And the reverse: a board member cannot sign as the team, which is what would let the board
    // accept someone into a team whose coordinator never looked at them.
    await expect(sign(id, TEAM_A, "accept", BOARD, "team")).rejects.toMatchObject({
      code: "NEI21",
    });
  });

  it("refuses someone who holds no side at all", async () => {
    // OUTSIDER is an ordinary member of TEAM_A. `canForTeam` in the route would already stop
    // them, but the route is not the boundary — this is.
    const id = await apply({ teams: [TEAM_A] });
    await expect(sign(id, TEAM_A, "accept", OUTSIDER)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("does not let a coordinator of ANOTHER team supply the board signature", async () => {
    // Dev-Team's Coordenador is graded `admin` on purpose (#189). A rule that checked only
    // `access = 'admin'` would make every team coordinator a board signatory — #180 again.
    const id = await apply({ teams: [TEAM_A] });
    await expect(sign(id, TEAM_A, "accept", COORD_B)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("makes someone holding both sides say which one they are signing", async () => {
    // Choosing for them would silently spend the signature they meant to give later.
    const id = await apply({ teams: [TEAM_A] });
    await expect(sign(id, TEAM_A, "accept", BOTH)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("lets someone holding both fill whichever half is still open, without being told", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    // The team half is taken, so the only side left for BOTH is the board's — no ambiguity.
    expect(await sign(id, TEAM_A, "accept", BOTH)).toBe("board");
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("accepted");
  });

  it("lets a signatory change their own mind before the pair completes", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    await sign(id, TEAM_A, "reject", COORD_A);
    await sign(id, TEAM_A, "accept", BOARD);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("rejected");
  });

  it("reopens the decision when a signature is withdrawn", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await signBoth(id, TEAM_A, "accept");
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.status).toBe("closed");

    await withdrawApplicationApproval(id, TEAM_A, COORD_A);
    const after = (await getTeamApplications(TEAM_A)).find((a) => a.id === id)!;
    expect(after.outcome).toBe("pending");
    // And the application is open again, not left claiming to be closed over a pending team.
    expect(after.status).toBe("submitted");
  });

  it("does not let you withdraw somebody else's signature", async () => {
    // Otherwise one person removes the other's and re-signs it: both halves, two steps.
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    await expect(withdrawApplicationApproval(id, TEAM_A, BOARD)).rejects.toMatchObject({
      code: "NEI20",
    });
  });

  it("does not reset an interview that was already scheduled", async () => {
    // A withdrawal must not silently un-invite someone. Only 'closed' goes back to 'submitted'.
    const id = await apply({ teams: [TEAM_A] });
    await owner.query(
      "UPDATE neiist.recruitment_applications SET status = 'interviewing' WHERE id = $1",
      [id]
    );
    await sign(id, TEAM_A, "accept", COORD_A);
    await withdrawApplicationApproval(id, TEAM_A, COORD_A);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.status).toBe(
      "interviewing"
    );
  });

  it("surfaces both signatures, with who gave them", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A, undefined, "Boa entrevista.");
    const half = (await getTeamApplications(TEAM_A)).find((a) => a.id === id)!;
    expect(half.teamDecision).toBe("accept");
    expect(half.teamActor).not.toBeNull();
    expect(half.boardDecision).toBeNull();
    expect(half.note).toBeNull(); // not summarised until the pair completes

    await sign(id, TEAM_A, "accept", BOARD);
    const full = (await getTeamApplications(TEAM_A)).find((a) => a.id === id)!;
    expect(full.boardDecision).toBe("accept");
    // The team's note is the one about the candidate, so it is the one the summary carries.
    expect(full.note).toBe("Boa entrevista.");
  });

  it("tells each person which sides they may sign", async () => {
    expect(await getApprovalSides(COORD_A, TEAM_A)).toEqual(["team"]);
    expect(await getApprovalSides(BOARD, TEAM_A)).toEqual(["board"]);
    expect((await getApprovalSides(BOTH, TEAM_A)).sort()).toEqual(["board", "team"]);
    expect(await getApprovalSides(OUTSIDER, TEAM_A)).toEqual([]);
    // A coordinator is only a coordinator of their OWN team.
    expect(await getApprovalSides(COORD_A, TEAM_B)).toEqual([]);
  });
});

/**
 * Who counts as "the board" — corrected by Tomás on 2026-08-25:
 *
 *   "The Diretores de Atividades are members of the board, so yes they should have the role
 *    board instead of coordinator."
 *
 * The rule used to infer the board from an `admin` grade inside a non-team department, which left
 * them out because they are graded `coordinator`. Board membership is now its OWN column, because
 * being on the Direção and how much of the workspace a role opens are two different facts.
 */
describe("board membership is data, not an access grade", () => {
  it("lets a Diretor de Atividades give the board signature — the point of the change", async () => {
    const id = await apply({ istid: "ist9994171", teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    expect(await sign(id, TEAM_A, "accept", ATIVIDADES)).toBe("board");
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("accepted");
  });

  it("does not make them a coordinator of a team they are not in", async () => {
    // The correction was about the board half only. A Diretor de Atividades must not thereby be
    // able to supply Fotografia's own signature — that would be one person holding both again.
    await expect(getApprovalSides(ATIVIDADES, TEAM_A)).resolves.toEqual(["board"]);
  });

  it("still refuses an `admin` grade that is not board membership (#189)", async () => {
    // Dev-Team/Coordenador is graded `admin` ON PURPOSE. Under a grade-based rule they were the
    // board signatory for every team — #180 again. The explicit column closes it by construction.
    const id = await apply({ istid: "ist9994172", teams: [TEAM_A] });
    await sign(id, TEAM_A, "accept", COORD_A);
    await expect(sign(id, TEAM_A, "accept", DEVLEAD)).rejects.toMatchObject({ code: "NEI21" });
  });

  it("leaves Tesoureiro out, as seeded — a decision, and one row to change", async () => {
    // Formally on the Direção, deliberately not seeded (#185). Pinned so that flipping it is a
    // visible act rather than something that drifts in.
    expect(await isBoardSignatory(TESOUREIRO)).toBe(false);
  });

  it("changes who may sign when the column changes, with no deploy", async () => {
    // This is the #185 principle actually demonstrated, not just asserted in a comment.
    expect(await isBoardSignatory(TESOUREIRO)).toBe(false);
    await owner.query("SELECT neiist.set_role_board_membership('Direção', 'Tesoureiro', TRUE)");
    expect(await isBoardSignatory(TESOUREIRO)).toBe(true);
    await owner.query("SELECT neiist.set_role_board_membership('Direção', 'Tesoureiro', FALSE)");
    expect(await isBoardSignatory(TESOUREIRO)).toBe(false);
  });

  it("refuses to make a TEAM role board membership", async () => {
    // The board is an admin body. A team's role becoming board authority is the #180 shape
    // exactly: a claim belonging to one team turning into authority over all of them.
    await expect(
      owner.query("SELECT neiist.set_role_board_membership('Dev-Team', 'Coordenador', TRUE)")
    ).rejects.toMatchObject({ code: "NEI03" });
  });

  it("refuses a role that does not exist, rather than silently doing nothing", async () => {
    await expect(
      owner.query("SELECT neiist.set_role_board_membership('Direção', 'ZZ Nope', TRUE)")
    ).rejects.toMatchObject({ code: "NEI03" });
  });

  it("seeds exactly the five intended board roles", async () => {
    // Pinned like seededAdminRoles.test.ts pins the admin set: a future role seeded `board_member`
    // has to be added here in the same commit, so it cannot arrive unnoticed.
    const { rows } = await owner.query<{ department_name: string; role_name: string }>(
      "SELECT department_name, role_name FROM neiist.valid_department_roles WHERE board_member"
    );
    expect(rows.map((r) => `${r.department_name} / ${r.role_name}`).sort()).toEqual([
      "Direção / Diretor de Atividades (Taguspark)",
      "Direção / Diretora de Atividades (Alameda)",
      "Direção / Presidente",
      "Direção / Vice-Presidente",
      "Direção / Vogal",
    ]);
  });
});

describe("the board's queue", () => {
  it("shows what is waiting on the board, and nothing else", async () => {
    const waiting = await apply({ istid: "ist9994191", teams: [TEAM_A] });
    const untouched = await apply({ istid: "ist9994192", teams: [TEAM_B] });
    const done = await apply({ istid: "ist9994193", teams: [TEAM_C] });

    await sign(waiting, TEAM_A, "accept", COORD_A);
    await signBoth(done, TEAM_C, "accept");

    const queue = await getBoardPendingApplications();
    const ids = queue.map((row) => row.id);
    expect(ids).toContain(waiting);
    // The team has not looked yet — the board is not asked to review ahead of them.
    expect(ids).not.toContain(untouched);
    // Already signed by the board.
    expect(ids).not.toContain(done);
  });

  it("is a work queue, not the application — no motivation, phone or course", async () => {
    const id = await apply({
      istid: "ist9994194",
      teams: [TEAM_A],
      motivation: "Quero muito entrar.",
      phone: "912345678",
    });
    await sign(id, TEAM_A, "accept", COORD_A);

    const row = (await getBoardPendingApplications()).find((r) => r.id === id)!;
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("Quero muito entrar");
    expect(serialised).not.toContain("912345678");
    // What it does carry: who signed, and why, so the board is deciding on something.
    expect(row.teamDecision).toBe("accept");
    expect(row.departmentName).toBe(TEAM_A);
  });
});

describe("retention", () => {
  it("purges decided applications older than six months, and keeps the rest", async () => {
    const old = await apply({ istid: "ist9994197", teams: [TEAM_A] });
    const recent = await apply({ istid: "ist9994198", teams: [TEAM_A] });
    const undecided = await apply({ istid: "ist9994196", teams: [TEAM_A] });

    await signBoth(old, TEAM_A, "reject");
    await signBoth(recent, TEAM_A, "reject");
    await owner.query(
      "UPDATE neiist.recruitment_applications SET decided_at = NOW() - INTERVAL '7 months' WHERE id = $1",
      [old]
    );

    await owner.query("SELECT neiist.purge_old_applications()");

    const survivors = (await getTeamApplications(TEAM_A)).map((a) => a.id);
    expect(survivors).not.toContain(old);
    expect(survivors).toContain(recent);
    // An undecided application is never purged — it has not been dealt with yet.
    expect(survivors).toContain(undecided);
  });

  it("takes the team rows with it", async () => {
    const id = await apply({ teams: [TEAM_A, TEAM_B] });
    await signBoth(id, TEAM_A, "reject");
    await signBoth(id, TEAM_B, "reject");
    await owner.query(
      "UPDATE neiist.recruitment_applications SET decided_at = NOW() - INTERVAL '7 months' WHERE id = $1",
      [id]
    );

    await owner.query("SELECT neiist.purge_old_applications()");

    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.recruitment_application_teams WHERE application_id = $1",
      [id]
    );
    expect(rows[0].n).toBe(0);
  });
});
