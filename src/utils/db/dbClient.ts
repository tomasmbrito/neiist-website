import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * A function that runs one SQL statement. `db_query` is the pool-backed implementation; inside
 * `withTransaction` the callback receives a client-backed one bound to a single connection.
 *
 * Query functions that need to participate in a transaction take this as an optional trailing
 * parameter defaulting to `db_query`, so the same function works inside and outside one.
 *
 * The `_` prefixes are required: parameter names in a type position are documentation only, and
 * the configured `no-unused-vars` (`argsIgnorePattern: "^_"`) reports them otherwise.
 */
export type Querier = <T extends QueryResultRow>(
  _text: string,
  _params?: unknown[]
) => Promise<QueryResult<T>>;

/**
 * Exactly one pool per process. It is cached on `globalThis` because Next's dev server
 * re-evaluates module scope on every hot reload, and a plain module-level `new Pool()` leaks one
 * pool per edit until the database refuses connections.
 */
const globalForDb = globalThis as unknown as {
  neiistPgPool?: Pool;
};

const createPool = (): Pool => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Deliberately explicit rather than relying on pg's defaults.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Global to every connection. A statement that outlives this is aborted by Postgres, which
    // is preferable to one holding a pooled connection indefinitely.
    statement_timeout: 15_000,
  });

  // Without this handler an error on an *idle* pooled client is an unhandled 'error' event, and
  // Node terminates the process. The client is already being removed from the pool by pg; there
  // is nothing to do here but log and stay alive.
  pool.on("error", (error) => {
    console.error("Idle database client error:", error);
  });

  return pool;
};

const pool = (globalForDb.neiistPgPool ??= createPool());

/**
 * Tracks whether the current async context is inside `withTransaction`. Used only to detect a
 * mistake: see `assertNotInsideTransaction`.
 */
const transactionContext = new AsyncLocalStorage<{ active: boolean }>();

/**
 * Threading a transaction explicitly has one silent failure mode: forget to pass the callback's
 * `q` down to a query function, and that statement runs on a *different* pooled connection,
 * outside the transaction. Nothing errors and atomicity is quietly lost.
 *
 * So a pool query issued while a transaction is open in the same async context is always a
 * threading bug. It throws in development, where it is cheap to notice and there is no test
 * runner to catch it otherwise (#52), and logs in production, where breaking a request that
 * would otherwise have completed is the worse outcome.
 */
const assertNotInsideTransaction = (text: string): void => {
  if (!transactionContext.getStore()?.active) return;

  const message =
    "Query issued on the pool while a transaction is open in this async context. " +
    "Pass the `q` from withTransaction() into the query function instead, or it will " +
    `run outside the transaction: ${text.slice(0, 120)}`;

  if (process.env.NODE_ENV === "production") {
    console.error(message);
    return;
  }
  throw new Error(message);
};

export const db_query = async <T extends QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => {
  assertNotInsideTransaction(text);
  try {
    return await pool.query<T>(text, params);
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
};

const clientQuerier =
  (client: PoolClient): Querier =>
  async <T extends QueryResultRow>(text: string, params?: unknown[]) => {
    try {
      return await client.query<T>(text, params);
    } catch (error) {
      console.error("Database query error (in transaction):", error);
      throw error;
    }
  };

/**
 * Runs `fn` inside a single database transaction on a single connection, committing if it
 * returns and rolling back if it throws.
 *
 * Every query that must be part of the transaction has to go through the `q` passed to `fn`.
 * `db_query` cannot be used: it takes an arbitrary connection from the pool, which is a
 * different transaction by definition.
 *
 * **Any query function called with `q` must propagate its errors.** The `catch (e) { return
 * null }` pattern used elsewhere in this directory is actively unsafe here: the failed statement
 * leaves the transaction aborted, the swallowed error means `fn` returns normally, and `COMMIT`
 * on an aborted transaction *succeeds* — Postgres returns the command tag `ROLLBACK` and raises
 * nothing. The writes are discarded and the caller is told the operation worked. See
 * `docs/ai-workflow/problem-registry.md`.
 *
 * Do not perform non-database side effects (sending email, calling SumUp) inside `fn`. They hold
 * a pooled connection open for the duration of a network round-trip, and a rollback cannot
 * undo them.
 */
export const withTransaction = async <T>(fn: (_q: Querier) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  let rollbackFailure: Error | undefined = undefined;

  try {
    await client.query("BEGIN");
    const result = await transactionContext.run({ active: true }, () => fn(clientQuerier(client)));

    // COMMIT on an aborted transaction does NOT fail — Postgres discards the work and reports the
    // command tag `ROLLBACK` instead of `COMMIT`, raising nothing. Without this check a query
    // function that swallowed its error (the pattern most of this directory still uses) would
    // hand the caller a successful return and silently lose every write. Verified: without it,
    // `withTransaction` returns normally and the update is gone.
    const commit = await client.query("COMMIT");
    if (commit.command === "ROLLBACK") {
      throw new Error(
        "Transaction was already aborted at COMMIT, so every write in it was discarded. " +
          "A query inside this transaction failed and its error was swallowed instead of " +
          "propagating — find it and let it throw."
      );
    }

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // A ROLLBACK on a connection that is already gone throws. Reporting that instead of the
      // original error would hide the actual cause, so it is logged, kept only to decide whether
      // the connection is reusable, and dropped.
      console.error("Failed to roll back transaction:", rollbackError);
      rollbackFailure = rollbackError as Error;
    }
    throw error;
  } finally {
    // A transaction that rolled back cleanly leaves a healthy connection, so it goes back to the
    // pool. A ROLLBACK that itself failed leaves one in an unknown state: passing the error to
    // release() destroys it rather than handing it to the next request.
    client.release(rollbackFailure);
  }
};
