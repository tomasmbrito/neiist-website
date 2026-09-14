---
name: upstream-sync
description: How to stay level with the neiist-dev upstream repo now that the fork has been reset onto it — pulling upstream's work in, keeping local branches rebased, and deciding when a change should be offered to the coordinator instead of kept here. Use before starting a branch, when upstream has moved, or when a change starts to look like divergence.
allowed-tools: Bash(git *), Bash(gh *), Read, Grep, Glob
---

# Staying level with upstream

## The posture changed on 2026-09-14 — read this first

This fork used to run **ahead** of upstream by 130 commits and a parallel architecture, and
this skill used to be about defending that divergence. It is not any more.

`main` was reset to `upstream/main` at **v3.0.0**. The previous phase lives at tag
`archive/fase-1`, branch `archive/old-fork`, and ~72 branches on `origin` — **read-only
history**. The Dev-Team coordinator is porting what he wants of it into the org repo himself.

The goal now is the opposite of before: **stay close enough to upstream that pulling from it
is boring.** Divergence is the cost, not the asset.

```
upstream/main ──────────────────────────────►   (neiist-dev — fetch-only, never push)
     │
     └── origin/main ───────────────────────►   (tomasmbrito — level with upstream)
              └── feat/small-focused-branch
```

## Non-negotiable

- **Never push to `upstream`. Never open or merge a PR against `neiist-dev/*`.** It is
  fetch-only. A hook enforces this.
- `gh pr create` **defaults to the parent repo on a fork** — always pass
  `--repo tomasmbrito/neiist-website`.
- Do not cherry-pick from `archive/fase-1` opportunistically. If something there is worth
  having, it gets re-proposed against *this* code, on its own merits, as new work.

## Checking where you stand

```bash
git fetch upstream --prune
git rev-list --left-right --count main...upstream/main    # left = ours, right = theirs
git log --oneline main..upstream/main                      # what they did that we lack
git diff --stat main upstream/main                         # how far apart
```

Interpretation:

| Result | What it means | What to do |
|---|---|---|
| `0  0` | level | nothing |
| `0  N` | upstream moved, we did not | fast-forward: `git checkout main && git merge --ff-only upstream/main` |
| `M  N` | we have local commits on main | **you should not** — work belongs on branches. Move them off, then fast-forward |

Then rebase any in-flight branch onto the new `main`:

```bash
git checkout feat/whatever && git rebase main
```

Rebase, not merge. A branch that merges `main` into itself repeatedly produces a history
nobody can read and a diff the coordinator cannot lift.

## Pulling upstream in

Because `main` is a pure mirror of `upstream/main`, the normal case is a fast-forward and
there is nothing to decide. `--ff-only` is deliberate: if it refuses, something drifted and
you want to know rather than auto-merge.

```bash
git checkout main
git merge --ff-only upstream/main
pnpm install --frozen-lockfile      # the lockfile moves often — do not skip this
pnpm next typegen && pnpm type:check && pnpm lint && pnpm format:check
```

Read `git log --oneline` for the range you just pulled before assuming anything still works.
Upstream ships breaking refactors under `feat(ui):` and `refactor:` as often as under `feat!:`.

## Keeping branches liftable

Everything in this phase should be shaped so the coordinator *could* take it:

1. **One concern per branch.** A branch that fixes a bug and also restructures a directory is
   a branch nobody can review.
2. **Conventional Commits, honestly scoped.** Upstream's release-please reads them.
3. **Follow their conventions, not ours.** `@neiist/ui` primitives, `[locale]` routing with
   both dictionaries, repositories in `src/lib/db/repositories/`, validation through
   `src/utils/apiValidationUtils.ts`. Introducing a parallel way of doing something already
   solved upstream is how the last fork ended up unmergeable.
4. **No new architecture without a human.** Transactions, a test runner, Zod, a migration
   runner — all are genuinely missing and all are structural. They need the coordinator's
   buy-in before code, not after. See `CLAUDE.md` §9.

## When upstream and we disagree

Their version is not automatically right, but it **is** the default. Override it only with a
concrete failure scenario, and write it down in `docs/ai-workflow/decision-log.md`. Two known
cases where upstream is currently wrong, neither yet fixed here:

- `src/app/api/calendar/notion-webhook/route.ts` verifies the Notion signature only when the
  verification token env var is set — unset, it accepts every unsigned request.
- `scripts/deploy_prod.sh:3` pins `node/v24.11.1` on PATH while `.nvmrc` says `24.14.0`.

Both are small, self-contained, and exactly the shape of fix worth offering back.
