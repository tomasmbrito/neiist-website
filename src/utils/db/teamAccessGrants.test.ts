import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTeamAccessGrant,
  revokeTeamAccessGrant,
  getUserTeamScopes,
  getTeamAccessGrants,
} from "@/utils/db/userQueries";
import { UserRole } from "@/types/user";

/**
 * #184, against the real database.
 *
 * Every rule here is enforced in SQL rather than in the route, so these are the tests that matter:
 * a TypeScript guard can be bypassed by the next caller, a `RAISE … USING ERRCODE` cannot. Most of
 * what follows asserts a **refusal**, because the failure mode of an access-granting feature is
 * granting too much.
 */

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const BOARD = "ist9991001"; // Direção / Presidente — organisation-wide admin
// Divulgação, NOT Dev-Team, and the reason matters: per the #189 decision `Dev-Team /
// Coordenador` is deliberately seeded `admin`, i.e. organisation-wide. A "coordinator" fixture
// built on it would quietly be a board member, and the negative tests below would pass for the
// wrong reason. `Divulgação / Coordenador` is a genuine `coordinator`.
const COORD = "ist9991002"; // Divulgação / Coordenador by membership
const OWNTEAMMEMBER = "ist9991003"; // Divulgação / Membro — the delegate
const OUTSIDER = "ist9991004"; // Visuais / Membro — in no team the coordinator runs
const NONMEMBER = "ist9991005"; // a real user with zero memberships

const TARGET = "Fotografia"; // the team being lent out
const ADMIN_BODY = "Conselho Fiscal"; // department_type <> 'team'

let owner: Client;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const addUser = async (istid: string, name: string) =>
  owner.query("SELECT neiist.add_user($1::VARCHAR(50), $2, $3)", [
    istid,
    name,
    `${istid}@tecnico.ulisboa.pt`,
  ]);

const purge = async (istid: string) => {
  await owner.query("DELETE FROM neiist.team_access_grants WHERE grantee_istid = $1", [istid]);
  await owner.query("DELETE FROM neiist.team_access_grants WHERE granted_by_istid = $1", [istid]);
  // revoked_by_istid is a third FK to users; missing it made purge fail on anyone who had
  // revoked something.
  await owner.query("DELETE FROM neiist.team_access_grants WHERE revoked_by_istid = $1", [istid]);
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = $1", [istid]);
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [istid]);
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [istid]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [istid]);
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();

  for (const id of [BOARD, COORD, OWNTEAMMEMBER, OUTSIDER, NONMEMBER]) await purge(id);

  await addUser(BOARD, "Board Person");
  await addUser(COORD, "Divulgação Coordinator");
  await addUser(OWNTEAMMEMBER, "Divulgação Member");
  await addUser(OUTSIDER, "Visuais Person");
  await addUser(NONMEMBER, "No Teams");

  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Direção', 'Presidente')", [
    BOARD,
  ]);
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Divulgação', 'Coordenador')", [
    COORD,
  ]);
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Divulgação', 'Membro')", [
    OWNTEAMMEMBER,
  ]);
  await owner
    .query("SELECT neiist.add_valid_department_role('Visuais', 'Membro', 'member')")
    .catch(() => undefined);
  await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Visuais', 'Membro')", [
    OUTSIDER,
  ]);
});

afterAll(async () => {
  for (const id of [BOARD, COORD, OWNTEAMMEMBER, OUTSIDER, NONMEMBER]) await purge(id);
  await owner.end();
});

beforeEach(async () => {
  await owner.query("DELETE FROM neiist.team_access_grants WHERE granted_by_istid = ANY($1)", [
    [BOARD, COORD, OWNTEAMMEMBER, OUTSIDER, NONMEMBER],
  ]);
});

