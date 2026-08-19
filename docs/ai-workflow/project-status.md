# Project status — 2026-08-12

**Read this after `CLAUDE.md`. It is the handoff document: enough context to pick the work up
cold, without re-deriving anything.**

---

## 1. What this project is, and what the refactoring is *for*

**NEIIST Website** — the platform of the Computer Science student association at Instituto
Superior Técnico. It serves real students, takes **real money** (SumUp card payments for merch)
and holds **real personal data** (names, emails, phones, NIFs, CVs). Production software.

This repository is **a fork** of `neiist-dev/neiist-website` that has deliberately diverged. The
refactoring has one goal:

> **Make the fork correct, verifiable and maintainable — then bring the good parts of upstream
> into it, without ever regressing what the fork already does better.**

That splits into four threads, in priority order:

1. **Security and money.** An audit found unauthenticated payment confirmation, unauthenticated
   uploads, IDOR on orders, and authorization driven by an unverified JWT. Most are now fixed.
   What remains is **order integrity** — the system has no transactions at all.
2. **Make claims provable.** The repo had no CI, no tests, and gates that passed locally while
   failing in CI. "It should work" is not evidence. Every PR states what was *not* verified.
3. **Remove duplication and dead code.** There were two complete data layers; one had never run.
   That is now resolved.
4. **Converge with upstream, selectively.** ~32 commits behind / 66 ahead. Some upstream work is
   genuinely better; some would *reintroduce bugs this fork already fixed*. Per-file judgement,
   never a bulk merge.
5. **Become the system the núcleo actually runs on.** Threads 1–4 make the site trustworthy;
   this one makes it *used*. NEIIST's real operations live in Notion — events, meetings, tasks,
   a cross-team approval protocol, recruitment, finance — with no access control at all. Moving
   them here is the first work with visible payoff to members rather than to the codebase.
   Tracked as #126; see [`notion-to-website-plan.md`](notion-to-website-plan.md).

> **The through-line:** threads 1–4 are prerequisites for thread 5, not alternatives to it.
> A workflow engine built on a data layer with no transactions and no per-team permissions
> reproduces the exact problem it was meant to solve.

### Fork topology — the hard rule

```
origin    github.com/tomasmbrito/neiist-website     <- the fork. ALL work happens here.
upstream  github.com/neiist-dev/neiist-website      <- fetch-only. NEVER push, NEVER open a PR.
```

Branch + PR on `origin`. **Tomás reviews and merges. Do not self-merge.**

---

## 2. Who logs in — the identity model (settled)

This drives more design than anything else, so it belongs near the top.

Two populations, both supported today:

| | Identity | Login |
|---|---|---|
| **Técnico students** (mainly LEIC/MEIC, but any course) | `istid` from Fenix | Fenix OAuth — the preferred path |
| **Everyone else** (activities, sweats, merch) | synthetic `ext_<uuid>` | Google OAuth |

