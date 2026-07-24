# AGENTS.md — NEIIST Website

> Primary context file for Antigravity. This is the single source of truth for
> how AI-assisted development works in this repository. Read this file first.

## 1. Project Overview

**NEIIST Website** — a web platform for NEIIST (Núcleo Estudantil de Informática
do IST), the Computer Science student association at Instituto Superior Técnico,
Universidade de Lisboa.

- **Stack**: Next.js 16 (App Router) + React 19 + TypeScript + raw PostgreSQL
- **Package Manager**: Yarn
- **Database**: PostgreSQL 15 (Docker for local dev, no ORM — uses `pg` pool)
- **Deployment**: SSH + PM2 blue/green via GitHub Actions
- **Team**: Solo developer (tomasmbrito)

## 2. Non-negotiable rules

1. **Never** read, print, edit, or commit secrets: `.env`, `.env.*`, `google-key.json`,
   `client_secret.json`, `token.json`, `*.pem`, tokens, PATs, passwords,
   connection strings, API keys.
2. **Never** create `.env` with real values. Use `.env.example` with placeholders only.
3. **Exception to git push**: The AI is permitted to `git push` autonomously ONLY to the user's origin fork as part of the `/run-task` protocol. Direct pushes to the upstream `main` are strictly forbidden.
4. **Never** deploy or run destructive commands without explicit human approval.
5. **Always** run `yarn type:check` and `yarn lint` before claiming work is done.
6. **Always** verify a feature builds before generating tests.
7. **Always** update docs when API, setup, schema, or workflow changes.
8. **Human approval is required** for: database schema changes, auth changes,
   payment/SumUp changes, dependency installs, and production deploys. (Merges are allowed autonomously for fork PRs).

If any step requires a secret or a production infra change →
**STOP and ask the human.**

## 3. Development workflow

Antigravity is the AI orchestrator. The workflow is:

1. **Plan** (`/plan` mode) — understand the task, research the codebase, create a plan.
   - **Context Sharing**: The plan MUST be saved as a physical markdown artifact (e.g., in `.gemini/scratch/`).
2. **Implement** (`/goal` mode) — execute the approved plan, make changes.
   - **Agent Delegation**: When spawning subagents (e.g., via `invoke_subagent`), the Orchestrator MUST pass the absolute path to the plan artifact so the subagent can read the full context.
3. **Verify** — run `yarn type:check`, `yarn lint`, `yarn build` locally.
4. **Review** — human reviews the diff before any commit/push.

There is no separate handoff protocol. Antigravity manages context natively.

## 4. When to proceed autonomously vs. stop

**Proceed autonomously** when:
- The plan is approved and the change stays inside the approved scope.
- Editing application code (components, utils, lib, types, styles).
- Running read-only or non-destructive commands (status, diff, build, lint, typecheck).
- Creating or updating documentation and AI workflow files.

**STOP and ask a human** when any of these is true:
- A secret, token, PAT, password, or connection string is needed or detected.
- A database schema change (`schema.sql`) is needed.
- Auth, payment (SumUp), or external API integration changes are needed.
- A `git push`, merge to `main`, or deploy would be required.
- Dependencies must be installed (`yarn add`, `npm install`).
- The work exceeds the approved scope.

## 5. Project structure

```
src/
├── app/          # Next.js App Router pages and API routes
├── components/   # React UI components (organized by feature domain)
├── lib/          # Backend logic wrappers
├── utils/        # Core utilities (dbUtils, authUtils, googleCalendar, etc.)
└── types/        # TypeScript type definitions
config/           # ESLint and Prettier configuration
docker/           # Docker Compose + PostgreSQL schema (schema.sql, init.sql)
scripts/          # Deployment and setup scripts
docs/             # Project documentation
public/           # Static assets
```

## 6. Key patterns

- **Database access**: All queries go through `src/utils/dbUtils.ts` using
  parameterized SQL via the `pg` pool. No ORM. Mappers like `mapDbUserToUser()`
  convert DB rows to typed interfaces.
- **API routes**: Use Next.js App Router route handlers (`route.ts` files).
- **Authentication**: Fenix OAuth via API callbacks.
- **Styling**: Component-level CSS modules / global styles.
- **State management**: React hooks (no Redux/Zustand).

## 7. Quality gates

Every change must pass before commit:
- `yarn type:check` — zero TypeScript errors
- `yarn lint` — zero ESLint errors
- `yarn format:check` — Prettier formatting
- `yarn build` — successful Next.js build (for significant changes)

## 8. Skills available

See `.gemini/skills/` for detailed checklists:
- `nextjs-patterns` — App Router, Server Components, API routes
- `database-patterns` — raw PostgreSQL, schema, mappers
- `implementation-rules` — scope discipline, clean code
- `test-strategy` — unit, integration, E2E test approach
- `security-review` — secrets, auth, permissions
- `quality-review` — code quality, duplication, naming
- `planning-context` — how to research and plan tasks
- `pr-readiness` — checklist before creating a PR
- `ui-components` — React component patterns, accessibility
- `docs-maintenance` — keeping documentation up to date

## 9. Problem learning & Context Memory

When bugs, unexpected issues, or important decisions arise, record them so subagents don't lose context:
- `docs/ai-workflow/problem-registry.md` — bugs, root cause, fix.
- `docs/ai-workflow/decision-log.md` — technical decisions, alternatives, rationale.
- `docs/ai-workflow/architecture-notes.md` — overarching architecture state.
