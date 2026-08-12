# Project status — 2026-08-12

Current state of the fork and what to do next. Read this after `CLAUDE.md`.

---

## 1. Where things stand

`main` is green on all four gates, including `yarn build`, which was **failing** before this
work started.

```
yarn type:check   PASS
yarn lint         PASS
yarn format:check PASS
yarn build        PASS
```

### Merged (2026-08-11 → 12)

| PR | What it fixed |
|---|---|
| #69 | Claude Code multi-agent infrastructure (`.claude/`) |
| #96 | Unauthenticated `.env` write in the Notion webhook; unauthenticated file upload |
| #97 | `/shop/manage` was treated as a public route — its admin gate was dead code |
| #98 | Deleted `package-lock.json`; yarn is authoritative |
| #99 | Order ownership taken from the request body (IDOR) |
| #101 | Middleware authorized from an **unverified** JWT |
| #102 | SumUp payments were not bound to the order they paid for |
| #103 | Dark mode (broken four ways); server-side user resolution |
| #106 | `yarn build` needed production secrets + a live DB; CI gate added |

### Open

- **PR #107** — client bundle: react-icons barrels, `xlsx`, dynamic imports.
  Carries a **decision for a human** (see §5) and an **unverified benefit** (see §4).

---

## 2. The AI workflow

Everything lives in `.claude/`. It is active from session start — if you create a *new* agent,
skill, or hook mid-session, **restart Claude Code** or it will not be picked up.

### Agents (`.claude/agents/`)

```
/ship <task>
   planner        → research, writes a plan file (read-only)
        ↓ human approves
   implementer    → writes code, scoped to the plan
        ↓
   quality-reviewer ‖ security-reviewer ‖ test-engineer   (parallel, read-only)
        ↓ implementer fixes what they found
   delivery       → gates → branch → Conventional Commit → PR → board
```

Plus two specialists: `data-layer-architect` (SQL, transactions, schema) and
`upstream-sync-analyst` (fork vs `neiist-dev`).

**The rule that makes it work: reviewers never fix their own findings.** They report
`file:line` + a concrete failure scenario; the implementer fixes. This keeps defects visible
and the diff attributable.

Run long jobs as background agents with `isolation: "worktree"` so they do not fight over the
working tree. Two ran concurrently on 2026-08-11 with no conflicts.

### Skills (`.claude/skills/`)

- `project-board` — **verified** GitHub Projects field IDs. Use it; do not re-derive them.
- `quality-gates` — what to run, and what green gates *cannot* prove here.
- `upstream-sync` — the fork/upstream divergence and the per-file adoption protocol.

### Hooks (`.claude/hooks/`) — enforced, not advisory

| Hook | Blocks |
|---|---|
| `guard-secrets` | reading/writing `.env` and credential files, including via shell |
| `guard-git` | pushes/PRs to `neiist-dev`; **bare `gh pr create`** (defaults to the parent repo on a fork); commits to `main`; wholesale upstream merges; `reset --hard`; bare `push -f` |
| `check-edit` | SQL string interpolation, `@ts-expect-error`, `eslint-disable`, `any`, `console.log`, `NEXT_PUBLIC_*` secrets |
| `session-context` | injects branch + upstream drift at session start |

All verified firing against live attempts. `guard-secrets` is deliberately broad — it will
block a command that merely *names* `.env`. Work around it; do not loosen it.

---

## 3. The board

**Neiist website board** — `https://github.com/users/tomasmbrito/projects/1`
80 items. Conventions and field IDs are in `.claude/skills/project-board/SKILL.md`.

- Titles are prefixed `[Epic]` / `[US]` / `[DECISION]`.
- **Priority** — P0: security, money, data corruption, production breakage. P1: real user
  impact or blocks other work. P2: the rest.
- **Size** — XS <1h · S ~½ day · M 1–2 days · L ~a week · XL split it.
- Children link to parents with `Part of <issue url>` in the body.

