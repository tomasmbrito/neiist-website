---
name: planning-context
description: How to research and plan tasks for the NEIIST website — codebase exploration, dependency analysis, impact assessment. Use when starting any new task.
---

# Skill: planning-context

## Objective
Thoroughly understand the task and the affected code before making changes.

## Planning Steps
1. **Understand the requirement**: clarify ambiguities with the human.
2. **Map affected files**: identify all files that will be touched.
3. **Check dependencies**: understand what imports/uses the affected code.
4. **Assess impact**: will this change break other features?
5. **Check for prior art**: is there a similar pattern already in the codebase?
6. **Review decision-log**: check `docs/ai-workflow/decision-log.md` for past decisions.
7. **Document the plan**: create a clear, reviewable implementation plan.
8. **Persist for Subagents**: If delegating work, persist the plan as a markdown file (e.g., in `.gemini/scratch/`) so subagents can read it and maintain context.

## Key Exploration Points
- `src/app/` — route structure and page layouts.
- `src/components/` — reusable UI components (organized by domain).
- `src/utils/dbUtils.ts` — all database access functions.
- `src/utils/authUtils.ts` — authentication helpers.
- `src/types/` — shared TypeScript interfaces.
- `docker/schema.sql` — database schema definition.

## STOP conditions
- Task is unclear → ask for clarification before planning.
- Impact seems larger than expected → flag it in the plan.
