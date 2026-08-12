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
2. docs/ai-workflow/project-status.md          <- current state, next steps, board drift
3. docs/ai-workflow/notion-to-website-plan.md  <- the Notion migration analysis (epic #126)

Where things stand as of 2026-08-12:
- #139 (middleware.ts -> proxy.ts) and #140 (planning docs) are MERGED.
- #142 (Wave 2: dbUtils.ts split into src/utils/db/*) is open. Verify and merge it before
  starting anything new — it touches 65 files and every later change sits on top of it.
- The data layer is now src/utils/db/{dbClient,errorMapper,userQueries,eventQueries,shopQueries}.
  src/utils/dbUtils.ts no longer exists. Do not recreate it.
- Still no tests, still no transactions. Both are load-bearing facts, not caveats.

What I want next, in priority order:

1. #141 (P0) — I need to rotate the exposed Notion credential myself. Just remind me.

2. Order integrity: #80 first (transaction support + single pool), then #79, #78, #100.
   This is now unblocked — Wave 2 is done, so transactions land in src/utils/db/* once.
   #80 is the keystone; the other three are unexpressible without it.
   Schema/payment code -> ask me before touching anything.

3. #52 — stand up Vitest. Decision of record is Vitest, not Jest, whatever #51/#52 say.
   Write the first real regression test against whatever #80 produces.

Rules that matter (full versions in CLAUDE.md):
- Branch + PR on origin. I merge. Never push or PR to neiist-dev/upstream.
- Gates before claiming done: yarn type:check && yarn lint && yarn format:check && yarn build.
  Paste real output. Never weaken a gate to make it pass.
- Every PR states what was NOT verified. There are no tests; gates prove compilation only.
- Ask before: schema changes, auth/permission changes, SumUp/payment changes, dependency
  changes, anything touching production.
- neiist.users.istid is VARCHAR(50) and every cast must say ::VARCHAR(50). A ::VARCHAR(10)
  cast truncates external ext_<uuid> istids silently instead of erroring.

Local dev: Postgres is on port 5433 (5432 is taken), set via POSTGRES_PORT and DATABASE_URL
in .env. If pages 500 or chunks fail to load, try `yarn clean && yarn build` first.

Start by reading the three documents, then tell me your plan for #80 before writing any code.
```

---

## Why the prompt is shaped this way

- **Documents over prose.** `project-status.md` is the handoff file and is kept current; repeating
  its contents in a prompt guarantees the two drift apart. The prompt's job is to say *which*
  documents matter and *what changed since they were written*.
- **The three facts that are easy to get wrong** are stated inline rather than left to be read:
  `dbUtils.ts` is gone, there are no tests, there are no transactions. Each one, if assumed
  wrong, produces work that has to be thrown away.
- **`VARCHAR(50)` is inline** because it is the one rule that fails *silently* — Postgres
  truncates on a narrowing cast rather than erroring, so nothing catches it until external
  accounts break in production.
- **It ends with "tell me your plan before writing code"** because #80 is transaction
  infrastructure touching payments, which needs approval under CLAUDE.md §9 anyway.
