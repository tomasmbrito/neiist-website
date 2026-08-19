/**
 * Forward-only SQL migration runner for the NEIIST database.
 *
 * ## Why this exists
 *
 * Until now there was no way for a schema change in this repository to reach a database that
 * already had data. `docker/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, which
 * Postgres runs **only when the data directory is empty**, and neither `deploy_prod.sh` nor
 * `deploy_staging.sh` contained a `psql` step. `docker/schema.sql` has been edited 53 times.
 * Every one of those edits reached fresh environments only.
 *
 * So `docker/schema.sql` describes what a *new* database gets. It is not, and has never been,
 * a description of the production database. See `docs/ai-workflow/database-migrations.md`.
 *
 * ## The contract
 *
 * - Migrations live in `docker/migrations/NNN_snake_case_name.sql`, applied in numeric order.
 * - Each file runs inside **one transaction**, then its row is written to
 *   `neiist.schema_migrations` in that same transaction. A migration either applies completely
 *   and is recorded, or does neither.
 * - **Every migration must be idempotent** — `CREATE OR REPLACE`, `IF NOT EXISTS`,
 *   `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`. This is what makes the runner safe to
 *   point at a database whose history we cannot reconstruct, which is exactly the situation
 *   production is in. It is a rule the runner cannot enforce; it is on the author and reviewer.
 * - Any change to a file that has already been applied is a **hard error**. Migrations are
 *   append-only history, not editable source. Fix forward with a new file.
 * - `docker/schema.sql` must be edited *as well*, so fresh environments still get the end state
 *   without replaying history.
 *
 * ## Usage
 *
 *   yarn db:migrate            apply everything pending
 *   yarn db:migrate:status     print applied/pending, change nothing
 *   yarn db:migrate --dry-run  same as status, but exits 1 if anything is pending (for CI)
 *   yarn db:migrate --baseline record every pending migration as applied WITHOUT running it
 *
 * `--baseline` is for a database that was just created from the current `docker/schema.sql` and
 * therefore already contains everything the migrations would do. Using it on any other database
 * silently skips real work, so it prints what it is about to do and requires `--yes` when stdin
 * is not a TTY.
 *
 * ## Credentials
 *
 * `DATABASE_URL` is the *application* role, and `docker/schema.sql:11-16` revokes all table
 * privileges from it on purpose — it can execute functions and nothing else, so it cannot run
 * DDL. Migrations therefore connect as `MIGRATION_DATABASE_URL`, the owner/superuser role
 * (locally, the `admin` account from `docker/docker-compose.yml`). It falls back to
 * `DATABASE_URL` only so a misconfiguration fails with a clear "permission denied" rather than
 * a confusing "undefined connection string".
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../docker/migrations/", import.meta.url));

/**
 * Serialises concurrent runners. `deploy_prod.sh` is blue/green: during a deploy two app
 * directories exist and a retried or overlapping workflow run can invoke this twice against one
 * database. Session-scoped rather than transaction-scoped, because the run is several
 * transactions.
 */
const ADVISORY_LOCK_KEY = 4_209_115_501;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 1_000;

/** A file whose first 400 bytes contain this runs outside a transaction (e.g. CREATE INDEX CONCURRENTLY). */
const NO_TRANSACTION_MARKER = "migrate:no-transaction";

type Migration = {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  inTransaction: boolean;
};

type AppliedRow = {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
};

const FILENAME_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const loadMigrations = async (): Promise<Migration[]> => {
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const filename of sqlFiles) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new Error(
        `Migration filename "${filename}" does not match NNN_snake_case_name.sql. ` +
          "Ordering is by the numeric prefix, so an unparseable name has no defined position."
      );
    }

    const [, version, name] = match;
    const previous = seen.get(version);
    if (previous) {
      throw new Error(
        `Two migrations share version ${version}: "${previous}" and "${filename}". ` +
          "Versions are the primary key; renumber one of them."
      );
    }
    seen.set(version, filename);

    const sql = await readFile(`${MIGRATIONS_DIR}${filename}`, "utf8");
    migrations.push({
      version,
      name,
      filename,
      sql,
      checksum: sha256(sql),
      inTransaction: !sql.slice(0, 400).includes(NO_TRANSACTION_MARKER),
    });
  }

  // Numeric, not lexicographic: "0010" must sort after "009".
  migrations.sort((a, b) => Number(a.version) - Number(b.version));
  return migrations;
};

const acquireLock = async (client: Client): Promise<void> => {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ADVISORY_LOCK_KEY]
    );
    if (result.rows[0]?.locked) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `Could not acquire the migration advisory lock within ${LOCK_TIMEOUT_MS / 1000}s. ` +
          "Another migration run is in progress, or a previous one died holding the lock — " +
          "in which case its connection must be closed before this can proceed."
      );
    }
    console.warn("Another migration run holds the lock; waiting...");
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
};

/**
 * A migration references `neiist.*` objects that `docker/schema.sql` creates, so running against
 * a database that was never initialised produces a pile of "relation does not exist" errors that
 * all mean the same thing. Say it once, clearly, instead.
 */
const assertSchemaExists = async (client: Client): Promise<void> => {
  const result = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'neiist'"
  );
  if (result.rowCount === 0) {
    throw new Error(
      "The 'neiist' schema does not exist in this database. Migrations build on top of " +
        "docker/schema.sql, they do not replace it. Initialise the database first " +
        "(locally: yarn db:reset)."
    );
  }
};

const ensureMigrationsTable = async (client: Client): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS neiist.schema_migrations (
      version     TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER,
      baselined   BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
};

