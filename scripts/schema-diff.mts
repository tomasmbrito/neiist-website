/**
 * Compare a live database's schema against `docker/schema.sql` (#152).
 *
 * ## Why this exists
 *
 * `docker/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, which Postgres runs only
 * when the data directory is empty. It has been edited in 50+ commits, and until #148 there was
 * no migration path at all — so the file describes what a *new* database gets and has never
 * described production. Nobody knows how far the two have drifted.
 *
 * That matters because migrations 003 and 004 use CREATE OR REPLACE on functions that already
 * exist (`set_order_state`, `new_order`, `remove_valid_department_role`). CREATE OR REPLACE does
 * not warn that the body it is replacing was not the one you expected.
 *
 * ## What it does
 *
 *   1. starts a throwaway postgres:15 container
 *   2. builds a reference database from docker/schema.sql
 *   3. pg_dump --schema-only both it and the target
 *   4. normalises both and prints a unified diff
 *
 * ## Safety
 *
 * **The target is only ever read.** The single statement issued against it is `pg_dump
 * --schema-only`, which takes no locks that block writers and modifies nothing. Nothing here
 * connects to the target with anything but pg_dump, and there is no code path that writes.
 *
 * ## Usage
 *
 *   yarn db:schema-diff "postgresql://user:pass@host:5432/neiist"
 *
 * Pass the connection string as an argument or set SCHEMA_DIFF_TARGET_URL. It is never printed.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const SCHEMA_SQL = fileURLToPath(new URL("../docker/schema.sql", import.meta.url));
const CONTAINER = "neiist_schema_diff_ref";
const REF_PORT = 55432;
const PG_IMAGE = "postgres:15";

const sh = async (file: string, args: string[], opts: Record<string, unknown> = {}) =>
  run(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts });

/**
 * Strip the parts of a dump that differ for reasons that are not drift: server version banners,
 * ownership, blank lines and comments. Without this the diff is unreadable and every run looks
 * different.
 */
const normalise = (dump: string): string =>
  dump
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "" || t.startsWith("--")) return false;
      if (t.startsWith("SET ") || t.startsWith("SELECT pg_catalog.set_config")) return false;
      if (t.startsWith("ALTER ") && t.includes(" OWNER TO ")) return false;
      if (t.startsWith("\\connect") || t.startsWith("\\restrict") || t.startsWith("\\unrestrict"))
        return false;
      return true;
    })
    .join("\n");

const startReference = async (): Promise<void> => {
  await sh("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
  await sh("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_USER=admin",
    "-e",
    "POSTGRES_PASSWORD=admin",
    "-e",
    "POSTGRES_DB=neiist",
    "-p",
    `127.0.0.1:${REF_PORT}:5432`,
    PG_IMAGE,
  ]);

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await sh("docker", ["exec", CONTAINER, "pg_isready", "-U", "admin", "-d", "neiist"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("Reference container did not become ready within 60s.");
};

/**
 * A localhost target is localhost *for the host*, not for a container. Rewrite it so the
 * dockerised pg_dump reaches the same database. A remote production host needs no rewriting.
 */
const reachableFromContainer = (connectionString: string): string =>
  connectionString.replace(/@(localhost|127\.0\.0\.1)([:/])/, "@host.docker.internal$2");

/**
 * pg_dump runs INSIDE a postgres:15 container rather than using whatever client the operator
 * happens to have installed.
 *
 * Found the hard way: a Homebrew pg_dump 14 refuses to dump a 15 server ("aborting because of
 * server version mismatch"). Depending on the host's client version would make this script work
 * on some machines and not others, which for a one-off production task is the worst kind of
 * fragile. Docker is already required for the reference container, so this adds no new
 * prerequisite.
 *
 * --schema-only: no data leaves the target. --no-owner/--no-privileges: role names differ
 * between environments and are not drift.
 */
const dump = async (connectionString: string): Promise<string> => {
  const { stdout } = await sh("docker", [
    "run",
    "--rm",
    "-i",
    "-e",
    `PGCONNECT=${reachableFromContainer(connectionString)}`,
    PG_IMAGE,
    "sh",
    "-c",
    'pg_dump --schema-only --no-owner --no-privileges --schema=neiist "$PGCONNECT"',
  ]);
  return stdout;
};

const main = async (): Promise<void> => {
  const target = process.argv[2] ?? process.env.SCHEMA_DIFF_TARGET_URL;
  if (!target) {
    console.error(
      'Usage: yarn db:schema-diff "postgresql://user:pass@host:5432/neiist"\n' +
        "   or: SCHEMA_DIFF_TARGET_URL=… yarn db:schema-diff\n\n" +
        "The target is only ever READ (pg_dump --schema-only). Nothing is written to it."
    );
    process.exitCode = 1;
    return;
  }

  const workdir = await mkdtemp(join(tmpdir(), "neiist-schema-diff-"));
  try {
    console.log("Reading the target schema (read-only)...");
    const targetDump = await dump(target);

    console.log(`Building a reference database from docker/schema.sql in ${PG_IMAGE}...`);
    await startReference();
    const refUrl = `postgresql://admin:admin@127.0.0.1:${REF_PORT}/neiist`;
    // psql in a container as well, so the whole script needs only Docker. The file is mounted
    // read-only rather than piped: execFile has no stdin `input` option (that is spawnSync), so
    // piping silently left psql waiting on stdin forever.
    await sh("docker", [
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${SCHEMA_SQL}:/schema.sql:ro`,
      PG_IMAGE,
      "psql",
      "--set",
      "ON_ERROR_STOP=1",
      "-q",
      "-f",
      "/schema.sql",
      `postgresql://admin:admin@127.0.0.1:${REF_PORT}/neiist`,
    ]);
    const referenceDump = await dump(refUrl);

    const targetPath = join(workdir, "target.sql");
    const referencePath = join(workdir, "reference.sql");
    await writeFile(targetPath, normalise(targetDump));
    await writeFile(referencePath, normalise(referenceDump));

    console.log("\n=== docker/schema.sql (-)  vs  target database (+) ===\n");
    try {
      await sh("diff", ["-u", referencePath, targetPath]);
      console.log("No differences. The target matches docker/schema.sql.\n");
      console.log("Record that in docs/ai-workflow/database-migrations.md §5 with today's date.");
    } catch (error) {
      // diff exits 1 when files differ, which is the interesting case, not a failure.
      const result = error as { code?: number; stdout?: string };
      if (result.code === 1 && result.stdout) {
        console.log(result.stdout);
        console.log(
          "\nOne difference is EXPECTED and needs no action: neiist.schema_migrations exists\n" +
            "only on databases the runner has touched. scripts/migrate.mts creates it with\n" +
            "CREATE TABLE IF NOT EXISTS, so it is deliberately not declared in schema.sql.\n" +
            "\nEvery other difference is a decision: adopt it into docker/schema.sql (the\n" +
            "target is right), or write a migration to correct it (the repository is right).\n" +
            "Do that BEFORE any migration touches the affected object — see #152.\n" +
            "\nThe ones that matter most are set_order_state, new_order and\n" +
            "remove_valid_department_role: migrations 003 and 004 CREATE OR REPLACE them, and\n" +
            "that does not warn when the body being replaced is not the one you expected."
        );
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  } finally {
    await sh("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  console.error(`\nschema-diff failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
