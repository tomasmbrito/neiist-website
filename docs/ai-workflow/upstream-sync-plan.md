# Upstream sync plan — fork ↔ `neiist-dev`

Measured 2026-08-12 against `upstream/main`. Companion to
[`.claude/skills/upstream-sync/SKILL.md`](../../.claude/skills/upstream-sync/SKILL.md), which
holds the per-file adoption protocol. This file holds the **strategy and the ordering**.

Tracked by epic [#90](https://github.com/tomasmbrito/neiist-website/issues/90).

---

## 1. The shape of the divergence

```
32 commits behind · 55 ahead
```

| | files changed since divergence |
|---|---|
| Fork only | 130 |
| Upstream only | 103 |
| **Both — the collision surface** | **42** |
| Upstream diff | 145 files, +13,707 / −7,434 |

**The 42 is the whole problem.** The other 233 files are mechanical.

The reason 42 files collide is that both sides refactored the same layer at the same time, in
different directions:

- **The fork** added Zod validation, domain error classes and `apiErrorHandler` to the API
  routes, plus the #96–#106 security fixes.
- **Upstream** rewrote the data layer underneath those same routes — `dbUtils.ts` deleted,
  replaced by `src/utils/db/*` — which changes the imports in nearly every route file.

So the collisions are largely *the same routes, changed for unrelated reasons*. That is the
good case: the changes are usually compatible in substance, just not textually.

### Structural moves that make a plain merge dangerous

These are renames, so git will present them as add/delete pairs rather than conflicts, and a
careless resolution silently drops one side:

| Fork path | Upstream path | Risk |
|---|---|---|
| `src/middleware.ts` | `src/proxy.ts` | **Both may end up present.** Next 16 reads `proxy.ts`. The fork's #101 fix lives in `middleware.ts` — it would still be in the tree, and dead. |
| `src/utils/authUtils.ts` + `src/utils/permissionUtils.ts` | `src/lib/auth.ts` | #101's `verifyJwtEdge` and the `requireRoles` guard live on the fork side only. |
| `src/utils/dbUtils.ts` (1,065 lines, 56 importers) | `src/utils/db/{dbClient,errorMapper,userQueries,shopQueries,eventQueries,votingQueries}.ts` | The core of the sync. |
| `src/lib/botAgents.ts`, `src/lib/rateLimitRules.ts` | `src/lib/security/*` | Cosmetic; take upstream's layout. |
| — | `src/lib/{sumup,email}.ts`, `src/lib/google/*` | Upstream extracted singletons the fork keeps in `src/utils/`. |

---

## 2. Do not merge. Cherry-pick by theme.

A `git merge upstream/main` produces 42 conflicted files simultaneously, most of them API
routes carrying security fixes. Resolving that in one sitting is how a security fix gets
reverted without anyone noticing — and the `guard-git` hook blocks wholesale upstream merges
for exactly this reason.

**Work theme by theme, one PR per wave, gates green at every step.**

---

## 3. Verified findings that set the order

### 3.1 The identity question (#82) is already settled — by upstream

Upstream kept `istid VARCHAR(10) PRIMARY KEY` and has since built an entire voting system on
`istid` foreign keys. Their live query layer has **28 `istid` references and 0 `uuid`
references**.

The fork's `src/lib/db/repositories/*` is 1,025 lines targeting a UUID migration
(`docker/migrations/001_user_uuid.sql`) that `docker-compose.yml` never applies, with **0 call
sites**. It has never executed.

→ **Commit to `istid`. Delete the repositories. Adopt upstream's `src/utils/db/*` split** as
the replacement for `dbUtils.ts`, rather than reviving the fork's parallel version. Full
evidence in [#82](https://github.com/tomasmbrito/neiist-website/issues/82#issuecomment-5263946818).

Port forward the two genuine fixes the dead repositories contain and upstream lacks: the
`getUser` N+1 fix and the correct `getOrderByNumber`.

### 3.2 The fork's security fixes are *not* all present upstream

Checked file by file. Two representative results:

**`api/calendar/notion-webhook/route.ts` — the fork is strictly safer. Do not take upstream's.**

Upstream (line 97):
```ts
if (verificationToken) {
  // ...verify signature...
}
// falls through to processing when the token is unset
```

An unset `VERIFICATION_TOKEN` means **no verification at all** — the endpoint fails open. The
fork's #96 fix rejects that case explicitly:
```ts
// treating an unset token as "no verification needed" would leave the sync open to anyone.
if (!verificationToken) { ... }
```

**`src/proxy.ts` vs `src/middleware.ts` — both are safe, by different means.** Upstream's
`getUserFromJWT` does call `jwt.verify` (`src/lib/auth.ts:23`), and `proxy.ts` runs in the Node
runtime, so `jsonwebtoken` works there. The fork's `middleware.ts` runs on Edge and therefore
needed `verifyJwtEdge` (jose) in #101. Upstream's approach is simpler *if* the fork also adopts
the `proxy.ts` rename. Decide the runtime first, then pick one — do not ship both files.

**Every one of the #96–#106 fixes must be re-verified after each wave**, not assumed.

### 3.3 Adopting upstream does not fix the transaction problem

```
grep -cE "BEGIN|COMMIT|pool.connect" <upstream shopQueries.ts>  →  0
```

Upstream's `dbClient.ts` is still `pool.query()`. **#78 / #79 / #80 / #100 stay open
regardless.** The sync gives you one place to add transactions instead of two — that is the
benefit, and it is worth having before writing them.

### 3.4 Upstream does not use Zod

`zod` is absent from upstream's `package.json`. Every route the fork validates with a schema
from `src/schemas/` will, on upstream's side, have no validation. **Fork side wins on
validation in all 42 collisions** — take upstream's data-layer imports, keep the fork's Zod
guard and `apiErrorHandler`.

---

## 4. The waves

Each wave is one PR on the fork, with all four gates green.

### Wave 0 — unblock (do first, no upstream content)

| | |
|---|---|
| #110 | CI `type:check` never passed — **fixed in PR #109** |
| #105 | `yarn dev` silently uses the wrong DB on a port conflict |

Without #110 the sync has no safety net at all; without #105 nothing data-backed can be
verified in a browser. Do not start Wave 1 before both land.

### Wave 1 — clean adoptions (103 upstream-only files, no conflicts)

Low risk, immediate value, and it shrinks every later diff:

- `scripts/*.mts` — `manage-calendars`, `setup-google`, `setup-notion`, `seed-db`
- **Google service accounts from env instead of `google-key.json`** (`b173609`) — removes
  credential files from disk; adopt with `.env.example` updated
- `311845a` — replaces a self-loopback HTTP fetch in the layout with a direct server call
- `ca2a9ec`, `7df9229`, `b958a86` — deploy script and PM2 fixes

Skip anything from `55ff382` (pnpm) — see #112.

### Wave 2 — the data layer (the big one)

Depends on: **#82 decided**.

1. Delete `src/lib/db/repositories/*` and `docker/migrations/001_user_uuid.sql`.
2. Adopt `src/utils/db/{dbClient,errorMapper,userQueries,shopQueries,eventQueries}.ts`.
3. Reconcile `errorMapper.ts` with the fork's `src/lib/errors/*` — both map DB errors to typed
   errors; keep one. The fork's `apiErrorHandler` is the better boundary; upstream's Portuguese
   message table is the better content.
4. Port the `getUser` N+1 fix and `getOrderByNumber` from the deleted repositories.
5. Delete `src/utils/dbUtils.ts`, repointing all 56 importers.

This is L-sized and mostly mechanical once (1)–(3) are settled. It converts most of the
remaining 42 collisions into trivial import changes.

### Wave 3 — the 42 collision files, route by route

Rule for each file: **upstream's data-layer imports + the fork's Zod validation, auth guard and
error handling.** Re-verify the relevant #96–#106 fix before marking the file done.

Highest-care files (security fixes live here):

```
api/calendar/notion-webhook/route.ts   #96  — keep the fork's, reject upstream's fail-open
api/shop/orders/route.ts               #99  — ownership from session
api/shop/orders/[id]/route.ts          #99
api/shop/sumup/callback/route.ts       #102 — payment bound to order
api/shop/sumup/verify/route.ts         #102
src/middleware.ts / src/proxy.ts       #101 — pick one file, not both
src/utils/authUtils.ts → src/lib/auth.ts
docker/schema.sql                      — schema; needs human approval (CLAUDE.md §7)
```

Also fold in [#111](https://github.com/tomasmbrito/neiist-website/issues/111) here:
`serverCheckRoles` swallows `DynamicServerError`. Upstream's copy has the **same** bug, so fix
it once in whichever file survives.

### Wave 4 — the voting system (#92)

Purely additive: `src/lib/votingSystem.ts`, `src/lib/dbBroadcaster.ts`,
`src/utils/db/votingQueries.ts`, `src/app/voting/**`, `src/components/voting/**`, plus new
tables in `docker/schema.sql`.

Safe to take late because nothing in the fork depends on it. **Schema change → human approval.**
Note the upstream history shows two follow-up fixes for SSE/`pg_notify` connection leaks
(`c20dc75`, `41154f9`) — take the end state, not the first commit.

### Wave 5 — tooling, deferred

- **#91** dependency bumps: `next` 16.2.6→16.2.12, `react` 19.2.6→19.2.8, `pg` 8.20→8.22,
  `nodemailer` **8.0.7→9.0.3 (major)**. Approval required. Take `nodemailer` separately — a
  major bump on the mail path deserves its own PR.
- **#112** pnpm: recommendation is to stay on yarn until #90 completes.
- commitlint + release-please are independent of pnpm and cheap to adopt on their own.

---

## 5. Verification, per wave

No test runner exists (#52), so gates prove compilation only. Each wave also needs:

```bash
yarn type:check && yarn lint && yarn format:check && yarn build
```

plus, in a browser against a real database (requires #105):

- log in via Fenix, confirm roles resolve and guarded pages still redirect
- place a shop order end to end, including SumUp payment binding
- confirm `/orders` and `/shop/manage` still reject a non-privileged user
- for Wave 4, run a voting session with two clients and confirm SSE updates both

Record what you did **not** verify in each PR, as the existing PRs do.

---

## 6. Standing rules

- `upstream` is fetch-only. Never push, never open a PR against `neiist-dev`.
- Never adopt an upstream file wholesale because it is newer. The fork's version is often the
  better one — §3.2 is the proof.
- One wave per PR. Gates green before the next wave starts.
- Anything touching `docker/schema.sql`, auth, payments, or dependencies stops for human
  approval (CLAUDE.md §7).
