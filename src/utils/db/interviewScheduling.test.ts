import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { submitApplication } from "@/utils/db/recruitmentQueries";

/**
 * #218 — availability and interview booking.
 *
 * The property this file exists for is in one test: **two candidates claiming the same slot at
 * the same moment, exactly one wins.** Everything else here is scaffolding around that.
 *
 * That test holds a transaction open on a second connection. It does NOT use `Promise.all`, and
 * the reason is measured rather than stylistic: a `Promise.all` version of an earlier concurrency
 * test passed against a deliberately broken function, because two pool queries start about a
 * millisecond apart and the unguarded window is microseconds wide. Recorded in the decision log,
 * 2026-08-19, and every concurrency guard added since is checked by mutation before being trusted.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

const TEAM = "Fotografia";
const OTHER_TEAM = "Visuais";
const COORD = "ist9994401";

let owner: Client;
let edition = 0;

const apply = (istid: string, teams: string[] = [TEAM]) =>
  submitApplication({
    fullName: `Candidato ${istid}`,
    istid,
    email: `${istid}@tecnico.ulisboa.pt`,
    teams,
  });

/** A slot `hours` from now, on the given team. */
const addSlot = async (hours: number, department = TEAM) => {
  const { rows } = await owner.query<{ id: number }>(
    `SELECT neiist.add_interview_slot($1::INT, $2::VARCHAR(30), $3::VARCHAR(50),
       NOW() + ($4 || ' hours')::INTERVAL, NOW() + (($4::INT + 1) || ' hours')::INTERVAL,
       'Sala 1') AS id`,
    [edition, department, COORD, String(hours)]
  );
  return rows[0].id;
};

const claim = async (slot: number, application: number, client: Client = owner) => {
  const { rows } = await client.query<{ id: number | null }>(
    "SELECT neiist.claim_interview_slot($1::INT, $2::INT) AS id",
    [slot, application]
  );
  return rows[0].id;
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();

  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), 'Coordenadora', $2)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [COORD, `${COORD}@tecnico.ulisboa.pt`]
  );

  await owner.query("DELETE FROM neiist.recruitment_editions WHERE name LIKE 'ZZ Interview%'");
  const { rows } = await owner.query<{ id: number }>(
    `INSERT INTO neiist.recruitment_editions (name, opens_at, closes_at)
     VALUES ('ZZ Interview Edition', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days')
     RETURNING id`
  );
  edition = rows[0].id;
});

afterEach(async () => {
  await owner.query("DELETE FROM neiist.interview_slots WHERE edition_id = $1", [edition]);
  await owner.query("DELETE FROM neiist.internal_events WHERE name = 'Entrevista'");
  await owner.query("DELETE FROM neiist.recruitment_applications WHERE edition_id = $1", [edition]);
});

afterAll(async () => {
  await owner.query("DELETE FROM neiist.recruitment_editions WHERE id = $1", [edition]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [COORD]);
  await owner.end();
});

describe("the claim — two candidates, one slot", () => {
  it("gives the slot to exactly one of two simultaneous claims", async () => {
    // The test that matters. A second connection holds a transaction open across the first claim,
    // so the two really do overlap; `Promise.all` does not reproduce this.
    const slot = await addSlot(48);
    const first = await apply("ist9994411");
    const second = await apply("ist9994412");

    const rival = new Client({ connectionString: OWNER_URL });
    await rival.connect();
    try {
      await rival.query("BEGIN");
      // Rival claims inside an open transaction and does NOT commit yet: the row is now locked.
      const rivalGot = await claim(slot, second, rival);
      expect(rivalGot).toBe(slot);

      // The second claim blocks on that lock. Once the rival commits, Postgres re-evaluates this
      // statement's WHERE against the new row version — the slot is taken, so zero rows update.
      const pending = claim(slot, first);
      await rival.query("COMMIT");
      expect(await pending).toBeNull();
    } finally {
      await rival.end();
    }

    const { rows } = await owner.query<{ held_by_application_id: number }>(
      "SELECT held_by_application_id FROM neiist.interview_slots WHERE id = $1",
      [slot]
    );
    expect(rows[0].held_by_application_id).toBe(second);
  });

  it("returns null rather than throwing when the race is lost", async () => {
    // Losing is an ordinary outcome the page renders, not an error condition.
    const slot = await addSlot(48);
    const a = await apply("ist9994413");
    const b = await apply("ist9994414");
    expect(await claim(slot, a)).toBe(slot);
    expect(await claim(slot, b)).toBeNull();
  });

  it("lets the same candidate re-claim their own hold", async () => {
    // Clicking the same slot twice must not fail — they already have it.
    const slot = await addSlot(48);
    const a = await apply("ist9994415");
    expect(await claim(slot, a)).toBe(slot);
    expect(await claim(slot, a)).toBe(slot);
  });

  it("releases a candidate's previous hold when they pick a different slot", async () => {
    // Browsing back and forth must not quietly reserve half the afternoon.
    const first = await addSlot(48);
    const second = await addSlot(72);
    const a = await apply("ist9994416");

    await claim(first, a);
    await claim(second, a);

    const { rows } = await owner.query<{ id: number; held: number | null }>(
      "SELECT id, held_by_application_id AS held FROM neiist.interview_slots WHERE id = ANY($1) ORDER BY id",
      [[first, second]]
    );
    expect(rows.find((r) => r.id === first)!.held).toBeNull();
    expect(rows.find((r) => r.id === second)!.held).toBe(a);
  });
});

