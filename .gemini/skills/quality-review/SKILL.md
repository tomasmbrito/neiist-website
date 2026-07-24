---
name: quality-review
description: Assess code quality — duplication, naming, component size, type safety, and performance. Use before finalizing changes.
---

# Skill: quality-review

## Objective
Ensure code quality meets the project's standards.

## What to Check
- **Component size**: components over ~200 lines should be split.
- **Duplication**: similar logic in multiple places should be extracted.
- **Naming**: functions, variables, files follow project conventions.
- **Type safety**: avoid `any` types; use proper TypeScript interfaces.
- **Performance**: avoid unnecessary re-renders, heavy computations in render.
- **Accessibility**: interactive elements have proper ARIA attributes.
- **Error handling**: API routes and data fetching have proper error boundaries.

## Checklist
- [ ] No `any` types introduced (use proper types from `src/types/`).
- [ ] No duplicate logic that should be extracted.
- [ ] Components are reasonably sized and focused.
- [ ] Error states are handled (loading, error, empty).
- [ ] Naming follows existing project conventions.
