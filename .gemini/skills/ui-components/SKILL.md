---
name: ui-components
description: React component patterns for NEIIST website — component structure, styling, accessibility, state management. Use when building or modifying UI components.
---

# Skill: ui-components

## Objective
Build consistent, accessible, and maintainable React components.

## Key Patterns
- Components are organized by domain in `src/components/` (e.g., `shop/`, `admin/`, `activities/`).
- Use **functional components** with hooks.
- Use CSS modules or inline styles — no Tailwind.
- Icons from `react-icons` library.
- Drag-and-drop via `@dnd-kit`.
- Carousels via `swiper`.
- Date picking via `react-day-picker`.

## Checklist
- [ ] Component has a clear, single responsibility.
- [ ] Interactive elements have keyboard support.
- [ ] Images have `alt` attributes.
- [ ] Loading and error states are handled.
- [ ] Component follows existing naming patterns.
- [ ] `'use client'` is added only if truly needed.

## STOP conditions
- New external UI library needed → ask before installing.
- Component requires new global styles → confirm approach.