Keep it honest: move items as work actually progresses, and file what you find while working
rather than leaving it in a chat log.

---

## 4. Verification standards — read before claiming anything

Green gates mean "it compiles and is formatted". **There is no test runner and no tests.**
Gates cannot catch wrong totals, missing authorization, race conditions, or React effect bugs.

What this project has learned the hard way:

- **Browser testing catches what code review cannot.** `ThemeToggle` looked correct and was
  never imported anywhere. Only `document.querySelectorAll(...)` on the running page found it.
- **Verify a subagent's headline claim yourself.** For #106 I re-ran the build independently.
  For #107 I tried to and **could not** — `/activities` hits its error boundary without a
  database, so before/after both measured 0.58 MB of two error pages. That is recorded in the
  PR as unverified rather than passed off as confirmed.
- **Say what you did not verify.** Every PR here has a "Not verified" section. Keep that.

---

## 5. Open decisions — these need a human

1. **#82 — identity model: `istid` or UUID.** Blocks everything in #72.
   `src/lib/db/repositories/*` is **dead code with zero call sites** targeting a UUID migration
   that `docker-compose.yml` never applies. Two parallel copies of ~63 DB functions. This is
   the highest-leverage architectural decision available and it gets worse weekly.
2. **PR #107 — icon catalogue.** The picker used to offer ~21,013 icons; it now offers 238,
   with a lazy fallback so existing events keep theirs. Accept, or widen the catalogue.
3. **`serverCheckRoles` swallows `DynamicServerError`.** Its blanket `catch` eats the signal
   Next uses to mark a route dynamic — that is *why* pages needed `force-dynamic` in #106.
   Re-throwing on `digest === "DYNAMIC_SERVER_USAGE"` fixes the class globally. **Auth code —
   needs approval.**
4. **#91 — upstream dependency bumps** (`nodemailer` 8→9, `next`, `react`, `pg`). Dependency
   changes need approval.
5. **pnpm** — upstream migrated; this fork deliberately stayed on yarn. Revisit or leave.

---

## 6. Recommended next steps, in order

1. **#78 / #79 / #100 — order integrity (P0).** All need SQL function changes, so they need
   approval. A `data-layer-architect` plan was in progress when the session ended and did
   **not** get written — regenerate it. The three share one root cause: **no transactions
   exist anywhere**; `db_query` is `pool.query()` and nothing issues `BEGIN`.
   - #78 an order can be cancelled *after* payment (money taken, stock restocked, customer
     emailed "cancelled"); status can move backwards to mint stock
   - #79 payment finalization is check-then-act across 3 round-trips → double receipts
   - #100 the per-user cap is TOCTOU → double-clicking Checkout yields two items
2. **#76 — page-level authorization.** `requireRoles()` exists and is proven on `/shop/manage`.
   `/photo-management`, `/team-management`, `/orders`, `/users-management`,
   `/departments-management` still have none. `/orders` ships every customer's name, email,
   phone and NIF to any member.
3. **#105 — local dev port conflict.** `yarn dev` silently connects to the *wrong* database
   when something else holds `5432`. This blocks browser verification of anything data-backed,
   including #107's benefit.
4. **#52 — test infrastructure (Vitest).** Every fix so far needed a hand-written throwaway
   test. Note #51/#52 said "Jest"; the decision of record is **Vitest**.
5. **#104 — theme token sweep.** Dark mode now *works*, so the 76 stylesheets with hardcoded
   colours are actively wrong rather than merely unstyled.

---

## 7. Working agreements

- Branch + PR on the **fork**; Tomás reviews and merges. Do not self-merge.
- Never push to `upstream` (`neiist-dev`). It is fetch-only.
- Human approval before: schema changes, auth changes, payment changes, dependency changes.
- Never weaken a gate to make it pass.
- Record decisions in `decision-log.md`, bugs in `problem-registry.md`.
