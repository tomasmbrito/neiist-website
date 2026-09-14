# Decision log

Decisions that shaped this codebase: **what** was decided, **what else was considered**, and
**why**. One entry per decision, newest first. If a future session would otherwise re-open a
settled question, it belongs here.

This log starts at the 2026-09-14 reset. Decisions from the previous phase live in the
archived fork (tag `archive/fase-1`) and are not authoritative here.

---

## 2026-09-14 — Reset the fork onto upstream v3.0.0 instead of continuing to diverge

**Decision.** `main` was reset to `upstream/main` at v3.0.0, discarding ~130 commits of
fork-only work. The previous phase is archived at tag `archive/fase-1`, branch
`archive/old-fork`, and ~72 branches on `origin`. The GitHub board and all 49 open issues were
cleared. From here the fork stays close to upstream: small, single-concern branches that the
Dev-Team coordinator could lift, rather than a parallel architecture.

**Context.** The fork had drifted to **130 commits ahead / 92 behind, 705 files apart**
(+38.5k / −60.6k lines). Meanwhile upstream shipped v2.0.0 and v3.0.0: a move from yarn to
**pnpm**, a **pnpm workspace** with the `@neiist/ui` design system in `packages/ui`, **i18n**
under `src/app/[locale]/`, a **voting system** on `pg_notify`/SSE, the **repository pattern**
in `src/lib/db/repositories/`, `authUtils.ts` → `src/lib/auth.ts`, `middleware.ts` →
`proxy.ts`, and a rebuilt deploy that builds on GitHub Actions and ships only the artifact.
The coordinator had reviewed the fork's work and said he would port what he wanted himself.

**Alternatives considered.**

1. *Keep diverging and merge later.* Rejected: the collision surface was already 705 files and
   growing, and upstream had independently solved several of the same problems differently
   (repositories, UI primitives). Every week made the eventual merge worse.
2. *Per-file upstream sync, the previous policy.* Rejected: it assumed the fork's version was
   usually the better one. Once the coordinator took ownership of porting, that stopped being
   true — upstream became the mainline and the fork the side branch.
3. *Create a second GitHub fork and leave this one frozen.* Considered seriously and rejected.
   GitHub allows only one fork per account per upstream repo without renaming; the board,
   issues and PR history are attached to *this* repo; and since PRs here are always fork→fork,
   the fork relationship itself buys nothing a `git tag` does not. An archive tag gives the
   same "walk away but keep it" property at zero migration cost.

**Consequences.** Everything the fork had built and upstream lacks is gone from this tree:
transactions (`withTransaction`), Zod validation, the Vitest runner and its CI job, the
`docker/migrations/` runner, the members-only workspace, team-scoped permissions, and the
Notion-webhook fail-open fix. Each is a real gap (see `CLAUDE.md` §8) and each is now a
proposal to make to the coordinator, not a thing to rebuild unilaterally.

---

## 2026-09-14 — pnpm, settled by upstream

**Decision.** pnpm 12.3.4, pinned in `package.json#packageManager`. Node 24.14.0 per `.nvmrc`.

**Context.** The old fork carried this as an open question (yarn vs pnpm) for months. Upstream
answered it in v2.0.0 by migrating, and the reset inherits that answer. The question is closed.

**Operational note worth keeping.** Corepack shipped with Node 24.11.1 and corepack 0.36.0
both fail to launch pnpm 12: they look for `bin/pnpm.cjs`, but pnpm 12 ships `bin/pnpm.mjs`
alongside a native binary. The failure is an opaque `MODULE_NOT_FOUND` that looks like a
corrupt download. The fix is `npm i -g --force pnpm@12.3.4` (the `--force` overwrites
corepack's shim at the same path).
