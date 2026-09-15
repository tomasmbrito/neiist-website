# Decision log

Decisions that shaped this codebase: **what** was decided, **what else was considered**, and
**why**. One entry per decision, newest first. If a future session would otherwise re-open a
settled question, it belongs here.

This log starts at the 2026-09-14 reset. Decisions from the previous phase live in the
archived fork (tag `archive/fase-1`) and are not authoritative here.

---

## 2026-09-16 — Scoped `set_application_review_status` by team, matching the read side

**Decision.** `neiist.set_application_review_status` (merged earlier the same day in #292)
gained the same admin/coordinator authorization check `get_recruitment_pipeline` already had:
an admin may update any application; a coordinator only one naming at least one team they
coordinate. Caught and fixed while building the admin review page (#291), before the function
was ever reachable from an API route — nothing shipped exploitable, but the merged commit did
briefly carry the gap.

**Context.** The original version updated any `application_id` with no ownership check at all.
Once wired to `PATCH /api/recruitment/applications/[id]`, any coordinator — of any team, not
just one the candidate applied to — would have been able to relabel or annotate any candidate's
review status. The read side (`get_recruitment_pipeline`) already enforced this scoping; the
write side didn't, which is the more consequential half to miss.

**Verified.** Throwaway-database test with three real-shaped accounts (a Marketing coordinator,
an External Relations coordinator, an admin) against one application naming only Marketing:
the External Relations coordinator's update attempt raised `Insufficient permissions for
application N`; the Marketing coordinator's and the admin's both succeeded. Applied to the
local dev database and to `docker/schema.sql` only after this passed.

**Worth knowing.** When adding a second SQL function against the same table a scoped reader
already exists for, check whether the writer needs the identical scoping — it's easy to scope
the read (where a miss just over-shows data) and forget the write (where a miss lets someone
act on data they shouldn't even see).

## 2026-09-16 — Renamed six departments to the 26/27 recruitment branding

**Decision.** Renamed six `neiist.departments` rows to match the names NEIIST is actually using
for the 2026/27 recruitment cycle: Contacto → External Relations, Controlo & Qualidade → Human
Resources, Divulgação → Marketing, Fotografia → Photography, Visuais → Design, Organização de
Eventos → Logistics. `Dev-Team` was already correct. Team descriptions updated to match the
current recruitment form's copy. Applied to the local dev database and to `docker/init.sql` (so
a fresh database seeds with the right names); `docker/schema.sql` gained a new
`neiist.rename_department(old_name, new_name)` function as the mechanism, in case a department
needs renaming again later without a developer hand-editing rows.

**Context.** This is a prerequisite for the recruitment-applications feature
(`.claude/plans/recruitment-applications.md`): the public application form needs to reference
real `neiist.departments` rows, not a parallel English-name list that would need a translation
layer — exactly the "value authorized vs. value written" bug class that caused #180 in the old
fork and the duplicate-function-overload drift found earlier this week. Confirmed with Tomás
that the English names are this year's real branding (already on the recruitment poster and
Google Form) and the Portuguese names in the database were what had gone stale, not the reverse.

**Why not a plain `UPDATE departments SET name = ...`.** None of the four FKs into
`departments.name` (`teams`, `admin_bodies`, `valid_department_roles`, `department_role_order`)
are `ON UPDATE CASCADE`, and `membership`'s FK is the *composite*
`(department_name, role_name)` into `valid_department_roles` — so the new
`(new_name, role_name)` pair has to exist before `membership` can be repointed to it, and the
old pair can't be renamed in place while `membership` still references it. First attempt tried
`UPDATE valid_department_roles` before `UPDATE membership` and hit exactly this: "still
referenced from table membership." Fixed by testing against a throwaway database first (per
`CLAUDE.md` §2.8) and restructuring to INSERT the new rows, repoint `membership`, then DELETE
the old rows — no `ON UPDATE CASCADE`, no deferrable constraints needed.

**Verified.** Throwaway-database dry run with a real membership row before trusting it against
the local dev database; then applied for real and confirmed row counts matched exactly
before/after (22 memberships across the six renamed teams, 31 users total, old names completely
gone) — not just "no error," actual count equality.

## 2026-09-15 — Did not implement CSP nonces; `unsafe-inline` stays

**Decision.** Investigated implementing per-request CSP nonces (issue #269, `script-src
'unsafe-inline'`) and did not implement it. `src/lib/security/cspUtils.ts` is unchanged.

**Context.** `next.config.ts` has `cacheComponents: true`. Next's own bundled docs for this
exact version (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md`)
state this flag *is* Partial Prerendering ("`cacheComponents` implements Partial Prerendering
(PPR) as the default behavior in the App Router"). Next's CSP guide
(`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) states nonce-based
CSP requires every page to render fully dynamically and is explicitly incompatible with PPR
("static shell scripts won't have access to the nonce"). Ran a real `pnpm build` against the
local dev database to check whether this app actually relies on PPR or just has the flag
switched on unused: all 25 pages render `◐` (Partial Prerender) with no exceptions. Also
inspected real rendered HTML — the only inline `<script>` tags present (7, on a plain
homepage load) are Next's own framework output (`self.__next_f.push`, Suspense resolution),
none authored by this app, and their content is per-request (carries a request id), so a
static CSP hash could never cover them either — ruling out the hash/SRI alternative Next's own
docs suggest as a nonce alternative.

**Alternatives considered.**
1. *Implement nonces anyway.* Rejected — would force disabling `cacheComponents` (or opting
   every one of the 25 pages out of it individually), a site-wide rendering-performance
   regression, to fix a CSP directive. Far outside "fix the CSP header."
2. *Hash-based CSP / Subresource Integrity, Next's suggested alternative to nonces.* Rejected —
   SRI verifies fetched *external* script content against a build-time hash; it doesn't apply
   to inline scripts at all, and the inline scripts this app actually emits change content
   per-request, so no static hash could allow them regardless.
3. *Leave `unsafe-inline`, documented as a conscious trade-off.* Chosen. The CSP is weaker than
   ideal, but the alternative on offer costs more than the CSP itself is worth trading for
   right now.

**Consequences.** `script-src 'unsafe-inline'` remains, so CSP does not block a script injected
through another vulnerability (relevant context: the SVG-upload vector closed in #259/#266 no
longer has a delivery path, but CSP itself still wouldn't have stopped it). Revisiting this
needs a deliberate, scoped decision to trade PPR away — not something to fold into a future
"quick CSP fix." Full writeup: `docs/ai-workflow/audit-2026-09.md`, section P2-7.

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
