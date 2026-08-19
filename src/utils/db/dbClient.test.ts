import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db_query, withTransaction } from "@/utils/db/dbClient";

/**
 * The first tests in this repository (#52).
 *
 * They are a port of the throwaway script written to verify #80, not something invented for the
 * sake of having tests. Each one corresponds to a failure mode that was reproduced by hand at
 * the time, and three of them are failure modes that are *silent* — the reason they need a
 * regression guard is precisely that nothing goes wrong visibly when they break.
 *
 * These talk to a real database on purpose. `withTransaction`'s whole contract is Postgres
 * behaviour — that COMMIT on an aborted transaction returns the tag ROLLBACK and raises nothing,
 * that a pooled connection is a different transaction — and a mock would only assert that we
 * still believe what we already believed.
 *
 * Two connections are in play, deliberately:
 *   - the code under test uses the app pool (DATABASE_URL), which `docker/schema.sql:11-16`
 *     strips of every table privilege, so it can only reach data through `neiist.*` functions;
 *   - the harness uses an owner connection (MIGRATION_DATABASE_URL) for setup and teardown,
 *     because cleaning up requires a DELETE and there is no `delete_user` function.
 */

const TEST_ISTID = "ist9999001";

let owner: Client;

const ownerConnectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

/** Reads through the same function path the app uses, so a rollback is observed as the app would. */
const userExists = async (istid: string): Promise<boolean> => {
  const result = await db_query<{ istid: string }>(
    "SELECT istid FROM neiist.get_user($1::VARCHAR(50))",
    [istid]
  );
  return result.rowCount !== null && result.rowCount > 0;
};

const removeTestUser = async (): Promise<void> => {
  await owner.query("DELETE FROM neiist.user_courses WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.user_contacts WHERE user_istid = $1", [TEST_ISTID]);
  await owner.query("DELETE FROM neiist.users WHERE istid = $1", [TEST_ISTID]);
};

beforeAll(async () => {
  if (!ownerConnectionString) {
    throw new Error(
      "MIGRATION_DATABASE_URL (or DATABASE_URL) must be set. These tests need a real database; " +
        "see docs/ai-workflow/database-migrations.md §3.5."
    );
  }
  owner = new Client({ connectionString: ownerConnectionString });
  await owner.connect();
  await removeTestUser();
});

afterEach(async () => {
  await removeTestUser();
});

afterAll(async () => {
  await owner.end();
});

describe("withTransaction", () => {
  it("commits the work when the callback returns", async () => {
    await withTransaction(async (q) => {
      await q("SELECT istid FROM neiist.add_user($1::VARCHAR(50), $2, $3)", [
        TEST_ISTID,
        "Transaction Test",
        `${TEST_ISTID}@tecnico.ulisboa.pt`,
      ]);
    });

    expect(await userExists(TEST_ISTID)).toBe(true);
  });

  it("rolls the work back when the callback throws, and re-throws the original error", async () => {
    const boom = new Error("deliberate failure after the write");

    await expect(
      withTransaction(async (q) => {
        await q("SELECT istid FROM neiist.add_user($1::VARCHAR(50), $2, $3)", [
          TEST_ISTID,
          "Transaction Test",
          `${TEST_ISTID}@tecnico.ulisboa.pt`,
        ]);
        // The row is visible inside the transaction...
        throw boom;
      })
    ).rejects.toThrow(boom);

    // ...and gone outside it.
    expect(await userExists(TEST_ISTID)).toBe(false);
  });

  /**
   * The silent one, and the reason the tag check exists.
   *
   * ~58 of the ~64 query functions in this directory still use `catch { return null }`. Inside a
   * transaction that is actively unsafe: the failed statement leaves the transaction aborted, the
   * swallowed error lets the callback return normally, and `COMMIT` on an aborted transaction
   * *succeeds* — Postgres discards the work and reports the command tag `ROLLBACK`, raising
   * nothing. Without the check, the caller is told the operation worked and every write is gone.
   */
  it("throws instead of reporting success when an inner error was swallowed", async () => {
    await expect(
      withTransaction(async (q) => {
        await q("SELECT istid FROM neiist.add_user($1::VARCHAR(50), $2, $3)", [
          TEST_ISTID,
          "Transaction Test",
          `${TEST_ISTID}@tecnico.ulisboa.pt`,
        ]);

        try {
          // Same primary key twice: aborts the transaction.
          await q("SELECT istid FROM neiist.add_user($1::VARCHAR(50), $2, $3)", [
            TEST_ISTID,
            "Transaction Test",
            `${TEST_ISTID}@tecnico.ulisboa.pt`,
          ]);
        } catch {
          // Exactly what the rest of this directory does, and the whole point of the test.
        }
      })
    ).rejects.toThrow(/already aborted at COMMIT/);

    expect(await userExists(TEST_ISTID)).toBe(false);
  });

  /**
   * The other silent one. Forgetting to thread `q` sends the statement to a *different* pooled
   * connection, outside the transaction — nothing errors and atomicity is quietly lost. The
   * AsyncLocalStorage tripwire turns that into a loud failure in development.
   */
  it("rejects a pool query issued while a transaction is open in the same context", async () => {
    await expect(
      withTransaction(async () => {
        await db_query("SELECT 1");
      })
    ).rejects.toThrow(/Pass the `q` from withTransaction/);
  });

  it("returns the callback's value", async () => {
    const result = await withTransaction(async (q) => {
      const rows = await q<{ answer: number }>("SELECT 1 + 1 AS answer");
      return rows.rows[0].answer;
    });

    expect(result).toBe(2);
  });
});