const readApplied = async (client: Client): Promise<Map<string, AppliedRow>> => {
  const result = await client.query<AppliedRow>(
    "SELECT version, name, checksum, applied_at FROM neiist.schema_migrations ORDER BY version"
  );
  return new Map(result.rows.map((row) => [row.version, row]));
};

/**
 * An applied migration whose file has since changed means the database and the repository
 * disagree about what was run, and no amount of further migrating reconciles them. Refuse.
 */
const assertNoChecksumDrift = (migrations: Migration[], applied: Map<string, AppliedRow>): void => {
  const drifted = migrations.filter((migration) => {
    const row = applied.get(migration.version);
    return row !== undefined && row.checksum !== migration.checksum;
  });

  if (drifted.length === 0) return;

  const detail = drifted
    .map((migration) => `  ${migration.filename} (applied ${applied.get(migration.version)?.name})`)
    .join("\n");

  throw new Error(
    `These migrations were already applied but their files have changed since:\n${detail}\n` +
      "Migrations are append-only history. Revert the edit and write a new migration instead."
  );
};

const applyMigration = async (client: Client, migration: Migration): Promise<number> => {
  const started = Date.now();

  const record = async (durationMs: number): Promise<void> => {
    await client.query(
      `INSERT INTO neiist.schema_migrations (version, name, checksum, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.checksum, durationMs]
    );
  };

  if (!migration.inTransaction) {
    // Opt-out for statements Postgres refuses inside a transaction block. The bookkeeping row is
    // written after the fact, so a crash mid-file leaves the migration pending and it must be
    // idempotent to survive the retry — which every migration here has to be anyway.
    await client.query(migration.sql);
    const duration = Date.now() - started;
    await record(duration);
    return duration;
  }

  await client.query("BEGIN");
  try {
    // The whole file goes in one query on purpose. Splitting on ";" corrupts dollar-quoted
    // plpgsql bodies, which is most of what this schema is made of.
    await client.query(migration.sql);
    await record(Date.now() - started);
    const commit = await client.query("COMMIT");

    // Same trap as withTransaction in src/utils/db/dbClient.ts: COMMIT on an aborted transaction
    // reports the tag ROLLBACK and raises nothing.
    if (commit.command === "ROLLBACK") {
      throw new Error("Transaction was already aborted at COMMIT; nothing in it was applied.");
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback failed:", rollbackError);
    }
    throw error;
  }

  return Date.now() - started;
};

const printStatus = (migrations: Migration[], applied: Map<string, AppliedRow>): Migration[] => {
  const pending = migrations.filter((migration) => !applied.has(migration.version));

  console.log(`\n${applied.size} applied, ${pending.length} pending\n`);
  for (const migration of migrations) {
    const row = applied.get(migration.version);
    const marker = row ? "applied" : "PENDING";
    const when = row ? row.applied_at.toISOString() : "";
    console.log(`  [${marker}] ${migration.filename} ${when}`);
  }

  // Rows in the database with no file: someone deleted a migration, or this database is ahead of
  // this checkout. Not fatal — a rollback to an older release is a legitimate way to see it.
  const orphans = [...applied.keys()].filter(
    (version) => !migrations.some((migration) => migration.version === version)
  );
  if (orphans.length > 0) {
    console.warn(
      `\n  ${orphans.length} migration(s) recorded in the database have no file here: ` +
        `${orphans.join(", ")}. This checkout is older than the database, or a file was deleted.`
    );
  }
  console.log("");

  return pending;
};

const run = async (): Promise<void> => {
  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has("--status");
  const dryRun = args.has("--dry-run");
  const baseline = args.has("--baseline");
  const assumeYes = args.has("--yes");

  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set. Migrations need the database " +
        "owner role: DATABASE_URL is the application role, which schema.sql deliberately " +
        "strips of every table privilege and cannot run DDL."
    );
  }
  if (!process.env.MIGRATION_DATABASE_URL) {
    console.warn(
      "MIGRATION_DATABASE_URL is not set; falling back to DATABASE_URL. If that is the " +
        "application role this will fail with 'permission denied'."
    );
  }

  const migrations = await loadMigrations();
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await assertSchemaExists(client);
    await acquireLock(client);
    await ensureMigrationsTable(client);

    const applied = await readApplied(client);
    assertNoChecksumDrift(migrations, applied);

    const pending = printStatus(migrations, applied);

    if (statusOnly) return;

    if (dryRun) {
      if (pending.length > 0) {
        console.error(`${pending.length} migration(s) pending. Run: yarn db:migrate`);
        process.exitCode = 1;
      }
      return;
    }

    if (pending.length === 0) {
      console.log("Nothing to apply.");
      return;
    }

    if (baseline) {
      if (!assumeYes && !process.stdin.isTTY) {
        throw new Error(
          "--baseline records migrations as applied WITHOUT running them, which is only correct " +
            "for a database freshly created from docker/schema.sql. Re-run with --yes to confirm."
        );
      }
      for (const migration of pending) {
        await client.query(
          `INSERT INTO neiist.schema_migrations (version, name, checksum, duration_ms, baselined)
           VALUES ($1, $2, $3, 0, TRUE)`,
          [migration.version, migration.name, migration.checksum]
        );
        console.log(`  baselined ${migration.filename} (not executed)`);
      }
      console.log(`\nBaselined ${pending.length} migration(s).`);
      return;
    }

    for (const migration of pending) {
      process.stdout.write(`  applying ${migration.filename} ... `);
      const duration = await applyMigration(client, migration);
      console.log(`ok (${duration}ms)`);
    }

    console.log(`\nApplied ${pending.length} migration(s).`);
  } finally {
    // Releases the advisory lock with it; an explicit unlock would be lost anyway if the process
    // died before reaching it.
    await client.end();
  }
};

run().catch((error: unknown) => {
  console.error(`\nMigration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
