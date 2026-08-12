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
4. **Converge with upstream, selectively.** 32 commits behind / 60 ahead. Some upstream work is
   genuinely better; some would *reintroduce bugs this fork already fixed*. Per-file judgement,
   never a bulk merge.

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
> ext_ + uuid = 36 chars    fits VARCHAR(50): yes    fits VARCHAR(10): NO
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

### Open PRs — all CI-green

| PR | What | Needs before merge |
|---|---|---|
| **#118** | `/activities` 500'd for everyone when Notion was unconfigured or down | — |
| **#119** | Deletes the dead repository layer; ports its two real fixes | **Log in and load `/profile`** — the `getUser` change is unreachable without a session |
| **#120** | Duplicate Fenix courses blocked account creation | One real Fenix login by a multi-registration student |
| **#123** | External signup collided and failed silently | One real Google sign-in |

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

- **No tests and no test runner** (#52). Gates prove compilation and formatting. They cannot
  catch wrong totals, missing authorization, race conditions, or React effect bugs.
- **No transactions anywhere.** `db_query` is `pool.query()`, so nothing can issue `BEGIN`.
  Every multi-table write is non-atomic by construction. **Adopting the upstream data layer will
  not fix this** — theirs is still `pool.query()`.
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

### Immediate — no approval needed

1. **Merge the four open PRs** after the verification each one asks for (§3).
2. **#111 — `serverCheckRoles` swallows `DynamicServerError`.** Its blanket `catch` eats the
   signal Next uses to mark a route dynamic; that is why pages needed `force-dynamic`. Re-throw
   anything with a `digest`. 21 call sites, so high leverage. *Auth code — approval.*
3. **#52 — stand up Vitest.** Every fix so far needed a hand-written throwaway. The decision of
   record is **Vitest**, not Jest, whatever #51/#52 say.

### The big one — needs approval (schema)

4. **#78 / #79 / #80 / #100 — order integrity (P0).** One root cause: **no transactions exist.**
   - #78 an order can be cancelled *after* payment — money taken, stock restocked, customer
     emailed "cancelled"; status can move backwards to mint stock
   - #79 payment finalization is check-then-act across 3 round-trips → double receipts
   - #100 the per-user cap is TOCTOU → double-clicking Checkout yields two items

   Sequence this **after** Wave 2 of the sync, so transactions get written once rather than into
   a `dbUtils.ts` that is about to be split.

### Upstream sync — waves

5. **Wave 1** (103 conflict-free files). Valuable: Google service accounts from env instead of
   credential files on disk; the self-loopback fetch fix; `scripts/*.mts`. **The deploy/PM2
   script fixes touch production → approval.**
6. **Wave 2 — the data layer.** Unblocked now #82 is decided. Adopt
   `src/utils/db/{dbClient,errorMapper,userQueries,shopQueries,eventQueries}.ts`, reconcile their
   `errorMapper` with our `src/lib/errors/*`, retire `dbUtils.ts` across its ~56 importers.
   **Keep `VARCHAR(50)`.**
7. **Wave 3** — the 42 collisions, route by route.
8. **Wave 4** — the voting system (#92). Additive. **Schema change → approval.** Take the end
   state, not the first commit: there are two follow-up SSE/`pg_notify` leak fixes.
9. **Wave 5** — #91 dependencies (`nodemailer` 8→9 is major, give it its own PR) and #112 pnpm
   (recommendation: stay on yarn until the sync completes).

### Also open

- **#124** — identity decisions: account linking on a verified alternative email; which Técnico
  domains must use Fenix.
- **#113** — icon catalogue breadth. The bundle benefit from #107 is **still unmeasured**;
  measuring it needed #105, which is now fixed, so it can finally be done.
- **#104** — theme token sweep; 76 stylesheets have hardcoded colours.
- **#122** — optional schema hardening: `ON CONFLICT DO NOTHING` on the two `user_courses`
  inserts, so the database defends itself instead of trusting every caller.

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
