---
name: implementation-rules
description: Rules for implementing within an approved plan — small changes, real wiring, no dead code, no secrets. Use during any implementation task.
---

# Skill: implementation-rules

## Objective
Implement exactly what the approved plan describes — no more, no less — and
leave the codebase clean.

## Rules
- **Stay in scope**: edit only files relevant to the approved plan.
- **Small steps**: one feature or fix at a time; avoid drive-by refactors.
- **Wire it in**: the feature must be reachable in the real flow, not orphaned.
- **No dead code**: no leftover mocks, unused imports, commented blocks.
- **No secrets**: never write real secrets; reference `.env.example` for patterns.
- **Local checks**: run `yarn type:check` and `yarn lint` after changes.

## Checklist
- [ ] Only in-scope files changed.
- [ ] Feature is wired into the app (accessible via navigation/routing).
- [ ] No dead code or secrets introduced.
- [ ] `yarn type:check` passes.
- [ ] `yarn lint` passes.
- [ ] `yarn build` succeeds (for significant changes).

## STOP conditions
- Scope would grow beyond the plan → ask before expanding.
- A secret / dependency install / schema change is needed → STOP and ask.
- Existing tests break (when tests exist) → fix before proceeding.
