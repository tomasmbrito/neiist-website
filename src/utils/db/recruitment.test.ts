import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  decideApplicationTeam,
  getOpenEdition,
  getTeamApplications,
  submitApplication,
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
const DECIDER = "ist9994101";

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

  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Decider', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [DECIDER, `${DECIDER}@tecnico.ulisboa.pt`]
  );

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
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [DECIDER]);
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

    await decideApplicationTeam(id, TEAM_A, "accepted", DECIDER);
    await decideApplicationTeam(id, TEAM_B, "rejected", DECIDER);

    const inA = (await getTeamApplications(TEAM_A)).find((a) => a.id === id);
    const inB = (await getTeamApplications(TEAM_B)).find((a) => a.id === id);
    expect(inA!.outcome).toBe("accepted");
    expect(inB!.outcome).toBe("rejected");
  });

  it("does not let one team's decision touch another's", async () => {
    const id = await apply({ teams: [TEAM_A, TEAM_B, TEAM_C] });
    await decideApplicationTeam(id, TEAM_A, "rejected", DECIDER);

    expect((await getTeamApplications(TEAM_B)).find((a) => a.id === id)!.outcome).toBe("pending");
    expect((await getTeamApplications(TEAM_C)).find((a) => a.id === id)!.outcome).toBe("pending");
  });

  it("refuses a decision from a team that is not on the application", async () => {
    // The route checks canForTeam on the department being decided; this is the SQL half, so a
    // coordinator of a team the candidate never applied to cannot invent a decision.
    const id = await apply({ teams: [TEAM_A] });
    await expect(decideApplicationTeam(id, TEAM_B, "accepted", DECIDER)).rejects.toMatchObject({
      code: "NEI20",
    });
  });

  it("records who decided and when, and clears both when a decision is undone", async () => {
    const id = await apply({ teams: [TEAM_A] });
    await decideApplicationTeam(id, TEAM_A, "accepted", DECIDER);

    const decided = await owner.query<{ by: string | null; at: string | null }>(
      `SELECT decided_by_istid AS by, decided_at AS at
       FROM neiist.recruitment_application_teams WHERE application_id = $1`,
      [id]
    );
    expect(decided.rows[0].by).toBe(DECIDER);
    expect(decided.rows[0].at).not.toBeNull();

    await decideApplicationTeam(id, TEAM_A, "pending", DECIDER);
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

    await decideApplicationTeam(id, TEAM_A, "accepted", DECIDER);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.status).toBe("submitted");

    await decideApplicationTeam(id, TEAM_B, "rejected", DECIDER);
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
    await decideApplicationTeam(id, TEAM_B, "rejected", DECIDER);

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

describe("retention", () => {
  it("purges decided applications older than six months, and keeps the rest", async () => {
    const old = await apply({ istid: "ist9994197", teams: [TEAM_A] });
    const recent = await apply({ istid: "ist9994198", teams: [TEAM_A] });
    const undecided = await apply({ istid: "ist9994196", teams: [TEAM_A] });

    await decideApplicationTeam(old, TEAM_A, "rejected", DECIDER);
    await decideApplicationTeam(recent, TEAM_A, "rejected", DECIDER);
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
    await decideApplicationTeam(id, TEAM_A, "rejected", DECIDER);
    await decideApplicationTeam(id, TEAM_B, "rejected", DECIDER);
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
