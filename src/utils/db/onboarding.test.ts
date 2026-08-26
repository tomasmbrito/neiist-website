import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordApplicationApproval, submitApplication } from "@/utils/db/recruitmentQueries";

/**
 * #224 / #225 — onboarding an accepted candidate, and handing over the team's link.
 *
 * Three properties, in order of how much they would cost to get wrong:
 *
 *  1. **Onboarding creates no membership.** The page is reachable by a NON-member holding a token.
 *     A self-service page reachable by a non-member that creates authority is #193 exactly.
 *  2. **A rejected candidate never sees the WhatsApp link**, including by guessing.
 *  3. **The token is spent and the answers recorded atomically.** Spending it and then failing to
 *     record would burn somebody's only link and leave nothing behind.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM = "Fotografia";
const OTHER = "Visuais";
const COORD = "ist9994601";
const COORD_OTHER = "ist9994602";
const BOARD = "ist9994603";
const PEOPLE = [COORD, COORD_OTHER, BOARD];
const LINK = "https://chat.whatsapp.com/AbCdEf123456";
const TOKEN = "b".repeat(64);

let owner: Client;
let edition = 0;

const apply = (istid: string, teams: string[] = [TEAM]) =>
  submitApplication({
    fullName: "Ana Sofia Martins",
    istid,
    email: `${istid}@tecnico.ulisboa.pt`,
    teams,
  });

const settle = async (id: number, team: string, decision: "accept" | "reject") => {
  const coordinator = team === TEAM ? COORD : COORD_OTHER;
  await recordApplicationApproval(id, team, decision, coordinator, null, null);
  await recordApplicationApproval(id, team, decision, BOARD, null, null);
};

/** Accept, then put a token on the notification the way the mailer does. */
const acceptWithToken = async (istid: string, team = TEAM, token = TOKEN) => {
  const id = await apply(istid, [team]);
  await settle(id, team, "accept");
  await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
  await owner.query(
    `SELECT neiist.mark_decision_notification_sent($1::INT, $2::VARCHAR(30), $3::TEXT,
       NOW() + INTERVAL '14 days')`,
    [id, team, token]
  );
  return id;
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
  const join = (istid: string, department: string, role: string) =>
    owner.query(
      `INSERT INTO neiist.membership (user_istid, department_name, role_name, from_date)
       VALUES ($1, $2, $3, CURRENT_DATE) ON CONFLICT DO NOTHING`,
      [istid, department, role]
    );
  await join(COORD, TEAM, "Coordenador");
  await join(COORD_OTHER, OTHER, "Coordenador");
  await join(BOARD, "Direção", "Vogal");

  await owner.query("DELETE FROM neiist.recruitment_editions WHERE name LIKE 'ZZ Onboard%'");
  const { rows } = await owner.query<{ id: number }>(
    `INSERT INTO neiist.recruitment_editions (name, opens_at, closes_at)
     VALUES ('ZZ Onboard Edition', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days')
     RETURNING id`
  );
  edition = rows[0].id;
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.recruitment_applications WHERE edition_id = $1", [edition]);
  await owner.query("DELETE FROM neiist.team_links WHERE department_name = ANY($1)", [
    [TEAM, OTHER],
  ]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.recruitment_editions WHERE id = $1", [edition]);
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [PEOPLE]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [PEOPLE]);
  await owner.end();
});