describe("who may create a root grant", () => {
  it("lets the board lend a team to someone who is not in it", async () => {
    const id = await createTeamAccessGrant(
      BOARD,
      COORD,
      TARGET,
      UserRole._COORDINATOR,
      inDays(14),
      "Ajuda no site durante a campanha"
    );
    expect(id).toBeGreaterThan(0);
  });

  it("refuses a coordinator creating a root grant", async () => {
    // The Divulgação coordinator runs Divulgação. That is not authority to hand out Fotografia.
    // New authority comes from the board only — this is the SQL mirror of ORGANISATION_WIDE.
    await expect(
      createTeamAccessGrant(COORD, OWNTEAMMEMBER, TARGET, UserRole._MEMBER, inDays(7), "porque sim")
    ).rejects.toMatchObject({ code: "NEI08" });
  });

  it("refuses a plain member creating a root grant", async () => {
    await expect(
      createTeamAccessGrant(OWNTEAMMEMBER, OUTSIDER, TARGET, UserRole._MEMBER, inDays(7), "motivo")
    ).rejects.toMatchObject({ code: "NEI08" });
  });
});

describe("what a grant may say", () => {
  it("refuses an admin grant", async () => {
    // _ADMIN is organisation-wide: canForTeam short-circuits on it before looking at the
    // department at all, so a "team" grant carrying admin is a global grant in disguise.
    await expect(
      createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._ADMIN, inDays(7), "motivo")
    ).rejects.toMatchObject({ code: "NEI11" });
  });

  it("refuses a grant longer than 90 days", async () => {
    await expect(
      createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(120), "motivo")
    ).rejects.toMatchObject({ code: "NEI11" });
  });

  it("refuses a grant that has already expired", async () => {
    await expect(
      createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(-1), "motivo")
    ).rejects.toMatchObject({ code: "NEI11" });
  });

  it("refuses a blank reason", async () => {
    // This table is the audit record. A grant nobody can explain later is not much of a record.
    await expect(
      createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(7), "   ")
    ).rejects.toMatchObject({ code: "NEI11" });
  });

  it("refuses an admin body as the target", async () => {
    // Direção, Mesa da Assembleia Geral and Conselho Fiscal hold the board's own material.
    await expect(
      createTeamAccessGrant(BOARD, COORD, ADMIN_BODY, UserRole._MEMBER, inDays(7), "motivo")
    ).rejects.toMatchObject({ code: "NEI11" });
  });

  it("refuses a grant to someone who is not a NEIIST member", async () => {
    // The boundary #183 exists to hold: a grant lends access to ANOTHER team, it does not admit
    // an outsider to the núcleo. Without this, isNeiistMember would start returning true for
    // someone who never joined.
    await expect(
      createTeamAccessGrant(BOARD, NONMEMBER, TARGET, UserRole._MEMBER, inDays(7), "motivo")
    ).rejects.toMatchObject({ code: "NEI11" });
  });

  it("refuses a grant to yourself", async () => {
    await expect(
      createTeamAccessGrant(BOARD, BOARD, TARGET, UserRole._MEMBER, inDays(7), "motivo")
    ).rejects.toMatchObject({ code: "NEI11" });
  });
});

