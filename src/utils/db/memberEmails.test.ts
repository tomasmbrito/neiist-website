import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assignNeiistEmail, previewNeiistEmail, toNeiistEmail } from "@/utils/db/memberEmails";

/**
 * #213 — `@neiist.pt` address generation.
 *
 * The property that matters is **uniqueness**, and it is the database's job: a helper that
 * "generates a unique address" is worth nothing if two concurrent calls can still collide, so
 * these tests go through the real function against the real UNIQUE index rather than testing a
 * string builder.
 */
const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

let owner: Client;
const MADE: string[] = [];

const addUser = async (istid: string, name: string) => {
  await owner.query(
    `SELECT neiist.add_user($1::VARCHAR(50), $2, $3)
     WHERE NOT EXISTS (SELECT 1 FROM neiist.users WHERE istid = $1)`,
    [istid, name, `${istid}@tecnico.ulisboa.pt`]
  );
  MADE.push(istid);
  return istid;
};

beforeAll(async () => {
  if (!OWNER_URL) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL must be set.");
  owner = new Client({ connectionString: OWNER_URL });
  await owner.connect();
});

afterEach(async () => {
  if (MADE.length) {
    await owner.query("DELETE FROM neiist.users WHERE istid = ANY($1)", [MADE]);
    MADE.length = 0;
  }
});

afterAll(async () => {
  await owner.end();
});

describe("building the address from a name", () => {
  it("folds Portuguese accents and drops particles", async () => {
    // Real names from the users table. "de", "dos", "da" are not names, so `de.brito` would be
    // wrong; the last WORD is the surname people actually use.
    const cases: Array<[string, string]> = [
      ["Tomás Moreira Luis de Jesus Brito", "tomas.brito"],
      ["João Pedro dos Santos Silva", "joao.silva"],
      ["Maria da Conceição Ferreira", "maria.ferreira"],
      ["Ana Sofia Gonçalves", "ana.goncalves"],
    ];
    for (const [name, expected] of cases) {
      const { rows } = await owner.query<{ b: string }>(
        "SELECT neiist.build_neiist_email_base($1::TEXT) AS b",
        [name]
      );
      expect(rows[0].b).toBe(expected);
    }
  });

  it("strips punctuation rather than producing an invalid local-part", async () => {
    const { rows } = await owner.query<{ b: string }>(
      "SELECT neiist.build_neiist_email_base($1::TEXT) AS b",
      ["Ana Multi-Cargo"]
    );
    expect(rows[0].b).toBe("ana.multicargo");
  });

  it("drops a particle that lands FIRST or LAST", async () => {
    // Found by mutation: removing the particle filter changed nothing in the earlier cases,
    // because first+last already skips the middle of a name — so "Tomás de Jesus Brito" gives
    // "tomas.brito" either way.
    //
    // It only bites at the ends. "Ana de Sousa" is two real words plus a particle: without the
    // filter the surname is "sousa" but the FIRST word taken is "ana" — fine — while a name
    // recorded as "de Sousa" would produce "de.sousa", which is not anybody's name.
    const cases: Array<[string, string]> = [
      ["de Sousa", "sousa"],
      ["Ana de Sousa", "ana.sousa"],
    ];
    for (const [name, expected] of cases) {
      const { rows } = await owner.query<{ b: string }>(
        "SELECT neiist.build_neiist_email_base($1::TEXT) AS b",
        [name]
      );
      expect(rows[0].b).toBe(expected);
    }
  });

  it("does not repeat a single-word name", async () => {
    const { rows } = await owner.query<{ b: string }>(
      "SELECT neiist.build_neiist_email_base($1::TEXT) AS b",
      ["Zé"]
    );
    // "ze", not "ze.ze".
    expect(rows[0].b).toBe("ze");
  });

  it("returns null for a name with no usable ASCII, rather than guessing", async () => {
    // A name the fold cannot handle is a case for a human. `assign` then raises NEI18 rather than
    // inventing something — see below.
    const { rows } = await owner.query<{ b: string | null }>(
      "SELECT neiist.build_neiist_email_base($1::TEXT) AS b",
      ["陳大文"]
    );
    expect(rows[0].b).toBeNull();
  });
});