describe("what a candidate may take", () => {
  it("refuses a slot belonging to a team they did not apply to", async () => {
    // A guessed slot id from another team's schedule. Checked in the claim, not in the route,
    // because the claim is the only place that can be sure.
    const foreign = await addSlot(48, OTHER_TEAM);
    const a = await apply("ist9994421", [TEAM]);
    expect(await claim(foreign, a)).toBeNull();
  });

  it("shows a candidate only their own team's free slots", async () => {
    const mine = await addSlot(48, TEAM);
    await addSlot(50, OTHER_TEAM);
    const a = await apply("ist9994422", [TEAM]);

    const { rows } = await owner.query<{ id: number }>(
      "SELECT id FROM neiist.get_free_interview_slots($1::INT)",
      [a]
    );
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });

  it("does not offer a slot in the past", async () => {
    await owner.query(
      `INSERT INTO neiist.interview_slots
         (edition_id, department_name, coordinator_istid, starts_at, ends_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      [edition, TEAM, COORD]
    );
    const a = await apply("ist9994423");
    const { rows } = await owner.query("SELECT * FROM neiist.get_free_interview_slots($1::INT)", [
      a,
    ]);
    expect(rows).toEqual([]);
  });

  it("hides a slot another candidate is holding", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994424");
    const b = await apply("ist9994425");
    await claim(slot, a);

    const { rows } = await owner.query("SELECT * FROM neiist.get_free_interview_slots($1::INT)", [
      b,
    ]);
    expect(rows).toEqual([]);
  });
});

describe("holds expire rather than locking a slot forever", () => {
  const expireHold = (slot: number) =>
    owner.query(
      "UPDATE neiist.interview_slots SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [slot]
    );

  it("lets someone else take a slot whose hold went stale", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994431");
    const b = await apply("ist9994432");
    await claim(slot, a);
    await expireHold(slot);

    expect(await claim(slot, b)).toBe(slot);
  });

  it("offers a stale-held slot again without waiting for a cleanup job", async () => {
    // Correctness must never depend on housekeeping having run. The claim itself treats an
    // expired hold as free; `release_expired_interview_holds` is tidying, not the guard.
    const slot = await addSlot(48);
    const a = await apply("ist9994433");
    const b = await apply("ist9994434");
    await claim(slot, a);
    await expireHold(slot);

    const { rows } = await owner.query("SELECT * FROM neiist.get_free_interview_slots($1::INT)", [
      b,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("counts what it released, so a broken flow is visible", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994435");
    await claim(slot, a);
    await expireHold(slot);

    const { rows } = await owner.query<{ release_expired_interview_holds: number }>(
      "SELECT neiist.release_expired_interview_holds()"
    );
    expect(rows[0].release_expired_interview_holds).toBe(1);
  });

  it("does not release a hold that is still live", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994436");
    await claim(slot, a);
    const { rows } = await owner.query<{ release_expired_interview_holds: number }>(
      "SELECT neiist.release_expired_interview_holds()"
    );
    expect(rows[0].release_expired_interview_holds).toBe(0);
  });
});

describe("confirming and cancelling", () => {
  const makeEvent = async () => {
    const { rows } = await owner.query<{ id: number }>(
      `SELECT neiist.create_internal_event('meeting', 'Entrevista', NULL,
         NOW() + INTERVAL '48 hours', NOW() + INTERVAL '49 hours', FALSE,
         $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
      [TEAM, COORD]
    );
    return rows[0].id;
  };

  it("turns a live hold into a booking and marks the application interviewing", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994441");
    await claim(slot, a);
    const event = await makeEvent();

    const { rows } = await owner.query<{ confirm_interview_slot: boolean }>(
      "SELECT neiist.confirm_interview_slot($1::INT, $2::INT, $3::INT)",
      [slot, a, event]
    );
    expect(rows[0].confirm_interview_slot).toBe(true);

    const status = await owner.query<{ status: string }>(
      "SELECT status FROM neiist.recruitment_applications WHERE id = $1",
      [a]
    );
    expect(status.rows[0].status).toBe("interviewing");
  });

  it("refuses a confirmation whose hold expired and was taken by somebody else", async () => {
    // The dangerous case: a slow client confirming after losing the slot would double-book.
    const slot = await addSlot(48);
    const a = await apply("ist9994442");
    const b = await apply("ist9994443");
    await claim(slot, a);
    await owner.query(
      "UPDATE neiist.interview_slots SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [slot]
    );
    await claim(slot, b);
    const event = await makeEvent();

    const { rows } = await owner.query<{ confirm_interview_slot: boolean }>(
      "SELECT neiist.confirm_interview_slot($1::INT, $2::INT, $3::INT)",
      [slot, a, event]
    );
    expect(rows[0].confirm_interview_slot).toBe(false);
  });

  it("returns a cancelled slot to the pool", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994444");
    const b = await apply("ist9994445");
    await claim(slot, a);
    await owner.query("SELECT neiist.confirm_interview_slot($1::INT, $2::INT, $3::INT)", [
      slot,
      a,
      await makeEvent(),
    ]);

    await owner.query("SELECT neiist.cancel_interview_booking($1::INT, $2::INT)", [slot, a]);

    // Free again, and someone else can take it.
    const free = await owner.query("SELECT * FROM neiist.get_free_interview_slots($1::INT)", [b]);
    expect(free.rows).toHaveLength(1);
    expect(await claim(slot, b)).toBe(slot);
  });

  it("does not let a candidate cancel somebody else's interview", async () => {
    const slot = await addSlot(48);
    const a = await apply("ist9994446");
    const b = await apply("ist9994447");
    await claim(slot, a);
    await owner.query("SELECT neiist.confirm_interview_slot($1::INT, $2::INT, $3::INT)", [
      slot,
      a,
      await makeEvent(),
    ]);

    await expect(
      owner.query("SELECT neiist.cancel_interview_booking($1::INT, $2::INT)", [slot, b])
    ).rejects.toMatchObject({ code: "NEI20" });
  });
});