describe("delegation", () => {
  const rootGrant = () =>
    createTeamAccessGrant(
      BOARD,
      COORD,
      TARGET,
      UserRole._COORDINATOR,
      inDays(30),
      "Coordenação temporária"
    );

  it("lets a coordinator pass their grant to a member of their own team", async () => {
    const parent = await rootGrant();
    const child = await createTeamAccessGrant(
      COORD,
      OWNTEAMMEMBER,
      TARGET,
      UserRole._MEMBER,
      inDays(7),
      "Ajuda pontual",
      parent
    );
    expect(child).toBeGreaterThan(0);
  });

  it("refuses delegating to someone outside the delegator's own team", async () => {
    // "a member of HIS team" — the Visuais person is a NEIIST member, but not one the Dev-Team
    // coordinator has any authority over.
    const parent = await rootGrant();
    await expect(
      createTeamAccessGrant(COORD, OUTSIDER, TARGET, UserRole._MEMBER, inDays(7), "motivo", parent)
    ).rejects.toMatchObject({ code: "NEI10" });
  });

  it("refuses a plain member delegating, even inside their own team", async () => {
    // Found by mutation: removing the "coordinator-or-higher" condition from the SQL failed no
    // test, because every other delegation case also differed by department. This is the one
    // that isolates it — grantee and delegator are both in Divulgação, and the only thing wrong
    // is that the delegator merely belongs to it rather than coordinating it.
    const parent = await createTeamAccessGrant(
      BOARD,
      OWNTEAMMEMBER,
      TARGET,
      UserRole._MEMBER,
      inDays(30),
      "acesso pontual"
    );
    await expect(
      createTeamAccessGrant(OWNTEAMMEMBER, COORD, TARGET, UserRole._MEMBER, inDays(7), "m", parent)
    ).rejects.toMatchObject({ code: "NEI10" });
  });

  it("refuses delegating more access than was granted", async () => {
    const parent = await createTeamAccessGrant(
      BOARD,
      COORD,
      TARGET,
      UserRole._MEMBER,
      inDays(30),
      "acesso de leitura"
    );
    await expect(
      createTeamAccessGrant(
        COORD,
        OWNTEAMMEMBER,
        TARGET,
        UserRole._COORDINATOR,
        inDays(7),
        "motivo",
        parent
      )
    ).rejects.toMatchObject({ code: "NEI09" });
  });

  it("refuses delegating for longer than the grant itself lasts", async () => {
    const parent = await rootGrant();
    await expect(
      createTeamAccessGrant(COORD, OWNTEAMMEMBER, TARGET, UserRole._MEMBER, inDays(60), "m", parent)
    ).rejects.toMatchObject({ code: "NEI09" });
  });

  it("refuses delegating someone else's grant", async () => {
    const parent = await rootGrant(); // granted to COORD
    await expect(
      createTeamAccessGrant(
        OWNTEAMMEMBER,
        OUTSIDER,
        TARGET,
        UserRole._MEMBER,
        inDays(7),
        "m",
        parent
      )
    ).rejects.toMatchObject({ code: "NEI09" });
  });

  it("refuses delegating for a different team than the parent grant", async () => {
    const parent = await rootGrant(); // Fotografia
    await expect(
      createTeamAccessGrant(
        COORD,
        OWNTEAMMEMBER,
        "Visuais",
        UserRole._MEMBER,
        inDays(7),
        "m",
        parent
      )
    ).rejects.toMatchObject({ code: "NEI09" });
  });

  it("caps the chain at one delegation", async () => {
    // Board -> coordinator -> member, and no further. An unbounded chain makes the original
    // grant's blast radius impossible to reason about.
    const parent = await rootGrant();
    const child = await createTeamAccessGrant(
      COORD,
      OWNTEAMMEMBER,
      TARGET,
      UserRole._MEMBER,
      inDays(7),
      "m",
      parent
    );
    await expect(
      createTeamAccessGrant(
        OWNTEAMMEMBER,
        OUTSIDER,
        TARGET,
        UserRole._MEMBER,
        inDays(3),
        "m",
        child
      )
    ).rejects.toMatchObject({ code: "NEI09" });
  });

  it("refuses delegating a revoked grant", async () => {
    const parent = await rootGrant();
    await revokeTeamAccessGrant(BOARD, parent, "já não é preciso");
    await expect(
      createTeamAccessGrant(COORD, OWNTEAMMEMBER, TARGET, UserRole._MEMBER, inDays(3), "m", parent)
    ).rejects.toMatchObject({ code: "NEI09" });
  });
});

