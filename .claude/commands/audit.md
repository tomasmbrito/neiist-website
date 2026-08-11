---
description: Run a parallel multi-agent audit of the codebase and file findings to the board
argument-hint: "[area: security | frontend | data | all]"
---

# /audit — full-codebase audit

Area: **$ARGUMENTS** (default: `all`)

Launch the relevant read-only auditors **in parallel, in a single message**, each scoped to a
distinct part of the tree so they do not duplicate each other's work:

- **security-reviewer** — `src/middleware.ts`, `src/utils/authUtils.ts`,
  `src/utils/security/**`, all 43 routes under `src/app/api/**`, `docker/`,
  `.github/workflows/**`. Focus: authn, authz/IDOR, injection, payment tampering, uploads,
  rate limiting, secrets.
- **data-layer-architect** — `src/utils/dbUtils.ts`, `src/lib/db/**`, `docker/schema.sql`,
  `src/utils/shop/**`. Focus: transactions, race conditions, schema constraints and indexes,
  type/schema drift, N+1 and unbounded queries.
- **quality-reviewer** — `src/components/**`, `src/app/**/page.tsx`, `src/context/**`,
  `src/styles/**`. Focus: correctness bugs, oversized components, duplication, dead code,
  accessibility, bundle cost.

Tell each auditor to audit the **whole area, not a diff**, and to report `file:line` with a
concrete failure scenario for every finding.

## Then

1. **Deduplicate.** The same root cause often surfaces in two reports.
2. **Verify the top findings yourself** before filing them. A confidently-worded false
   positive on the board costs more than a missed finding. Open the file and confirm.
3. **Rank** by real risk: money loss and data corruption > security > correctness >
   maintainability > style.
4. **File to the board** using `.claude/skills/project-board/SKILL.md` — group under epics,
   one issue per story, with `file:line`, the failure scenario, the fix approach, and
   acceptance criteria. Set Priority and Size on every item.

## Report

A ranked summary with counts by severity, the five things that most need doing, and the board
issue numbers created. Say explicitly which findings you verified yourself and which you are
relaying on an auditor's authority.