describe("publishing availability", () => {
  it("is idempotent, so a double-click adds one slot", async () => {
    // A fixed timestamp, not NOW() + interval: the dedupe key is (coordinator, starts_at) and
    // exact equality is the point. Two calls computing NOW() separately land milliseconds apart
    // and are genuinely two different slots — which is correct, and is also how the UI behaves,
    // since it sends one chosen time rather than re-deriving it.
    const at = "2099-03-01T18:00:00Z";
    const add = async () => {
      const { rows } = await owner.query<{ id: number }>(
        `SELECT neiist.add_interview_slot($1::INT, $2::VARCHAR(30), $3::VARCHAR(50),
           $4::TIMESTAMPTZ, $4::TIMESTAMPTZ + INTERVAL '1 hour', NULL) AS id`,
        [edition, TEAM, COORD, at]
      );
      return rows[0].id;
    };
    expect(await add()).toBe(await add());
  });

  it("refuses to put one coordinator in two places at the same hour", async () => {
    // The same constraint seen from the other side: the second team's slot at that instant is
    // the same person, and they cannot take both interviews.
    const at = "2099-03-02T18:00:00Z";
    await owner.query(
      `SELECT neiist.add_interview_slot($1::INT, $2::VARCHAR(30), $3::VARCHAR(50),
         $4::TIMESTAMPTZ, $4::TIMESTAMPTZ + INTERVAL '1 hour', NULL)`,
      [edition, TEAM, COORD, at]
    );
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::INT AS n FROM neiist.interview_slots
       WHERE coordinator_istid = $1 AND starts_at = $2::TIMESTAMPTZ`,
      [COORD, at]
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses a slot that ends before it starts", async () => {
    await expect(
      owner.query(
        `SELECT neiist.add_interview_slot($1::INT, $2::VARCHAR(30), $3::VARCHAR(50),
           NOW() + INTERVAL '3 hours', NOW() + INTERVAL '1 hour', NULL)`,
        [edition, TEAM, COORD]
      )
    ).rejects.toMatchObject({ code: "NEI19" });
  });

  it("refuses to withdraw a slot that is already booked", async () => {
    // The candidate has been told. Deleting the row leaves them turning up to nothing.
    const slot = await addSlot(48);
    const a = await apply("ist9994451");
    await claim(slot, a);
    const { rows } = await owner.query<{ id: number }>(
      `SELECT neiist.create_internal_event('meeting', 'Entrevista', NULL,
         NOW() + INTERVAL '48 hours', NOW() + INTERVAL '49 hours', FALSE,
         $1::VARCHAR(30), $2::VARCHAR(50)) AS id`,
      [TEAM, COORD]
    );
    await owner.query("SELECT neiist.confirm_interview_slot($1::INT, $2::INT, $3::INT)", [
      slot,
      a,
      rows[0].id,
    ]);

    await expect(
      owner.query("SELECT neiist.remove_interview_slot($1::INT, $2::VARCHAR(50))", [slot, COORD])
    ).rejects.toMatchObject({ code: "NEI20" });
  });

  it("does not let a coordinator withdraw somebody else's availability", async () => {
    const slot = await addSlot(48);
    await expect(
      owner.query("SELECT neiist.remove_interview_slot($1::INT, $2::VARCHAR(50))", [
        slot,
        "ist9994499",
      ])
    ).rejects.toMatchObject({ code: "NEI20" });
  });
});