describe("grants reaching the scope pipeline", () => {
  it("appears in getUserTeamScopes, labelled as a grant", async () => {
    const before = await getUserTeamScopes(COORD);
    expect(before.some((s) => s.departmentName === TARGET)).toBe(false);

    await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._COORDINATOR, inDays(14), "m");

    const after = await getUserTeamScopes(COORD);
    const granted = after.find((s) => s.departmentName === TARGET);
    expect(granted).toBeDefined();
    expect(granted!.access).toBe(UserRole._COORDINATOR);
    // The discriminator that stops a loan becoming permanent authority.
    expect(granted!.source).toBe("grant");
    // The real membership is untouched and still labelled correctly.
    expect(after.find((s) => s.departmentName === "Divulgação")?.source).toBe("membership");
  });

  it("disappears the moment it expires — no job, no cleanup", async () => {
    const id = await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(14), "m");
    expect((await getUserTeamScopes(COORD)).some((s) => s.departmentName === TARGET)).toBe(true);

    // Move expiry into the past, which is what the clock does on its own. `granted_at` moves with
    // it because `team_access_grants_expiry_after_grant` refuses a row that expires before it was
    // granted — the constraint doing its job, found by this test failing.
    await owner.query(
      `UPDATE neiist.team_access_grants
       SET granted_at = NOW() - INTERVAL '2 days', expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $1`,
      [id]
    );

    // Scopes are re-read on every request and the JWT carries none, so the next request simply
    // comes back with fewer rows. That is the whole of expiry.
    expect((await getUserTeamScopes(COORD)).some((s) => s.departmentName === TARGET)).toBe(false);
  });

  it("disappears when revoked", async () => {
    const id = await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(14), "m");
    await revokeTeamAccessGrant(BOARD, id, "acabou");
    expect((await getUserTeamScopes(COORD)).some((s) => s.departmentName === TARGET)).toBe(false);
  });
});

describe("a grant is additive to membership, never a substitute", () => {
  it("stops working the moment the grantee leaves the núcleo", async () => {
    // Found by security review. Invariant 9 refuses a grant to a non-member, but it is checked
    // once, at INSERT. Offboarding happens later: end the person's membership and, without the
    // read-path check, the grant branch alone still returns a scope — making `isNeiistMember`
    // (scopes.length > 0) true for an ex-member and handing them another team's workspace for
    // up to 90 more days, with nothing in the admin UI showing why.
    await createTeamAccessGrant(BOARD, OUTSIDER, TARGET, UserRole._MEMBER, inDays(60), "projeto");
    expect((await getUserTeamScopes(OUTSIDER)).some((s) => s.departmentName === TARGET)).toBe(true);

    // The normal offboarding action: their own membership ends.
    // `to_date = CURRENT_DATE`, not CURRENT_DATE - 1: `valid_member_dates` requires
    // `to_date >= from_date` and the fixture joined today (#181 relaxed it to allow same-day
    // removal, which is exactly this case). Liveness is `to_date > CURRENT_DATE`, so today
    // means the membership has ended.
    await owner.query("UPDATE neiist.membership SET to_date = CURRENT_DATE WHERE user_istid = $1", [
      OUTSIDER,
    ]);

    const scopes = await getUserTeamScopes(OUTSIDER);
    expect(scopes).toEqual([]);

    // Restore for the remaining tests.
    await owner.query("UPDATE neiist.membership SET to_date = NULL WHERE user_istid = $1", [
      OUTSIDER,
    ]);
  });
});

describe("only the board creates new authority", () => {
  it("refuses a root grant from someone whose admin access comes from a TEAM role", async () => {
    // Found by security review, and it is the seeded reality: `Dev-Team / Coordenador` is
    // deliberately `admin` (#189). Checking only `access = 'admin'` therefore made "only the
    // board may create a root grant" false — one team's coordinator could mint 90-day grants on
    // every other team. Authority has to come from an admin body.
    const DEVCOORD = "ist9991006";
    await purge(DEVCOORD);
    await addUser(DEVCOORD, "Dev Coordinator");
    await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), 'Dev-Team', 'Coordenador')", [
      DEVCOORD,
    ]);

    // Confirm the premise rather than assuming it: this person really does hold `admin`.
    const { rows } = await owner.query<{ access: string }>(
      `SELECT DISTINCT v.access FROM neiist.membership m
       JOIN neiist.valid_department_roles v
         ON v.department_name = m.department_name AND v.role_name = m.role_name
       WHERE m.user_istid = $1 AND (m.to_date IS NULL OR m.to_date > CURRENT_DATE)`,
      [DEVCOORD]
    );
    expect(rows.map((r) => r.access)).toContain("admin");

    await expect(
      createTeamAccessGrant(DEVCOORD, OUTSIDER, TARGET, UserRole._MEMBER, inDays(7), "motivo")
    ).rejects.toMatchObject({ code: "NEI08" });

    await purge(DEVCOORD);
  });
});