- **Decided in #82: the identity model is `istid`.** Not UUID. `src/lib/db/repositories/*` — a
  1,053-line parallel data layer targeting a UUID migration that was never applied and had
  **zero call sites** — has been deleted (#119).
- **Multiple courses per student already work.** `neiist.user_courses` is a join table, many rows
  per user. The only bug was that Fenix returns one registration *per enrolment*, so a
  re-registration produced a duplicate course name and the primary key aborted account creation
  entirely (#120/#122). Upstream had the same bug and fixed it the same way — nothing further to
  adopt from them here.
- **Técnico emails are pushed to Fenix**: the Google path rejects `@tecnico.ulisboa.pt`.
- **External users get empty roles**, so the app treats them as `_GUEST` — correct. That reaches
  `/profile`, `/my-orders`, `/shop/cart`, `/shop/checkout`.

> ### ⚠️ `neiist.users.istid` must stay `VARCHAR(50)`
>
> ```
> ext_ + uuid with dashes stripped = 36 chars    fits VARCHAR(50): yes    VARCHAR(10): NO
> ```
>
> **Upstream narrowed it to `VARCHAR(10)`.** They have no external-user feature, so it costs them
> nothing — and would cost us the entire ability to have non-Técnico accounts. This is the
> sharpest example of "the fork is right and upstream is wrong *for us*". Never adopt their
> `users` / `user_courses` column widths.

Open questions in **#124**: account linking on a *verified* alternative email (the safe version
of a real problem — a student whose Google address is their alternative email currently gets a
second, separate account), and which Técnico email domains must be forced down the Fenix path.

---

## 3. What has been done

### Before this work

- CI existed but **had never passed a single run**.
- Authorization was middleware-only on five privileged pages, from an **unverified** JWT.
- Two complete data layers, one of which had never executed.
- `/activities` returned 500 to everyone when the events table was empty.
- A student with two registrations for one degree **could not create an account at all**.

### Merged

| PR | What |
|---|---|
| #69 | Claude Code multi-agent infrastructure (`.claude/`) |
| #96 | Unauthenticated env write in the Notion webhook; unauthenticated upload |
| #97 | `/shop/manage` treated as public — its admin gate was dead code |
| #98 | `package-lock.json` deleted; yarn is authoritative |
| #99 | Order ownership taken from the request body (IDOR) |
| #101 | Middleware authorized from an **unverified** JWT |
| #102 | SumUp payments not bound to the order they paid for |
| #103 | Dark mode; server-side user resolution |
| #106 | `yarn build` needed production secrets; CI gate added |
| #107 | Client bundle — icon barrels, `xlsx`, dynamic imports |
| #109 | **CI had never passed.** `next-env.d.ts` is gitignored, so `tsc` had no image types in a fresh checkout |
| #114 | The measured upstream sync plan |
| #115 | `yarn dev` silently used the wrong database on a port conflict |
| #116 | Page-level authorization on 5 pages + order PII redaction + `/shop/pos` was public |
| #118 | `/activities` 500'd for everyone when Notion was unconfigured or down |
| #119 | Deletes the dead repository layer; ports its two real fixes |
| #120 | Duplicate Fenix courses blocked account creation |
| #123 | External signup collided and failed silently |
| #125 | This document, rewritten as a full context handoff |
| #139 | `middleware.ts` → `proxy.ts` (Next 16 convention) |
| #140 | The Notion migration plan + the Wave 2 plan (docs only) |
| #142 | **Wave 2: `dbUtils.ts` split into `src/utils/db/*`** |

| #145 | **#80: transaction support + a hardened pool.** `withTransaction` in `src/utils/db/dbClient.ts` |

### Open PRs

| PR | What | Gates |
|---|---|---|
| **#148** | **Migration runner** + #146 (`ON CONFLICT` on `user_courses`) | green |
| **#149** | **#111** — Next's control-flow signals escape `serverCheckRoles` | green |
| **#150** | **#52** — Vitest, 5 tests on `withTransaction`, Postgres service container in CI | green, **Tests job included** |
| **#151** | This document, the migration finding, `CLAUDE.md` §4a | green |
| **#161** | **#79 + #154** — atomic payment finalization; bulk mark-as-paid fixed | stacked on #148 |
| **#162** | **#78 + #100** — transition matrix, auto-cancel race, per-user cap | stacked on #161 |

**Merge order: #148 → #150 → #149 → #151 → #161 → #162.** The first four are independent; the
last two are stacked and their diffs collapse once their bases land.

They are independent and can merge in any order. #150 and #148 both touch `tsconfig.json`'s
`include` only in ways that were verified to compose (see #150's body).

### The database had no migration path, and never has had one

This was found while answering "how does a schema change reach production?". The answer was
**it does not, and never did** — verified in this fork *and* in `upstream/main`:

- `docker/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, which Postgres runs **only
  when the data directory is empty**.
- Neither deploy script contained a `psql` step, a migration runner, or any database step.
- `docker/schema.sql` has been edited in **53 commits**.

So **`docker/schema.sql` describes what a *new* database gets. It has never described
production.** #146 was undeployable; #78/#79/#100 were not worth writing. PR #148 fixes it —
see [`database-migrations.md`](database-migrations.md).

**The consequence that is still open: production's actual schema is unmeasured.** It is whatever
`schema.sql` looked like when that volume was created, plus anything typed into a `psql` session
since. A `pg_dump --schema-only` comparison needs production credentials, so it is a human task —
and it should happen **before** the order-integrity batch, which rewrites `set_order_state` and
`new_order` with `CREATE OR REPLACE` over bodies we are currently assuming.

### #142's truncation risk was verified after merge

Google/external login was the only path that mattered: it is the only one that exercises a long
`ext_` istid, which is what the `VARCHAR(50)` casts protect, and Postgres **truncates** on a
`::VARCHAR(10)` cast instead of erroring — so a regression there is silent in both directions.

Four `::VARCHAR(50)` casts present (`userQueries.ts:11,35,50,65`); the `getUser` N+1 fix survived
(`:89-98`). Against the live database, using the exact query text from `userQueries.ts`:

```
add_user(ext_… ::VARCHAR(50))  -> stored 40 chars, intact
get_user(ext_… ::VARCHAR(50))  -> read   40 chars, intact
get_user(ext_… ::VARCHAR(10))  -> 0 rows            <- the regression the cast prevents
::VARCHAR(10) truncates 'ext_9f8c1d2e-…' to 'ext_9f8c1d'  — silently, no error
```

**Correction to a number repeated in several places:** production `ext_` istids are **36**
characters, not 40 — the generator strips the UUID's dashes
(`crypto.randomUUID().replace(/-/g, "")`). The probe above deliberately used the 40-character
dashed form, a stricter test than production, and it still round-tripped.

Not verified: a real browser Google sign-in. That exercises the SQL path, not the OAuth handshake.

### Bugs proven against the live database, not argued about

```
get_order('202608121', NULL)   -> 0 rows     <- getOrderByNumber passed the number as INT id
get_order(NULL, '202608121')   -> 1 row

add_user(..., ARRAY['MEIC-A','MEIC-A'])  -> ERROR duplicate key ... user_courses_pkey
add_user(..., ARRAY['MEIC-A'])           -> succeeds

add_user('ext_msq4uwxt', ...) twice      -> ERROR duplicate key ... users_pkey
```

---

## 4. Current state

```
yarn type:check   PASS      yarn lint      PASS
yarn format:check PASS      yarn build     PASS
CI on main        GREEN     (first green runs in this repository's history)
```

**Still true, and important:**

- **A test runner exists as of #52 (PR #150), with five tests.** That is a beachhead, not
  coverage: ~64 query functions have none. The gates still prove only compilation and
  formatting; they cannot catch wrong totals, missing authorization, race conditions, or React
  effect bugs. **New rule worth keeping: a concurrency fix without a test for it should not
  merge** — that class of bug is invisible to every other gate.
- **Transactions exist as of #80** — `withTransaction` in `src/utils/db/dbClient.ts`. Two
  operations use it (product edit, discount campaign); **everything else is still non-atomic**,
  including all of order handling. The mechanism is there, the conversions are not. Adopting the
  upstream data layer did **not** provide this — theirs is `pool.query()` too (#142).
- **The data layer is now `src/utils/db/*`** (`dbClient`, `errorMapper`, `userQueries`,
  `eventQueries`, `shopQueries`). `src/utils/dbUtils.ts` **no longer exists** — do not recreate it,
  and do not add queries to a single god file again.
- `serverCheckRoles` swallows Next's `DynamicServerError` (#111).
- `deploy-staging.yml` fires on every push to `main`.
- `xlsx` is installed from a SheetJS CDN tarball, outside normal lockfile integrity tooling.

### Local dev gotchas that will each waste an hour

**Wrong database.** If another Postgres holds **5432**, Docker starts the container *without
publishing its port*, `docker compose` exits 0, and the app silently connects elsewhere. Every
page then fails with `role "neiist_app_user" does not exist`. `scripts/dev-db-check.sh` now fails
loudly. To move ours instead, put **both** in `.env`:

```
POSTGRES_PORT=5433
DATABASE_URL=postgresql://neiist_app_user:neiist_app_user_password@127.0.0.1:5433/neiist
```

**Stale build output.** If pages 500 or chunks fail to load, run **`yarn clean && yarn build`**
first. A stale `.next` produces `ChunkLoadError` and 500s on `.js`, `.css` and even `public/`
files — which looks like catastrophe and is not.

---

## 5. How to sync from upstream — the actual procedure

**Never `git merge upstream/main`.** It produces **42 conflicted files at once**, most of them
API routes carrying the #96–#116 security fixes. The failure mode is a security fix silently
reverted. The `guard-git` hook blocks wholesale merges for exactly this reason.

Measured divergence (2026-08-12):

```
32 behind · 60 ahead
145 files changed on their side · 130 ours only · 42 changed by BOTH
```

The 42 is the entire difficulty; the other 233 are mechanical. Both sides refactored the same
layer at once: this fork added Zod validation, domain errors and the security fixes to the API
routes; upstream rewrote the data layer underneath those same routes.

### The pattern — one theme per PR

```bash
git fetch upstream                                   # read-only. NEVER push to upstream.
git log --oneline origin/main..upstream/main         # what they have that we don't
git show <sha>                                       # read the WHOLE commit, every hunk

git switch -c fix/<thing>                            # branch on YOUR fork
# hand-apply only the hunks that are genuinely better. Reject the rest.

yarn type:check && yarn lint && yarn format:check && yarn build
git push -u origin fix/<thing>
gh pr create --repo tomasmbrito/neiist-website       # --repo is REQUIRED; bare gh pr create
                                                     # defaults to the PARENT repo on a fork
```

**#120 is the worked example.** Upstream's `20c9d69` fixed the duplicate-courses bug *and* added
an unrelated `preload` prop to `Hero.tsx`. The fix was taken; the `Hero.tsx` hunk was rejected,
because this fork has its own LCP work there. **Adopt the fix, not the commit.**

### Rules that make it safe

- **Their version is not automatically better.** Their Notion webhook only verifies the signature
  `if (verificationToken)` — an unset token means *no verification at all*. #96 already fixed
  that here. Adopting their file would reopen the hole.
- **Upstream does not use Zod.** For all 42 collisions: *their data-layer imports + our Zod
  validation, auth guard and error handling.*
- **Never adopt `VARCHAR(10)` for `istid`.** See §2.
- **Watch for renames.** They moved `src/middleware.ts` → `src/proxy.ts` and
  `src/utils/authUtils.ts` → `src/lib/auth.ts`. Git shows these as add/delete pairs, not
  conflicts, so a careless resolution leaves **both** files present with our fix in the one
  Next 16 no longer reads. (Next 16 warns on every dev start that `middleware` is deprecated in
  favour of `proxy`, so this rename is worth doing — deliberately, not accidentally.)
- Re-verify the relevant #96–#116 fix after touching any collision file.

Full wave ordering: [`upstream-sync-plan.md`](upstream-sync-plan.md).

---

## 6. Next steps, in order

### Do first — outside the code, blocked by nothing

0. **#141 (P0) — rotate the exposed shared account credential.** A Google account password sits
   in **plaintext** on the Organização de Eventos Home page in Notion, readable by every
   workspace member past and present. Rotate, enable 2FA, purge from the page *and its version
   history*, move to a password manager. Found while analysing the workspace for #126.

### Immediate — this is where the work is now

1. ~~**#80 — transaction support and a hardened pool.**~~ **Done, PR #145.** `withTransaction`
   exists in `src/utils/db/dbClient.ts`, the pool is HMR-guarded and configured with an
   `error` handler, and the two operations in #80's acceptance criteria are atomic. **This
   unblocks #78, #79 and #100** — they are now writable, and they are the next work.
   Three things worth carrying forward:
   - **Only 6 of ~64 query functions take a `Querier`.** Widening is mechanical, but do it per
     operation that needs it, not speculatively.
   - **The other ~58 still swallow their errors**, which is unsafe inside a transaction. That is
     survivable only because `withTransaction` checks the tag `COMMIT` returns and throws if the
     transaction was already aborted. Do not remove that check.
   - **Never put email, SumUp, or any network call inside `withTransaction`** — it holds a pooled
     connection for the round-trip and no rollback can undo it. The discount campaign commits all
     codes first, then sends.
2. ~~**#111 — `serverCheckRoles` swallows `DynamicServerError`.**~~ **Done, PR #149.** The
   `catch` now re-throws anything carrying a string `digest`. Three of the four `force-dynamic`
   exports are gone; `/shop` keeps its, because it is the only one that never touches the
   session, so its only dynamism is a database read — which Next does not treat as a signal.
   Proved by building with no database reachable, including a control run with only the
   re-throw reverted.
   **Left for a decision: `src/app/layout.tsx:40-49` has the identical defect.** `getInitialUser`
   swallows the same signal on every route. Fixing it would make the root layout's session read
   mark the *whole site* dynamic — a rendering decision, not a bug fix. Only `/sitemap.xml` is
   static today, so the cost is small, but it should be chosen deliberately.
3. ~~**#52 — stand up Vitest.**~~ **Done, PR #150.** Five tests on `withTransaction`, ported from
   the #80 throwaway rather than invented, plus a Postgres service container in CI (a *separate*
   job, so the build keeps proving it needs no database). **Each test was checked by mutation** —
   remove the aborted-`COMMIT` check, disable the tripwire, or turn `ROLLBACK` into `COMMIT`, and
   exactly one test fails each time.

### Order integrity is now written — the two operational questions were answered

Tomás answered the two questions that could not come from the code (2026-08-19):

- **The payment flow.** A SumUp online payment finalizes itself; an in-person payment waits for a
  manager to mark it paid. So **`pending` means *pending payment*** and nothing may skip it. The
  strict matrix is correct — `pending → ready` and `pending → delivered` are rejected.
- **`cancelled` can be terminal.** No un-cancel workflow exists, so no `reactivate_order` is
  needed.

The first answer had a consequence that was not obvious: it makes bulk **"Marcar como Pago"** the
load-bearing button of the whole in-person flow — and **it had never worked**. It PATCHes
`{"status":"paid"}`, which the route rejects outright, and every failure surfaced as
`toast.warning("Aviso")`. Filed as **#154** and fixed in #161, which had to land *before* the
matrix in #162 closed the only workaround.

**Still blocking deployment, not merging: #152.** #162 rewrites `set_order_state` and `new_order`
with `CREATE OR REPLACE`, over bodies nobody has verified.

### The original plan, for the remaining detail

**Read [`.claude/plans/order-integrity-batch.md`](../../.claude/plans/order-integrity-batch.md).**
It was refreshed on 2026-08-12: §0 lists what changed under it (the `dbUtils.ts` split, the
arrival of `withTransaction`, the migration runner, and the test runner), and §9 lists what is
still blocking.

**Four questions block it, and two of them cannot be answered from the code** — they are about
how the shop is actually operated, and need a shop manager:

- **R1**: do managers currently bulk-mark `pending` orders as `delivered` without marking them
  paid? Bulk "Marcar como Pago" is *already broken* today (the PATCH route rejects `"paid"`), so
  a workaround may well exist — and the transition matrix would break it on the day it ships.
- **R3**: does anyone un-cancel an order? The fix makes `cancelled` terminal.
- Should `stock_override` bypass the per-user cap for POS sales? (Recommend: no, keep parity.)
- Permissive-superset matrix (recommended) or a strict mirror of the TypeScript one?

**And one new blocker that outranks all of them: measure production's schema first.** See §4
above. The batch rewrites `set_order_state` and `new_order` with `CREATE OR REPLACE` over bodies
nobody has verified.

4. **#78 / #79 / #100 — order integrity (P0), on top of #80.** One root cause: **no transactions
   exist.** All three moved Backlog → Ready: Wave 2 was their blocker and it is merged.
   - #78 an order can be cancelled *after* payment — money taken, stock restocked, customer
     emailed "cancelled"; status can move backwards to mint stock
   - #79 payment finalization is check-then-act across 3 round-trips → double receipts
   - #100 the per-user cap is TOCTOU → double-clicking Checkout yields two items

   Transactions get written into `src/utils/db/*` once, rather than into a `dbUtils.ts` that was
   about to be deleted. **#80 is the keystone** — it is the one that makes the other three
   expressible at all, so it is now item 1 above rather than part of this batch.

### Upstream sync — waves

5. **Wave 1** (103 conflict-free files). Valuable: Google service accounts from env instead of
   credential files on disk; the self-loopback fetch fix; `scripts/*.mts`. **The deploy/PM2
   script fixes touch production → approval.**
6. ~~**Wave 2 — the data layer.**~~ **Done in #142.** `dbUtils.ts` is gone; the data layer is
   `src/utils/db/*`, upstream's boundaries with this fork's contents. Two deliberate exclusions
   remain: **#143** (errorMapper reconciliation + missing accents) and `authUtils.ts` →
   `lib/auth.ts`, which carries #111.
7. **Wave 3** — the 42 collisions, route by route. **Cheaper now**: #142 and #139 converted the
   two structural collisions into import changes.
8. **Wave 4** — the voting system (#92). Additive. **Schema change → approval.** Take the end
   state, not the first commit: there are two follow-up SSE/`pg_notify` leak fixes.
   **Reassess its priority** — #126 found a real consumer (see below).
9. **Wave 5** — #91 dependencies (`nodemailer` 8→9 is major, give it its own PR) and #112 pnpm
   (recommendation: stay on yarn until the sync completes).

### New in this session — the Notion migration (#126)

The NEIIST Notion workspace was analysed directly. **Notion is not a wiki here — it is an
operations database with a workflow on top**: one master `Databases` database with six linked
data sources, plus a cross-team request protocol ("Requerimentos") that is the real product.

Full analysis and 11-phase plan: [`notion-to-website-plan.md`](notion-to-website-plan.md).
Board: epic **#126**, children **#127–#138**, plus **#141**.

**Recommendation of record: do not start Phase 0 until order integrity, #52 and #111 are done.**
Every operation in that epic is a multi-table write, and Phase 0 extends exactly the auth code
#111 is about to change. The one exception is **#127** (read-only Notion-backed events view) —
no new tables, gives the núcleo something visible in days, and validates the Phase 1 model.

It also changes three existing items:
- **#47** (dashboard) and **#130** (Phase 2 dashboard) are the same page — reconcile.
- **#50** (job board) and **#138** (Phase 5 CRM) are the same `businesses` table — reconcile.
- **#92** (voting) gains a real consumer: "Votação Concurso Layout Sweats" is already a manual
  Notion workflow.

### Also open

- **#124** — identity decisions: account linking on a verified alternative email; which Técnico
  domains must use Fenix. **Higher stakes now** — #126 makes members assignees, approvers and
  authors across ten tables.
- **#113** — icon catalogue breadth. The bundle benefit from #107 is **still unmeasured**;
  measuring it needed #105, which is now fixed, so it can finally be done.
- **#104** — theme token sweep; 76 stylesheets have hardcoded colours.
- **#122** — optional schema hardening: `ON CONFLICT DO NOTHING` on the two `user_courses`
  inserts, so the database defends itself instead of trusting every caller.
- **#143** — errorMapper: one mapping mechanism instead of two, and fix Portuguese strings that
  are missing accents (`"ja terminou"`, `"indisponivel"`, `"Quantidade invalida"`) on pages that
  handle money.
- **#146** — `ON CONFLICT DO NOTHING` on the two `user_courses` inserts, split out of #122 so the
  schema decision is tracked rather than parked inside a closed bug. *Schema — approval.*
- **#147** — `withValidation` validates the body **before** the handler runs `serverCheckRoles`, so
  an anonymous `POST /api/shop/discounts` gets a 400 with full Zod field detail for an `_ADMIN`-only
  endpoint instead of a 401. Found while smoke-testing #80's routes; structural and pre-existing.
  Authorize first, then validate — best fixed in the wrapper, since the current shape makes the
  wrong order the default. *Auth — approval.*

### Board state — reconciled 2026-08-12 after Wave 2

Moved, because the facts were unambiguous:

| Item | Change | Why |
|---|---|---|
| **#80** | Backlog → **In review**, P1 → **P0** | PR #145. Its three dependants were already P0; it is the keystone they need |
| **#78 · #79 · #100** | Backlog → **Ready** | Their blocker (Wave 2) is merged, and #80 makes them writable |
| **#52** | Backlog → **Ready / P1 / M** | #126 escalates it, and #80 produced a concrete first test to port |
| **#28** | In review → **Done**, retitled, closed | Delivered by PR #142, merged as `aab9d38` |
| **#121** | In review → **Done**, closed | Criteria verified at runtime — see below |
| **#122** | In review → **Done**, closed | App fix merged in #120; schema half split out as **#146** |
| **#146** | new → **Ready / P1 / XS** | `ON CONFLICT DO NOTHING` on `user_courses`. Schema → approval |
| **#141** | P0 → **P2** | The exposed password is an old one, not the current credential |

**Drift resolved (Tomás delegated the judgement calls):**

- **#28** retitled to "Split the God Object — `dbUtils.ts` into `src/utils/db/*`" and closed. The
  goal was delivered by #142; only the name was wrong. Its task list (`ProductRepository`,
  `OrderRepository`, …) describes a design abandoned when #82 settled on `istid` over UUID, and is
  left as history rather than rewritten.
- **#4** retitled to "Data layer consolidation (repository pattern attempted, superseded by
  `src/utils/db/*`)" and annotated. It stays Done: the *outcome* — one non-duplicated data layer —
  exists, reached by a different route than the title implies.
- **#121 verified and closed.** All four criteria were run against a production build with the
  `activities` table empty: 200 with Notion unconfigured, 200 with Notion configured-but-broken and
  the failure logged (`[activities] Notion sync failed … API token is invalid`), calendar rendering
  rather than the error boundary, and the webhook still returning 500 on a sync failure. That run
  also re-verified **#96** — the webhook returned `503 "Webhook not configured"` with
  `VERIFICATION_TOKEN` unset, i.e. it fails closed where upstream's fails open.
- **#122 closed, and its schema half split out as #146.** The application fix (#120) is in place at
  `userdata/route.ts:67`. Keeping a P0 open to hold a schema decision was hiding that decision
  rather than tracking it. The criterion "a real Fenix login by a multi-registration student
  succeeds" is marked **unverifiable locally** — it needs live Fenix and a specific student's
  registration history — rather than silently ticked.
- **#51/#52 already said Vitest.** That drift item was itself stale: both bodies were corrected in
  an earlier session and carry an explicit "previously specified Jest" note.
- **#141 downgraded P0 → P2.** Tomás confirms the password on that Notion page is an **old** one, so
  there is no live credential exposure. `notion-to-website-plan.md` §1 overstates it. The GDPR half
  of that issue — `Members`, `Recrutamento` and `Encomendas Sweats Verdes` readable by every
  workspace member — is untouched by the correction and is the real argument for #126.

**Still open on the board and genuinely undecided:** nothing from the old drift list. New items
needing a human: **#146** (schema), **#111** (auth), **#52** (dependency).

---

## 7. Working agreements

- Branch + PR on the fork. **Tomás merges.** Never push or PR to `neiist-dev`.
- **Human approval before:** schema changes (`docker/schema.sql`), auth/permission changes,
  SumUp/payment changes, dependency changes, anything touching production.
- **Never weaken a gate to make it pass** — no `any`, no `@ts-expect-error`, no
  `eslint-disable`, no deleted assertion.
- **Never report done when a gate failed.** Paste the actual output.
- **Every PR states what was NOT verified.** This is the most valuable habit here — gates prove
  compilation, and almost every real bug found in this repo was invisible to them. The pattern
  that keeps working: **reproduce the failure against the live database before fixing it, and
  show both the before and after.**
- Record decisions in [`decision-log.md`](decision-log.md), bugs in
  [`problem-registry.md`](problem-registry.md), architecture in
  [`architecture-notes.md`](architecture-notes.md).

### The hooks are enforced, and two of them over-fire

`.claude/hooks/` blocks pushes to `neiist-dev`, commits to `main`, reads of credential files,
SQL string interpolation, `any`, `console.log`. **`guard-secrets` will block a command that
merely *names* a credential file, and `guard-git` will block a branch whose *name* contains
"upstream".** Work around them — rename the branch, rephrase the command. **Do not loosen them.**

`.env` and `.env.example` are outside what the assistant can edit at all, so environment
variables have to be added by hand.

---

## 8. The agent workflow

`.claude/agents/` — `/ship <task>`:

```
planner → (human approves) → implementer → quality ‖ security ‖ test reviewers → delivery
```

**Reviewers never fix their own findings.** They report `file:line` + a concrete failure
scenario; the implementer fixes. That keeps defects visible and the diff attributable. A reviewer
that finds nothing says so.

Two specialists: `data-layer-architect` (SQL, transactions, schema) and `upstream-sync-analyst`.

Skills in `.claude/skills/`: `project-board` (verified GitHub Projects field IDs — use them, do
not re-derive), `quality-gates`, `upstream-sync`.

**Agents, skills and hooks bind at session start.** Create one mid-session and you must restart
Claude Code or it silently will not exist.

---

## 9. The board

**Neiist website board** — `https://github.com/users/tomasmbrito/projects/1`

Titles prefixed `[Epic]` / `[US]` / `[DECISION]`. **P0** security, money, data corruption,
production breakage · **P1** real user impact or blocks other work · **P2** the rest.
Sizes XS <1h · S ½ day · M 1–2 days · L a week · XL split it.

Keep it honest: move items as work actually progresses, and file findings there rather than
leaving them in a chat log.
