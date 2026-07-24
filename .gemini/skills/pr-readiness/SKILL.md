---
name: pr-readiness
description: Checklist before creating a Pull Request — all quality gates, documentation, and cleanup verified. Use before suggesting a PR.
---

# Skill: pr-readiness

## Objective
Ensure everything is clean and verified before creating a PR.

## Pre-PR Checklist
- [ ] `yarn type:check` — zero errors.
- [ ] `yarn lint` — zero errors.
- [ ] `yarn format:check` — all files formatted.
- [ ] `yarn build` — successful build.
- [ ] No uncommitted secret files.
- [ ] Branch follows naming convention (`feature/`, `fix/`, `refactor/`).
- [ ] Commit messages follow Conventional Commits.
- [ ] PR description filled using the template.
- [ ] Documentation updated if API/schema/setup changed.
- [ ] Decision log updated if architectural decisions were made.

## Branch Naming Convention
- `feature/<short-description>` — new features.
- `fix/<short-description>` — bug fixes.
- `refactor/<short-description>` — code improvements.
- `docs/<short-description>` — documentation only.

## Commit Convention
Follow Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `style:`, `test:`, `chore:`.