describe("reserving an address", () => {
  it("gives the plain address when nothing collides", async () => {
    const istid = await addUser("ist9997901", "Rafael Antunes");
    expect(await assignNeiistEmail(istid)).toBe("rafael.antunes@neiist.pt");
  });

  it("resolves collisions with a numeric suffix", async () => {
    // Predictable on purpose: the second Ana can be told her address in one sentence, rather than
    // working out why a middle name appeared in it.
    const a = await addUser("ist9997902", "Ana Silva");
    const b = await addUser("ist9997903", "Ana Rodrigues Silva");
    const c = await addUser("ist9997904", "Ana Pereira Silva");

    expect(await assignNeiistEmail(a)).toBe("ana.silva@neiist.pt");
    expect(await assignNeiistEmail(b)).toBe("ana.silva2@neiist.pt");
    expect(await assignNeiistEmail(c)).toBe("ana.silva3@neiist.pt");
  });

  it("is idempotent — re-reserving never changes an existing address", async () => {
    const istid = await addUser("ist9997905", "Rafael Antunes");
    const first = await assignNeiistEmail(istid);
    expect(await assignNeiistEmail(istid)).toBe(first);
  });

  it("keeps the address when the person's NAME changes", async () => {
    // The case the plain idempotency test above cannot see, found by mutation: removing the
    // early return still passes it, because re-running on an unchanged name UPDATEs the row to
    // the value it already holds — no conflict, same answer.
    //
    // A name change is where it bites. Someone marries, or a typo is corrected, and without the
    // early return their email address silently becomes a different one — while the old address
    // is what they were told and what is printed in Workspace.
    const istid = await addUser("ist9997911", "Rafael Antunes");
    const first = await assignNeiistEmail(istid);
    expect(first).toBe("rafael.antunes@neiist.pt");

    await owner.query("UPDATE neiist.users SET name = $1 WHERE istid = $2", [
      "Rafael Antunes Costa",
      istid,
    ]);

    expect(await assignNeiistEmail(istid)).toBe(first);
  });

  it("refuses a name it cannot fold, rather than inventing an address", async () => {
    const istid = await addUser("ist9997906", "陳大文");
    await expect(assignNeiistEmail(istid)).rejects.toMatchObject({ code: "NEI18" });
  });

  it("refuses an unknown user", async () => {
    await expect(assignNeiistEmail("ist0000000")).rejects.toMatchObject({ code: "NEI18" });
  });

  it("is enforced by the DATABASE, not only by the helper", async () => {
    // The helper avoids collisions; the constraint makes it true. Without this index, two
    // concurrent reservations could both settle on the same address.
    const istid = await addUser("ist9997907", "Rafael Antunes");
    const taken = (await assignNeiistEmail(istid)).split("@")[0];
    const other = await addUser("ist9997908", "Outro Nome");

    await expect(
      owner.query("UPDATE neiist.users SET neiist_email_local = $1 WHERE istid = $2", [
        taken,
        other,
      ])
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("previewing", () => {
  it("shows what the address would be without reserving it", async () => {
    // A preview that reserved would burn an address every time somebody typed a name into the
    // form and changed their mind.
    expect(await previewNeiistEmail("Rafael Antunes")).toBe("rafael.antunes@neiist.pt");

    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::INT AS n FROM neiist.users WHERE neiist_email_local = 'rafael.antunes'"
    );
    expect(rows[0].n).toBe(0);
  });

  it("accounts for addresses already taken", async () => {
    const istid = await addUser("ist9997909", "Rafael Antunes");
    await assignNeiistEmail(istid);
    expect(await previewNeiistEmail("Rafael Antunes")).toBe("rafael.antunes2@neiist.pt");
  });
});

describe("the domain lives in TypeScript, not in the rows", () => {
  it("stores the local part only", async () => {
    // So a future domain change is a constant edit rather than a migration across every row.
    const istid = await addUser("ist9997910", "Rafael Antunes");
    await assignNeiistEmail(istid);
    const { rows } = await owner.query<{ local: string }>(
      "SELECT neiist_email_local AS local FROM neiist.users WHERE istid = $1",
      [istid]
    );
    expect(rows[0].local).toBe("rafael.antunes");
    expect(rows[0].local).not.toContain("@");
  });

  it("maps null to null rather than to a bare domain", async () => {
    expect(toNeiistEmail(null)).toBeNull();
    expect(toNeiistEmail(undefined)).toBeNull();
    expect(toNeiistEmail("")).toBeNull();
  });
});
