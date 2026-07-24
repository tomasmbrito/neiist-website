---
name: test-strategy
description: Decide when and how to generate tests — unit, integration, E2E — for the NEIIST website. Use when creating or updating tests.
---

# Skill: test-strategy

## Objective
Produce tests that validate real behavior and catch regressions.

## Test Types
- **Unit**: pure logic — utility functions, mappers in `dbUtils.ts`, validators,
  date calculations, type guards.
- **Integration**: API route handlers — test request/response with mocked DB.
- **Component**: React component rendering — use React Testing Library.
- **E2E** (future): full user flows — use Playwright when set up.
- **Regression**: for every fixed bug in `problem-registry.md`, add a guard test.

## Framework
- **Vitest** for unit and integration tests (fast, ESM-native, Next.js compatible).
- **React Testing Library** for component tests.
- **Playwright** (optional future) for E2E browser tests.

## Checklist
- [ ] Happy path covered.
- [ ] Key edge cases covered (empty inputs, invalid data, unauthorized access).
- [ ] No real secrets/tokens in test fixtures — use fakes.
- [ ] Test file co-located with source or in `__tests__/` directory.
- [ ] The test command is documented.

## STOP conditions
- Feature not implemented yet → STOP (don't test non-existent code).
- A test needs a new dependency → STOP and ask.
