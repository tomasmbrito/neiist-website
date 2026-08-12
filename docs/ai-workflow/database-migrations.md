# Database migrations

**Read this before editing `docker/schema.sql`.**

---

## 1. The finding that made this necessary

There was no way for a schema change in this repository to reach a database that already had
data. Verified 2026-08-12, in this fork **and** in `upstream/main`:

- `docker/docker-compose.yml:21-22` mounts `schema.sql` and `init.sql` into
  `/docker-entrypoint-initdb.d/`. Postgres runs those **only when the data directory is empty**.
  On a database that already has data, editing `schema.sql` changes nothing.
- `scripts/deploy_prod.sh` and `scripts/deploy_staging.sh` contained **no `psql`, no migration
  runner, no database step of any kind** — they pulled, installed, built, and restarted PM2.
  Upstream's versions are the same in this respect.
- `docker/migrations/001_user_uuid.sql` existed once, was mounted nowhere, was never applied, and
  was deleted in #119.
- `docker/schema.sql` has been edited in **53 commits**.

Two consequences, and the second is the uncomfortable one:

1. **`docker/schema.sql` describes what a *new* database gets. It is not, and has never been, a
   description of the production database.**
2. **Nobody knows what production's schema actually is.** It is whatever `schema.sql` looked like
   when that volume was first created, plus whatever anyone has typed into a `psql` session since.
   Neither is recorded anywhere. This document does not fix that; see §5.

---

## 2. How it works now

```
docker/migrations/NNN_snake_case_name.sql   the migrations, applied in numeric order
scripts/migrate.mts                         the runner
neiist.schema_migrations                    what has been applied, in the database
```

```bash
yarn db:migrate           # apply everything pending
yarn db:migrate:status    # print applied/pending, change nothing
yarn db:migrate:check     # exit 1 if anything is pending (CI)
```

The runner:

- applies each file inside **one transaction**, writing the `schema_migrations` row in that same
  transaction — a migration either applies completely and is recorded, or does neither;
- sends each file as **one query**, never splitting on `;`, because splitting corrupts the
  dollar-quoted `plpgsql` bodies this schema is mostly made of;
- holds a **session advisory lock** for the whole run, so the blue/green deploy cannot run two
  migrators against one database;
- **refuses to run if an already-applied file has changed** (sha256 per file). Migrations are
  append-only history, not editable source;
- checks the tag `COMMIT` returns, for the same reason `withTransaction` does — `COMMIT` on an
  aborted transaction reports `ROLLBACK` and raises nothing;
- refuses to run against a database with no `neiist` schema, rather than emitting a pile of
  "relation does not exist";
- exits non-zero on any failure, which under `set -e` aborts the deploy.

`-- migrate:no-transaction` in the first 400 bytes opts a file out of the transaction, for
statements Postgres refuses inside one (`CREATE INDEX CONCURRENTLY`).

---

## 3. The rules

### 3.1 Every migration must be idempotent

`CREATE OR REPLACE`, `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`.

This is not fastidiousness. It is what makes the runner safe to point at a database whose history
cannot be reconstructed — which is exactly the situation production is in (§1). It also makes a
retry after a half-finished `no-transaction` migration safe.

The runner **cannot enforce this**. It is on the author and the reviewer.

### 3.2 Edit `docker/schema.sql` as well, in the same PR

`schema.sql` stays the full current end state, so a fresh environment gets there without
replaying history. The migration is how *existing* databases catch up. Both, always — a PR that
changes one and not the other is wrong.

### 3.3 Never edit an applied migration

The runner will refuse, by checksum. Fix forward with a new file.

### 3.4 A migration must be backward-compatible with the previous release

`deploy_prod.sh` runs migrations **after the build, before the restart**, so the *previous*
release serves traffic against the migrated schema for the length of the deploy. Blue/green also
means both releases are briefly live at once. Dropping a column or narrowing a signature that the
running release still uses takes the site down.

For a genuinely breaking change, use the standard two-release dance: add the new thing, deploy,
migrate the callers, deploy, then remove the old thing in a later release.

### 3.5 Migrations need the owner role, not the app role

`docker/schema.sql:11-16` deliberately strips `neiist_app_user` of every table privilege — it can
execute functions and nothing else, so it cannot run DDL.

```
DATABASE_URL             the application role. Used by the app. Cannot migrate.
MIGRATION_DATABASE_URL   the owner/superuser role. Used only by scripts/migrate.mts.
```

Locally that is the `admin` account from `docker/docker-compose.yml`:

```
MIGRATION_DATABASE_URL=postgresql://admin:admin@127.0.0.1:5433/neiist
```

The runner falls back to `DATABASE_URL` with a warning, so a missing variable fails with a clear
`permission denied` rather than a confusing `undefined connection string`.

---

## 4. Writing one

1. `docker/migrations/002_what_it_does.sql` — next free number, `snake_case`, idempotent, with a
   header comment saying *why*, not what.
2. Make the same change in `docker/schema.sql`.
3. `yarn db:migrate:status` → confirm it shows as pending.
4. **Reproduce the problem against the live local database first**, then `yarn db:migrate`, then
   show the same command succeeding. That before/after is what goes in the PR body.
5. `yarn type:check && yarn lint && yarn format:check && yarn build`.

---

## 5. What is still not solved

**Production's actual schema is unmeasured.** The runner will apply migration `001` onward to it,
and because every migration is idempotent that is safe — but it does not tell us whether
production already diverges from `docker/schema.sql` in ways no migration will correct (a column
someone added by hand, a function body edited in a `psql` session, an index that was never
created).

Measuring it needs a `pg_dump --schema-only` of production compared against a container built from
`docker/schema.sql`. That needs production credentials and is therefore a task for a human, not
for an agent. **It should be done before the order-integrity batch (#78/#79/#100)**, whose
migrations rewrite `set_order_state` and `new_order` — functions whose production bodies we are
currently assuming, not verifying.

**There is no `--baseline` use case yet.** The flag exists for a database created from the current
`schema.sql` that therefore already contains everything the migrations would do. Since every
migration here is idempotent, applying them normally is also correct and is the safer default.
It is deliberately awkward to reach (`--yes` when not a TTY).

**Migrations do not run in CI against a real database.** `yarn db:migrate:check` exists for that;
wiring it up needs a Postgres service container in `ci.yml`.
