# Plan — Wave 2: adopt upstream's data-layer structure (+ the proxy.ts rename)

Status: **awaiting approval**
Date: 2026-08-12
Sequenced before: #78 / #79 / #80 / #100 (order integrity)

---

## 1. Why this goes first

Transactions have to be written into whichever data layer exists. `src/utils/dbUtils.ts`
is 1,080 lines / 64 exports and upstream has already deleted it. Writing transactional
order handling into it and *then* splitting the file means doing the same work twice, and
every line added to `dbUtils.ts` in the meantime is a line written against a file that no
longer exists on the other side of the sync.

`docs/ai-workflow/project-status.md:248` already says this ("Sequence this **after** Wave 2
of the sync"). This plan executes that sequencing; it does not change it.

Prerequisite from the status doc — "merge the four open PRs" — is **done**. The only PR
open on the fork is release-please's `chore(main): release 2.0.0`.

---

## 2. The load-bearing correction to "adopt upstream's split"

Adopt the **structure**. Do not adopt the **contents**. Measured, not assumed:

Export-name overlap between `src/utils/dbUtils.ts` and upstream's
`src/utils/db/{dbClient,errorMapper,userQueries,shopQueries,eventQueries}.ts`:

```
fork exports              64
upstream split exports    63
shared by name            62
fork-only                 mapDeleteProductDbErrorToResponse, throwIfOrderDbError
upstream-only             parseDatabaseError
```

So the file carve-up is near-perfectly mechanical. The bodies are not. Taking upstream's
files as-is would regress three fixes this fork already ships:

### 2.1 `VARCHAR(10)` is baked into the query casts, not just the schema

The status doc warns about the *column* width. It is also in four upstream call sites:

```
upstream src/utils/db/userQueries.ts:104  add_user($1::VARCHAR(10), ...)
upstream src/utils/db/userQueries.ts:127  update_user($1::VARCHAR(10), $2::JSONB)
upstream src/utils/db/userQueries.ts:137  update_user_photo($1::VARCHAR(10), $2::TEXT)
upstream src/utils/db/userQueries.ts:144  get_user($1::VARCHAR(10))
```

`ext_` + uuid = 36 chars. A `::VARCHAR(10)` cast in Postgres **truncates silently** — it
does not error. Every external (Google OAuth) account would be looked up and written under
a 10-character prefix. The fork's `dbUtils.ts` uses `::VARCHAR(50)` at all four sites
(lines 59, 83, 98, 113). **Keep `VARCHAR(50)` everywhere; no `docker/schema.sql` change,
so no schema approval needed.**

### 2.2 Upstream's `getUser` still has the N+1

Upstream `userQueries.ts` awaits `get_department_role_order` inside
`for (const membership of memberships)`. The fork fixed this in #119 — role orders are
fetched once per *distinct* department, in parallel (`dbUtils.ts:133-146`). `getUser` runs
inside `serverCheckRoles`, i.e. on every guarded page and API route. **Port the fork's
version into `userQueries.ts`; do not take upstream's.**

### 2.3 `errorMapper` vs `src/lib/errors/*`

Upstream's `parseDatabaseError` is a ~30-branch `message.includes(...)` table returning
`DatabaseError` with a Portuguese string and an HTTP status. The fork routes domain errors
through `apiErrorHandler`.

Resolution (matches sync-plan step 3): keep the fork's `apiErrorHandler` as the boundary,
port upstream's Portuguese message table as the *content* behind it. The fork's two
one-off mappers (`mapDeleteProductDbErrorToResponse`, `throwIfOrderDbError`) fold into that
table rather than surviving as separate exports.

### 2.4 What this does *not* fix

Upstream's `dbClient.ts` is 18 lines and is `pool.query()` in a try/catch. **No transaction
support.** #78/#79/#80/#100 remain entirely open after this wave — this wave only ensures
they get written once, into the right files.

---

## 3. Scope

### PR A — `src/middleware.ts` → `src/proxy.ts` (small, independent, do first)

`git mv` the **fork's** file. Do **not** adopt upstream's `src/proxy.ts`, which would
regress two things:

- it imports `getUserFromJWT` from `lib/auth`, which is `jsonwebtoken` (`jwt.verify`) —
  Node crypto, not Edge. The fork uses `verifyJwtEdge` (Web Crypto,
  `src/utils/security/edgeJwt.ts`) for exactly this reason (#101).
- upstream's route lists have **no `/shop/pos`** — that is the #117 fix, and without it the
  path falls through to the public `/shop` prefix. Same failure mode as #97.

Steps: `git mv src/middleware.ts src/proxy.ts`; rename the exported `middleware` function
per Next 16's proxy convention; verify the Next 16 dev warning is gone; re-verify the #97 /
#101 / #117 guards by hand.

*Auth-adjacent — flagged for approval even though it is a rename.*

### PR B — the data-layer split

1. Create `src/utils/db/dbClient.ts` — upstream's shape, fork's error boundary.
2. Create `errorMapper.ts` — upstream's message table behind the fork's `lib/errors/*`.
3. Create `userQueries.ts` / `shopQueries.ts` / `eventQueries.ts` — upstream's file
   boundaries, **fork bodies**, `VARCHAR(50)`, fork's `getUser`.
4. Repoint 56 importers. Delete `src/utils/dbUtils.ts`.
5. `src/utils/authUtils.ts` → `src/lib/auth.ts` is **deferred to Wave 3** — it carries
   `serverCheckRoles` and #111 (the blanket `catch` swallowing `DynamicServerError`), which
   is a behaviour change, not a move. Doing it here would mix a refactor with an auth fix.

Out of scope: `votingQueries.ts` (Wave 4), `docker/schema.sql`, transactions, dependencies.

---

## 4. Verification, and what it will not prove

Gates: `yarn type:check && yarn lint && yarn format:check && yarn build`.

The gates prove the 56 importers resolve and the types line up. **There are no tests.** They
will not prove any query still returns the same rows. Manual verification required against
the live local DB before the PR is marked ready:

- Fenix login → `/profile` renders, roles correct (exercises `getUser` + role ordering)
- Google login → external account creates and logs in (this is the `VARCHAR(50)` guard;
  a truncation regression shows up here and *only* here)
- `/shop` list, add to cart, checkout to the SumUp handoff (exercises `shopQueries`)
- `/activities` renders (exercises `eventQueries`)
- a deliberate DB error surfaces a Portuguese message, not a raw `pg` error

The PR must state that no automated coverage exists for any of the above.