describe("onboarding creates no authority", () => {
  it("records the answers without creating a membership", async () => {
    // The load-bearing test. `add_team_member` stays the single path by which a membership comes
    // into existence, and a human runs it.
    const id = await acceptWithToken("ist9994611");
    const before = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.membership"
    );

    await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana', '912345678')", [TOKEN]);

    const after = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.membership"
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const { rows } = await owner.query<{ preferred_name: string }>(
      "SELECT preferred_name FROM neiist.recruitment_onboarding WHERE application_id = $1",
      [id]
    );
    expect(rows[0].preferred_name).toBe("Ana");
  });

  it("creates no user either", async () => {
    await acceptWithToken("ist9994612");
    const before = await owner.query<{ n: number }>("SELECT count(*)::INT AS n FROM neiist.users");
    await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", [TOKEN]);
    const after = await owner.query<{ n: number }>("SELECT count(*)::INT AS n FROM neiist.users");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("the token is spent exactly once, atomically", () => {
  it("refuses a second submission with the same link", async () => {
    await acceptWithToken("ist9994621");
    await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", [TOKEN]);
    await expect(
      owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Outra')", [TOKEN])
    ).rejects.toMatchObject({ code: "NEI20" });
  });

  it("does not spend the token when the form is invalid", async () => {
    // Validation runs FIRST. A blank name burning the candidate's only link would lock them out
    // of their own onboarding over a typo.
    await acceptWithToken("ist9994622");
    await expect(
      owner.query("SELECT * FROM neiist.complete_onboarding($1, '   ')", [TOKEN])
    ).rejects.toMatchObject({ code: "NEI19" });

    // Still usable.
    const retry = await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", [TOKEN]);
    expect(retry.rows).toHaveLength(1);
  });

  it("refuses an unknown token", async () => {
    await expect(
      owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", ["nope"])
    ).rejects.toMatchObject({ code: "NEI20" });
  });

  it("refuses an expired token", async () => {
    const id = await acceptWithToken("ist9994623");
    await owner.query(
      "UPDATE neiist.recruitment_decision_notifications SET token_expires_at = NOW() - INTERVAL '1 day' WHERE application_id = $1",
      [id]
    );
    await expect(
      owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", [TOKEN])
    ).rejects.toMatchObject({ code: "NEI20" });
  });
});

describe("the WhatsApp link (#225)", () => {
  const setLink = (department: string, url: string | null) =>
    owner.query("SELECT neiist.set_team_link($1::VARCHAR(30), $2::TEXT, $3::VARCHAR(50))", [
      department,
      url,
      COORD,
    ]);

  it("is handed over when onboarding completes", async () => {
    await setLink(TEAM, LINK);
    await acceptWithToken("ist9994631");
    const { rows } = await owner.query<{ invite_url: string }>(
      "SELECT * FROM neiist.complete_onboarding($1, 'Ana')",
      [TOKEN]
    );
    expect(rows[0].invite_url).toBe(LINK);
  });

  it("gives the ACCEPTING team's link, never another team's", async () => {
    // Accepted by Fotografia, rejected by Visuais: they get Fotografia's link and not Visuais'.
    await setLink(TEAM, LINK);
    await setLink(OTHER, "https://chat.whatsapp.com/ZZZnotforyou1");

    const id = await apply("ist9994632", [TEAM, OTHER]);
    await settle(id, TEAM, "accept");
    await settle(id, OTHER, "reject");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await owner.query(
      `SELECT neiist.mark_decision_notification_sent($1::INT, $2::VARCHAR(30), $3::TEXT,
         NOW() + INTERVAL '14 days')`,
      [id, TEAM, TOKEN]
    );

    const { rows } = await owner.query<{ team: string; invite_url: string }>(
      "SELECT * FROM neiist.complete_onboarding($1, 'Ana')",
      [TOKEN]
    );
    expect(rows[0].team).toBe(TEAM);
    expect(rows[0].invite_url).toBe(LINK);
  });

  it("is unreachable for a REJECTED candidate", async () => {
    // A rejection carries no token at all — the CHECK from #223 makes that structural — so there
    // is no path from a rejection to a link, even holding a valid-looking one.
    await setLink(TEAM, LINK);
    const id = await apply("ist9994633");
    await settle(id, TEAM, "reject");
    await owner.query("SELECT * FROM neiist.claim_decision_notifications(50)");
    await expect(
      owner.query(
        `SELECT neiist.mark_decision_notification_sent($1::INT, $2::VARCHAR(30), $3::TEXT, NULL)`,
        [id, TEAM, TOKEN]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("completes onboarding even when the team has set no link yet", async () => {
    // A missing link must not block somebody joining; the page says a coordinator will send it.
    await acceptWithToken("ist9994634");
    const { rows } = await owner.query<{ invite_url: string | null }>(
      "SELECT * FROM neiist.complete_onboarding($1, 'Ana')",
      [TOKEN]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].invite_url).toBeNull();
  });

  it("refuses anything that is not a WhatsApp invite", async () => {
    // The field is shown to somebody outside NEIIST. A mistyped link is a link the núcleo sent a
    // stranger to.
    await expect(setLink(TEAM, "https://evil.example/join")).rejects.toMatchObject({
      code: "NEI19",
    });
    await expect(setLink(TEAM, "chat.whatsapp.com/AbC")).rejects.toMatchObject({ code: "NEI19" });
  });

  it("allows clearing the link", async () => {
    await setLink(TEAM, LINK);
    await setLink(TEAM, null);
    const { rows } = await owner.query<{ whatsapp_url: string | null }>(
      "SELECT * FROM neiist.get_team_link($1::VARCHAR(30))",
      [TEAM]
    );
    expect(rows[0].whatsapp_url).toBeNull();
  });

  it("records who rotated it and when", async () => {
    await setLink(TEAM, LINK);
    const { rows } = await owner.query<{ updated_by_name: string }>(
      "SELECT * FROM neiist.get_team_link($1::VARCHAR(30))",
      [TEAM]
    );
    expect(rows[0].updated_by_name).toBeTruthy();
  });
});

describe("the coordinator's queue", () => {
  it("lists people who submitted, scoped to the team", async () => {
    await acceptWithToken("ist9994641");
    await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana', '912345678')", [TOKEN]);

    const mine = await owner.query<{ preferred_name: string; suggested_email: string }>(
      "SELECT * FROM neiist.get_pending_onboarding($1::VARCHAR(30))",
      [TEAM]
    );
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0].preferred_name).toBe("Ana");
    // #213's rule, reused rather than re-derived.
    expect(mine.rows[0].suggested_email).toBe("ana.martins");

    const theirs = await owner.query(
      "SELECT * FROM neiist.get_pending_onboarding($1::VARCHAR(30))",
      [OTHER]
    );
    expect(theirs.rows).toEqual([]);
  });

  it("drops off the queue once a coordinator marks it done", async () => {
    const id = await acceptWithToken("ist9994642");
    await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", [TOKEN]);
    await owner.query(
      "SELECT neiist.mark_onboarding_complete($1::INT, $2::VARCHAR(30), $3::VARCHAR(50))",
      [id, TEAM, COORD]
    );
    const { rows } = await owner.query(
      "SELECT * FROM neiist.get_pending_onboarding($1::VARCHAR(30))",
      [TEAM]
    );
    expect(rows).toEqual([]);
  });

  it("refuses to mark the same one done twice", async () => {
    const id = await acceptWithToken("ist9994643");
    await owner.query("SELECT * FROM neiist.complete_onboarding($1, 'Ana')", [TOKEN]);
    await owner.query(
      "SELECT neiist.mark_onboarding_complete($1::INT, $2::VARCHAR(30), $3::VARCHAR(50))",
      [id, TEAM, COORD]
    );
    await expect(
      owner.query(
        "SELECT neiist.mark_onboarding_complete($1::INT, $2::VARCHAR(30), $3::VARCHAR(50))",
        [id, TEAM, COORD]
      )
    ).rejects.toMatchObject({ code: "NEI20" });
  });
});
