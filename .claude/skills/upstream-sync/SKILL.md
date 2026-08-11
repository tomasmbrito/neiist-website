---
name: upstream-sync
description: How to compare this fork against the neiist-dev upstream repo and adopt changes safely, file by file. Use before merging anything from upstream, when assessing drift, or when deciding whether a fix should be taken from upstream or re-implemented. Never merge upstream wholesale.
allowed-tools: Bash(git *), Bash(gh *), Read, Grep, Glob
---

# Upstream sync

## The one rule

**`git merge upstream/main` is forbidden.** A `guard-git` hook blocks it.

This fork has diverged *deliberately*. It carries work upstream does not have. A wholesale
merge would silently delete it. Every adoption is a per-file decision with a stated reason.

```
origin   = tomasmbrito/neiist-website   (the fork — all work happens here)
upstream = neiist-dev/neiist-website    (fetch-only — never push, never PR against it)
```

## Ground truth

```bash
git fetch upstream
MB=$(git merge-base upstream/main origin/main)

git rev-list --left-right --count upstream/main...origin/main   # behind <TAB> ahead
git log --oneline upstream/main ^origin/main                    # commits only upstream has

# Files touched on BOTH sides — this is where the judgement is needed.
comm -12 <(git diff --name-only $MB upstream/main | sort) \
         <(git diff --name-only $MB origin/main   | sort)

# Read both versions of a contested file before deciding:
git show upstream/main:src/path/file.ts
git diff $MB upstream/main -- src/path/file.ts
```

Files changed on only one side are cheap. The intersection is the work.

## Where the two repos disagree

Both sides independently dismantled the `dbUtils.ts` god object — **in different directions**:

| Concern | Fork | Upstream |
|---|---|---|
| DB access | `src/lib/db/repositories/*.repository.ts` (**dead code — 0 call sites**) | `src/utils/db/*Queries.ts` |
| DB errors | `src/lib/errors/` + `apiErrorHandler` | `src/utils/db/errorMapper.ts` |
| Pool | `src/lib/db/connection.ts` | `src/utils/db/dbClient.ts` |
| Validation | **Zod** in `src/schemas/` | none |
| UI primitives | `src/components/ui/` | none |
| Error boundaries | `error.tsx` + `global-error.tsx` | none |
| Auth | Fenix **+ Google OAuth** | Fenix only |
| Package manager | Yarn (+ a stray `package-lock.json`) | **pnpm** + `pnpm-workspace.yaml` |
| Releases | Changesets | release-please + commitlint |
| Utility layout | `src/utils/*` | moved to `src/lib/*` |

Important nuance: the fork's repository layer is **not in use**. So "the fork already
refactored the data layer" is false — upstream's `utils/db/*Queries.ts` split is *actually
wired up*, while the fork's equivalent has never run. Weigh that honestly instead of
defending the fork by default.

Upstream also has, and the fork lacks:
- a **pg_notify/SSE voting system** (`src/lib/votingSystem.ts`, `src/lib/dbBroadcaster.ts`,
  `src/components/voting/**`, `src/types/voting.ts`)
- **Google service accounts from env** instead of committed JSON key files
- a fix replacing a **self-loopback HTTP fetch in the layout** with a direct server-side call
  (the fork still has this bug — see `src/app/layout.tsx`)
- **security dependency bumps**: `nodemailer` 8→9, `next` 16.2.6→16.2.12, `react` 19.2.6→19.2.8
- dinner-page work and deployment/OOM fixes

## Classifying a change

- **ADOPT** — pure gain, no fork counterpart. Security bumps, bug fixes, new features.
- **ADAPT** — upstream fixes something real, but in code the fork structures differently. Take
  the *intent*; re-express it in the fork's shape. An upstream fix inside `userQueries.ts`
  applies to the fork's `dbUtils.ts` (the code that runs), not to its dead repository.
- **REJECT** — the fork's version is genuinely better. **Write down why**, so it is not
  re-litigated every sync.
- **DEFER** — needs a human: pnpm migration, release tooling, schema, auth, payments.

### Bias the calls correctly
- **Security fixes and dependency bumps: adopt.** Not optional.
- **Bug fixes: adopt the fix, not the file.** Understand the bug; apply it where the fork
  keeps that logic.
- **Pure structural churn** (`utils/*` → `lib/*` with no behaviour change): usually DEFER.
  Huge conflict surface, no user-visible gain — but converging *would* reduce future pain, so
  it is a real decision, not an automatic no.
- **Never drop a fork capability** (Zod, error boundaries, Google OAuth, UI primitives) to
  reduce conflicts. A merge that deletes one is a wrong merge.
- **Schema, auth, payments: always DEFER to the human.**

## Executing

One batch per branch, lowest-risk first, each independently verifiable:

1. security/dependency bumps → 2. isolated bug fixes → 3. new features → 4. structural

```bash
git checkout -b chore/upstream-sync-<batch>
git cherry-pick <sha>          # ADOPT
#   ...or hand-port the change  # ADAPT
yarn type:check && yarn lint && yarn build
git push -u origin chore/upstream-sync-<batch>
gh pr create --repo tomasmbrito/neiist-website --base main --title "..." --body-file <file>
```

Never start the next batch while the previous one is red. If a cherry-pick conflicts, resolve
it **in the fork's idiom** — do not import upstream's data layer alongside the fork's, or the
codebase ends up with two of everything permanently.

Record every REJECT decision in `docs/ai-workflow/decision-log.md`.
