import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createInternalEvent,
  getEventTeams,
  getMemberInternalEvents,
  getPublicInternalEvents,
  getTeamInternalEvents,
  setEventCollaborator,
  setEventVisibility,
  visibilityRank,
} from "@/utils/db/eventQueries";

/**
 * #219 — collaborating teams and per-event visibility.
 *
 * Two corrections to #129's model, both from how NEIIST actually works:
 *
 *  - an event is owned by one team but worked on by several. A Visuais member brought in to make
 *    the poster could not previously see the event they were working on.
 *  - visibility needs four levels; the missing one is `members` — "every member sees the Jantar
 *    de Curso, but it is not public" — which the boolean could not express at all.
 *
 * The riskiest part is that `is_public` is the single filter keeping internal meetings off
 * `/activities` and out of Google Calendar (#202, #204). Widening it touches the one thing every
 * leak in this feature has come down to, so most of what follows guards that.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const OWNER_TEAM = "Organização de Eventos";
const HELPER_TEAM = "Visuais";
const OUTSIDE_TEAM = "Fotografia";
const AUTHOR = "ist9993201";
const HELPER_MEMBER = "ist9993202"; // Visuais only
const OUTSIDER = "ist9993203"; // Fotografia only

let owner: Client;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const make = (over: Partial<Parameters<typeof createInternalEvent>[0]> = {}) =>
  createInternalEvent({
    kind: "event",
    name: "Jantar de Curso",
    startsAt: inDays(10),
    isPublic: false,
    departmentName: OWNER_TEAM,
    createdByIstid: AUTHOR,
    ...over,
  });

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
  for (const [istid, name, team] of [
    [AUTHOR, "Event Author", OWNER_TEAM],
    [HELPER_MEMBER, "Visuais Helper", HELPER_TEAM],
    [OUTSIDER, "Fotografia Person", OUTSIDE_TEAM],
  ]) {
    await owner.query(
      `SELECT neiist.add_user($1::VARCHAR(50), $2, $3)
       WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
      [istid, name, `${istid}@tecnico.ulisboa.pt`]
    );
    await owner.query("SELECT neiist.add_team_member($1::VARCHAR(50), $2, 'Membro')", [
      istid,
      team,
    ]);
  }
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.internal_events WHERE created_by_istid = $1", [AUTHOR]);
});

afterAll(async () => {
  const all = [AUTHOR, HELPER_MEMBER, OUTSIDER];
  await owner.query("DELETE FROM neiist.membership WHERE user_istid = ANY($1)", [all]);
  await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [all]);
  await owner.end();
});

describe("collaborating teams", () => {
  it("lets a helper team see the event it is working on", async () => {
    // The concrete failure this fixes: Visuais is asked to make the poster and cannot open the
    // event.
    const id = await make();
    expect((await getTeamInternalEvents(HELPER_TEAM)).some((e) => e.id === id)).toBe(false);

    await setEventCollaborator(id, HELPER_TEAM, true);
    expect((await getTeamInternalEvents(HELPER_TEAM)).some((e) => e.id === id)).toBe(true);
  });

  it("does not make a collaborator the owner", async () => {
    // So the UI can tell a collaborator this is not their event to delete.
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);

    const asOwner = (await getTeamInternalEvents(OWNER_TEAM)).find((e) => e.id === id)!;
    const asHelper = (await getTeamInternalEvents(HELPER_TEAM)).find((e) => e.id === id)!;
    expect(asOwner.isOwner).toBe(true);
    expect(asHelper.isOwner).toBe(false);
  });

  it("removes a collaborator again", async () => {
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);
    await setEventCollaborator(id, HELPER_TEAM, false);
    expect((await getTeamInternalEvents(HELPER_TEAM)).some((e) => e.id === id)).toBe(false);
  });

  it("refuses to add the owning team as a collaborator", async () => {
    // It already has access, and the row would make `event_teams` return a duplicate.
    const id = await make();
    await expect(setEventCollaborator(id, OWNER_TEAM, true)).rejects.toMatchObject({
      code: "NEI14",
    });
  });

  it("refuses an unknown team rather than doing nothing", async () => {
    const id = await make();
    await expect(setEventCollaborator(id, "ZZ Nope", true)).rejects.toMatchObject({
      code: "NEI15",
    });
  });

  it("reports every team that can see the event, to a team that can see it", async () => {
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);
    expect((await getEventTeams(id, OWNER_TEAM)).sort()).toEqual([HELPER_TEAM, OWNER_TEAM].sort());
    // The collaborator gets the same answer — it is working on the event, so it may see who else
    // is. Only outsiders are refused.
    expect((await getEventTeams(id, HELPER_TEAM)).sort()).toEqual([HELPER_TEAM, OWNER_TEAM].sort());
  });

  it("tells an unrelated team nothing about who is working on an event", async () => {
    // A guessed id must not reveal that Visuais and Divulgação were pulled in — that alone says
    // the event has a poster and a campaign. Keyed by id AND asking team for exactly this reason.
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);
    expect(await getEventTeams(id, OUTSIDE_TEAM)).toEqual([]);
  });

  it("still hides the event from a team that is neither owner nor collaborator", async () => {
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);
    expect((await getTeamInternalEvents(OUTSIDE_TEAM)).some((e) => e.id === id)).toBe(false);
  });

  it("lets the owner shut collaborators out with visibility = owner", async () => {
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);
    await setEventVisibility(id, "owner");

    expect((await getTeamInternalEvents(HELPER_TEAM)).some((e) => e.id === id)).toBe(false);
    expect((await getTeamInternalEvents(OWNER_TEAM)).some((e) => e.id === id)).toBe(true);
  });
});

describe("visibility levels", () => {
  it("backfilled from is_public without changing meaning", async () => {
    const publicId = await make({ isPublic: true });
    const internalId = await make({ isPublic: false, name: "Reunião interna" });

    const events = await getTeamInternalEvents(OWNER_TEAM);
    expect(events.find((e) => e.id === publicId)!.visibility).toBe("public");
    expect(events.find((e) => e.id === internalId)!.visibility).toBe("teams");
  });

  it("keeps is_public in step, in both directions", async () => {
    // Two columns meaning one thing is what this repo keeps getting bitten by, so the trigger is
    // deliberately temporary — but while both exist they must never disagree.
    const id = await make({ isPublic: false });

    await setEventVisibility(id, "public");
    let row = await owner.query<{ p: boolean }>(
      "SELECT is_public AS p FROM neiist.internal_events WHERE id = $1",
      [id]
    );
    expect(row.rows[0].p).toBe(true);

    await owner.query("UPDATE neiist.internal_events SET is_public = FALSE WHERE id = $1", [id]);
    const back = await owner.query<{ v: string }>(
      "SELECT visibility::TEXT AS v FROM neiist.internal_events WHERE id = $1",
      [id]
    );
    expect(back.rows[0].v).toBe("teams");
  });

  it("reconciles a contradicting INSERT rather than storing both", async () => {
    // Found by mutation: removing the INSERT-path sync failed nothing, because visibility is
    // normally DERIVED from is_public and the two already agree. It only bites when a caller
    // supplies both and they disagree — which the workspace UI will do the moment it sends
    // `visibility` while older code still sends `is_public`.
    //
    // If they were allowed to diverge, an event could be `visibility = 'public'` in the workspace
    // and `is_public = false` to the Google Calendar sync, which reads the boolean — so a public
    // event would silently never reach anyone's calendar.
    const { rows } = await owner.query<{ id: number }>(
      `INSERT INTO neiist.internal_events
         (kind, name, starts_at, is_public, visibility, owner_department_name, created_by_istid)
       VALUES ('event', 'Contradição', NOW() + INTERVAL '5 days', FALSE, 'public', $1, $2)
       RETURNING id`,
      [OWNER_TEAM, AUTHOR]
    );
    const check = await owner.query<{ p: boolean; v: string }>(
      "SELECT is_public AS p, visibility::TEXT AS v FROM neiist.internal_events WHERE id = $1",
      [rows[0].id]
    );
    // The explicit visibility wins, and the boolean is brought into line with it.
    expect(check.rows[0].v).toBe("public");
    expect(check.rows[0].p).toBe(true);
  });

  it("ranks widest to narrowest", () => {
    expect(visibilityRank("public")).toBeLessThan(visibilityRank("members"));
    expect(visibilityRank("members")).toBeLessThan(visibilityRank("teams"));
    expect(visibilityRank("teams")).toBeLessThan(visibilityRank("owner"));
  });
});

describe("the members level — the one that did not exist", () => {
  it("shows a members-only event to a member of ANOTHER team", async () => {
    // "every member should see the Jantar de Curso, but it is not for the public".
    const id = await make({ name: "Jantar de Curso" });
    await setEventVisibility(id, "members");

    expect((await getMemberInternalEvents(OUTSIDER)).some((e) => e.id === id)).toBe(true);
  });

  it("does NOT put it on the public calendar", async () => {
    // The distinction the boolean could not make. This is the assertion that matters most here.
    const id = await make({ name: "Jantar de Curso" });
    await setEventVisibility(id, "members");

    expect((await getPublicInternalEvents()).some((e) => e.id === id)).toBe(false);
  });

  it("does not show it to someone with no team at all", async () => {
    // `members` means members. Someone with zero scopes is not one.
    const id = await make();
    await setEventVisibility(id, "members");
    expect(await getMemberInternalEvents("ist0000000")).toEqual([]);
  });

  it("still hides a teams-level event from another team's member", async () => {
    const id = await make();
    await setEventVisibility(id, "teams");
    expect((await getMemberInternalEvents(OUTSIDER)).some((e) => e.id === id)).toBe(false);
  });

  it("shows a teams-level event to a COLLABORATOR's member", async () => {
    const id = await make();
    await setEventCollaborator(id, HELPER_TEAM, true);
    expect((await getMemberInternalEvents(HELPER_MEMBER)).some((e) => e.id === id)).toBe(true);
  });
});

describe("the public calendar still filters", () => {
  it("shows only public events", async () => {
    const pub = await make({ isPublic: true });
    const mem = await make({ name: "Só membros" });
    await setEventVisibility(mem, "members");
    const team = await make({ name: "Só equipas" });

    const ids = (await getPublicInternalEvents()).map((e) => e.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(mem);
    expect(ids).not.toContain(team);
  });

  it("still excludes meetings, even public ones", async () => {
    const id = await make({ kind: "meeting", isPublic: true });
    expect((await getPublicInternalEvents()).some((e) => e.id === id)).toBe(false);
  });
});