describe("revocation", () => {
  it("revokes delegated grants along with their parent", async () => {
    const parent = await createTeamAccessGrant(
      BOARD,
      COORD,
      TARGET,
      UserRole._COORDINATOR,
      inDays(30),
      "m"
    );
    await createTeamAccessGrant(
      COORD,
      OWNTEAMMEMBER,
      TARGET,
      UserRole._MEMBER,
      inDays(7),
      "m",
      parent
    );
    expect((await getUserTeamScopes(OWNTEAMMEMBER)).some((s) => s.departmentName === TARGET)).toBe(
      true
    );

    await revokeTeamAccessGrant(BOARD, parent, "campanha terminada");

    // Leaving the child alive would be authority outliving its own source.
    expect((await getUserTeamScopes(OWNTEAMMEMBER)).some((s) => s.departmentName === TARGET)).toBe(
      false
    );
  });

  it("lets the grantee hand a grant back", async () => {
    const id = await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(14), "m");
    await revokeTeamAccessGrant(COORD, id, "já não preciso");
    expect((await getUserTeamScopes(COORD)).some((s) => s.departmentName === TARGET)).toBe(false);
  });

  it("lets the receiving team's own coordinator revoke an outsider's grant", async () => {
    // The one person responsible for Fotografia could not remove someone the board lent to it.
    const FOTOCOORD = "ist9991007";
    await purge(FOTOCOORD);
    await addUser(FOTOCOORD, "Fotografia Coordinator");
    await owner.query(
      "SELECT neiist.add_team_member($1::VARCHAR(50), 'Fotografia', 'Coordenador')",
      [FOTOCOORD]
    );

    const id = await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(14), "m");
    await revokeTeamAccessGrant(FOTOCOORD, id, "já não é necessário");
    expect((await getUserTeamScopes(COORD)).some((s) => s.departmentName === TARGET)).toBe(false);

    await purge(FOTOCOORD);
  });

  it("refuses revocation by an unrelated person", async () => {
    const id = await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(14), "m");
    await expect(revokeTeamAccessGrant(OUTSIDER, id, "porque quero")).rejects.toMatchObject({
      code: "NEI12",
    });
  });

  it("is idempotent", async () => {
    const id = await createTeamAccessGrant(BOARD, COORD, TARGET, UserRole._MEMBER, inDays(14), "m");
    await revokeTeamAccessGrant(BOARD, id, "uma vez");
    await expect(revokeTeamAccessGrant(BOARD, id, "outra vez")).resolves.toBeUndefined();
  });

  it("keeps the row as an audit record rather than deleting it", async () => {
    const id = await createTeamAccessGrant(
      BOARD,
      COORD,
      TARGET,
      UserRole._MEMBER,
      inDays(14),
      "motivo registado"
    );
    await revokeTeamAccessGrant(BOARD, id, "terminado");

    const grants = await getTeamAccessGrants(TARGET);
    const row = grants.find((g) => g.id === id);
    expect(row).toBeDefined();
    expect(row!.isActive).toBe(false);
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.reason).toBe("motivo registado");
    expect(row!.grantedByName).toBe("Board Person");
  });
});

describe("access_rank agrees with ACCESS_RANK in permissions.ts", () => {
  it("ranks member and shop_manager equal, and below coordinator", async () => {
    // One policy written in two languages. The enum's own ordinal order is DESCENDING authority
    // and puts shop_manager above member, so `access < 'member'` does not mean what it looks
    // like — this is the thing that would drift silently.
    const { rows } = await owner.query<{ a: string; r: number }>(
      `SELECT a::TEXT AS a, neiist.access_rank(a) AS r
       FROM unnest(ARRAY['admin','coordinator','shop_manager','member']::neiist.user_access_enum[]) a`
    );
    const rank = Object.fromEntries(rows.map((r) => [r.a, Number(r.r)]));
    expect(rank).toEqual({ admin: 3, coordinator: 2, shop_manager: 1, member: 1 });
  });
});
