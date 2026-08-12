# Prompt for the next session

Copy the block below into a new chat. It is deliberately short: it points at the documents
rather than restating them, so the session spends its context on work instead of on being
told what it can read for itself.

Keep this file updated at the end of each session.

---

```
Continuing work on the NEIIST website fork.

Read these first, in order, and don't re-derive what they already say:
1. CLAUDE.md
2. docs/ai-workflow/project-status.md          <- current state, next steps, board
3. docs/ai-workflow/notion-to-website-plan.md  <- the Notion migration analysis (epic #126)

Where things stand as of 2026-08-12:
- #139, #140, #142 and #144 are MERGED. Wave 2 is done: the data layer is
  src/utils/db/{dbClient,errorMapper,userQueries,eventQueries,shopQueries}.
  src/utils/dbUtils.ts no longer exists. Do not recreate it.
- #145 (#80: transaction support + hardened pool) is open. Verify and merge it first —
  #78/#79/#100 all sit on top of it.
- TRANSACTIONS NOW EXIST, but almost nothing uses them. withTransaction(fn) is in
  dbClient.ts; only 6 of ~64 query functions accept the Querier it hands you. Read the
  three rules in CLAUDE.md §8 before using it — especially: a query function that does
  `catch { return null }` will silently discard the whole transaction, which is why
  withTransaction checks the tag COMMIT returns.
- Still NO tests and no test runner. That one is not a caveat, it is the reason every
  claim in a PR has to say how it was verified.

What I want next, in priority order:

1. #79 then #78 then #100 — the rest of order integrity, now writable.
   All three need plpgsql changes, so: show me the plan and wait. #79 is payment
   finalization -> SumUp-adjacent, do not touch it without my yes.

2. #52 — stand up Vitest (dependency change, ask first). The first test is already
   written as a throwaway: the withTransaction rollback / aborted-COMMIT script from #80.
   Port that, don't invent something new.

3. #111 — serverCheckRoles swallows DynamicServerError. Auth code, so ask. 21 call sites.

4. #146 — ON CONFLICT DO NOTHING on the two user_courses inserts. Schema, so ask.

Rules that matter (full versions in CLAUDE.md):
- Branch + PR on origin. I merge. Never push or PR to neiist-dev/upstream.
- Gates before claiming done: yarn type:check && yarn lint && yarn format:check && yarn build.
  Paste real output. Never weaken a gate to make it pass.
- Every PR states what was NOT verified. Gates prove compilation, nothing more.
- Ask before: schema changes, auth/permission changes, SumUp/payment changes, dependency
  changes, anything touching production.
- neiist.users.istid is VARCHAR(50) and every cast must say ::VARCHAR(50). A ::VARCHAR(10)
  cast truncates external ext_<uuid> istids silently instead of erroring.

Local dev: Postgres is on port 5433 (5432 is taken by another Postgres), set via
POSTGRES_PORT and DATABASE_URL in .env. `role "neiist_app_user" does not exist` means
something connected to 5432 instead. If pages 500 or chunks fail, `yarn clean && yarn build`.
To exercise the data layer without a test runner, compile a single file standalone:
`npx tsc src/utils/db/dbClient.ts --ignoreConfig --outDir <tmp> --module commonjs
--target es2022 --moduleResolution node --esModuleInterop --skipLibCheck`, then run it with
NODE_PATH=./node_modules and PG* env vars. That is how #80 was verified.

Start by reading the three documents, then tell me your plan before writing any code.
```

---

## Why the prompt is shaped this way

- **Documents over prose.** `project-status.md` is the handoff file and is kept current; repeating
  its contents in a prompt guarantees the two drift apart. The prompt's job is to say *which*
  documents matter and *what changed since they were written*.
- **The facts that are easy to get wrong** are stated inline rather than left to be read:
  `dbUtils.ts` is gone, there are no tests, and — as of #80 — transactions *do* exist but almost
  nothing uses them. Each one, if assumed wrong, produces work that has to be thrown away. The
  transaction line is the newest trap: "there are no transactions" was true for months, so a
  session that assumes it will hand-roll a mechanism that already exists.
- **`VARCHAR(50)` is inline** because it is the one rule that fails *silently* — Postgres
  truncates on a narrowing cast rather than erroring, so nothing catches it until external
  accounts break in production.
- **The standalone-compile recipe is inline** because it is the only way to exercise the data
  layer while #52 is open, and it is not discoverable from the repo — there is no script for it.
- **It ends with "tell me your plan before writing code"** because everything at the top of the
  queue is schema, auth or payment code, all of which need approval under CLAUDE.md §9.
