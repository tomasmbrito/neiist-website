import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  recordApplicationApproval,
  submitApplication,
  withdrawApplicationApproval,
} from "@/utils/db/recruitmentQueries";
import { getTeamApplications } from "@/utils/db/recruitmentQueries";

/**
 * #223 (#134 slice C) — the outbox that makes "tell the candidate" happen exactly once.
 *
 * The property under test is not "an email is composed". It is that **a row is queued exactly
 * once, when and only when both signatures are in**, and that a claimed row cannot be claimed
 * twice. Everything expensive about this slice lives in those two sentences: one is the reason
 * #217 had to land first, the other is the reason a transactional outbox was used instead of
 * calling sendEmail() from the route.
 *
 * The sending itself is not exercised here — that needs SMTP, and a test that mocks nodemailer
 * and then asserts nodemailer was called would be asserting the mock.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM_A = "Fotografia";
const TEAM_B = "Visuais";
const COORD_A = "ist9994301";
const COORD_B = "ist9994302";
const BOARD = "ist9994303";
const PEOPLE = [COORD_A, COORD_B, BOARD];

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

const sign = (id: number, team: string, decision: "accept" | "reject", actor: string) =>
  recordApplicationApproval(id, team, decision, actor, null, null);

const coordinatorFor = (team: string) => (team === TEAM_A ? COORD_A : COORD_B);

const settle = async (id: number, team: string, decision: "accept" | "reject") => {
  await sign(id, team, decision, coordinatorFor(team));
  await sign(id, team, decision, BOARD);
};

const queued = async (id: number) => {
  const { rows } = await owner.query<{
    department_name: string;
    outcome: string;
    sent_at: string | null;
  }>(
    `SELECT department_name, outcome, sent_at
     FROM neiist.recruitment_decision_notifications WHERE application_id = $1
     ORDER BY department_name`,
    [id]
  );
  return rows;
};

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
  await join(BOARD, "Direção", "Vogal");

  await owner.query("DELETE FROM neiist.recruitment_editions WHERE name LIKE 'ZZ Notif%'");
  const { rows } = await owner.query<{ id: number }>(
    `INSERT INTO neiist.recruitment_editions (name, opens_at, closes_at)
     VALUES ('ZZ Notif Edition', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days')
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

describe("queueing — nothing is sent on one signature", () => {
  it("queues NOTHING when only the team has signed", async () => {
    // This is the sentence #217 exists for. If this test ever passes with one signature, a single
    // coordinator is emailing candidates.
    const id = await apply();
    await sign(id, TEAM_A, "accept", COORD_A);
    expect(await queued(id)).toEqual([]);
  });

  it("queues NOTHING when only the board has signed", async () => {
    const id = await apply({ istid: "ist9994311" });
    await sign(id, TEAM_A, "accept", BOARD);
    expect(await queued(id)).toEqual([]);
  });

  it("queues exactly one row when the pair completes", async () => {
    const id = await apply({ istid: "ist9994312" });
    await settle(id, TEAM_A, "accept");
    const rows = await queued(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ department_name: TEAM_A, outcome: "accepted" });
  });

  it("queues a rejection too — a rejection email is still an email", async () => {
    const id = await apply({ istid: "ist9994313" });
    await settle(id, TEAM_A, "reject");
    expect(await queued(id)).toMatchObject([{ outcome: "rejected" }]);
  });

  it("queues per TEAM, not per application", async () => {
    // Someone accepted by one team and rejected by another must get both messages, each about
    // the team it concerns.
    const id = await apply({ istid: "ist9994314", teams: [TEAM_A, TEAM_B] });
    await settle(id, TEAM_A, "accept");
    await settle(id, TEAM_B, "reject");
    expect(await queued(id)).toEqual([
      expect.objectContaining({ department_name: TEAM_A, outcome: "accepted" }),
      expect.objectContaining({ department_name: TEAM_B, outcome: "rejected" }),
    ]);
  });
});

describe("exactly once", () => {
  it("does not queue a second email when a decision is withdrawn and re-made", async () => {
    // The honest model: a sent email cannot be unsent, so a re-decision must not produce a second,
    // contradicting message. The first row stands and the screen says the candidate was told.
    const id = await apply({ istid: "ist9994321" });
    await settle(id, TEAM_A, "accept");
    expect(await queued(id)).toHaveLength(1);

    await withdrawApplicationApproval(id, TEAM_A, BOARD);
    expect((await getTeamApplications(TEAM_A)).find((a) => a.id === id)!.outcome).toBe("pending");

    // Re-decided, the other way this time.
    await sign(id, TEAM_A, "reject", BOARD);
    const rows = await queued(id);
    expect(rows).toHaveLength(1);
    // Still the ORIGINAL outcome — what was actually communicated, not what is true now.
    expect(rows[0].outcome).toBe("accepted");
  });

  it("hands a claimed row to exactly one caller", async () => {
    // Two coordinators completing two pairs at the same moment must not both send the same email.
    // The claim is an atomic UPDATE ... RETURNING, so the queue is partitioned, never duplicated.
    const id = await apply({ istid: "ist9994322" });
    await settle(id, TEAM_A, "accept");

    const first = await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    const second = await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
  });

  it("never re-claims a row that was already sent", async () => {
    const id = await apply({ istid: "ist9994323" });
    await settle(id, TEAM_A, "accept");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await owner.query(
      "SELECT neiist.mark_decision_notification_sent($1::INT, $2::VARCHAR(30), 'hash-x', NOW() + INTERVAL '14 days')",
      [id, TEAM_A]
    );
    const again = await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    expect(again.rows).toHaveLength(0);
  });

  it("releases the claim when a send fails, so it is retried", async () => {
    const id = await apply({ istid: "ist9994324" });
    await settle(id, TEAM_A, "accept");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await owner.query(
      "SELECT neiist.mark_decision_notification_failed($1::INT, $2::VARCHAR(30), 'SMTP em baixo')",
      [id, TEAM_A]
    );

    const retry = await owner.query<{ attempts: number }>(
      "SELECT * FROM neiist.claim_decision_notifications(50)"
    );
    expect(retry.rows).toHaveLength(1);
    // The attempt counter carries across, so a row failing forever is visible as such.
    expect(retry.rows[0].attempts).toBe(2);
  });

  it("shows the failure to the reviewing team, not just to a log", async () => {
    const id = await apply({ istid: "ist9994325" });
    await settle(id, TEAM_A, "accept");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await owner.query(
      "SELECT neiist.mark_decision_notification_failed($1::INT, $2::VARCHAR(30), 'SMTP em baixo')",
      [id, TEAM_A]
    );

    const row = (await getTeamApplications(TEAM_A)).find((a) => a.id === id)!;
    expect(row.notifiedAt).toBeNull();
    expect(row.notifyError).toContain("SMTP");
  });
});

describe("the onboarding token", () => {
  const TOKEN_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const acceptedWithToken = async (istid: string, expires = "NOW() + INTERVAL '14 days'") => {
    const id = await apply({ istid });
    await settle(id, TEAM_A, "accept");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await owner.query(
      `SELECT neiist.mark_decision_notification_sent($1::INT, $2::VARCHAR(30), $3::TEXT, ${expires})`,
      [id, TEAM_A, TOKEN_HASH]
    );
    return id;
  };

  it("finds a live token, and reports who it belongs to", async () => {
    const id = await acceptedWithToken("ist9994331");
    const { rows } = await owner.query("SELECT * FROM neiist.find_onboarding_token($1)", [
      TOKEN_HASH,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ application_id: id, department_name: TEAM_A });
  });

  it("can be spent exactly once", async () => {
    await acceptedWithToken("ist9994332");
    const first = await owner.query<{ consume_onboarding_token: boolean }>(
      "SELECT neiist.consume_onboarding_token($1)",
      [TOKEN_HASH]
    );
    const second = await owner.query<{ consume_onboarding_token: boolean }>(
      "SELECT neiist.consume_onboarding_token($1)",
      [TOKEN_HASH]
    );
    expect(first.rows[0].consume_onboarding_token).toBe(true);
    expect(second.rows[0].consume_onboarding_token).toBe(false);
  });

  it("is invisible once spent", async () => {
    await acceptedWithToken("ist9994333");
    await owner.query("SELECT neiist.consume_onboarding_token($1)", [TOKEN_HASH]);
    const { rows } = await owner.query("SELECT * FROM neiist.find_onboarding_token($1)", [
      TOKEN_HASH,
    ]);
    expect(rows).toEqual([]);
  });

  it("expires", async () => {
    await acceptedWithToken("ist9994334", "NOW() - INTERVAL '1 day'");
    const { rows } = await owner.query("SELECT * FROM neiist.find_onboarding_token($1)", [
      TOKEN_HASH,
    ]);
    expect(rows).toEqual([]);
    const spend = await owner.query<{ consume_onboarding_token: boolean }>(
      "SELECT neiist.consume_onboarding_token($1)",
      [TOKEN_HASH]
    );
    expect(spend.rows[0].consume_onboarding_token).toBe(false);
  });

  it("tells an unknown token nothing, the same as an expired one", async () => {
    // Same empty answer for unknown / expired / spent, so probing distinguishes nothing.
    const { rows } = await owner.query("SELECT * FROM neiist.find_onboarding_token($1)", [
      "not-a-real-hash",
    ]);
    expect(rows).toEqual([]);
  });

  it("refuses to attach a token to a REJECTION", async () => {
    // A rejected candidate holding an onboarding link is the worst outcome this slice could have.
    // The constraint makes it impossible rather than merely unlikely.
    const id = await apply({ istid: "ist9994335" });
    await settle(id, TEAM_A, "reject");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await expect(
      owner.query(
        `SELECT neiist.mark_decision_notification_sent($1::INT, $2::VARCHAR(30), $3::TEXT,
           NOW() + INTERVAL '14 days')`,
        [id, TEAM_A, TOKEN_HASH]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
