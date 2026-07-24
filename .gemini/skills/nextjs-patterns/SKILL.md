---
name: nextjs-patterns
description: Next.js 16 App Router patterns for NEIIST website — Server/Client Components, API routes, layouts, metadata, and data fetching. Use when implementing new pages, routes, or refactoring existing ones.
---

# Skill: nextjs-patterns

## Objective
Follow consistent Next.js App Router patterns across the NEIIST website.

## Key Patterns
- **Server Components** are the default. Only add `'use client'` when the component
  needs browser APIs, hooks, or event handlers.
- **API routes** use `route.ts` with exported `GET`, `POST`, `PUT`, `DELETE` functions.
- **Layouts** use `layout.tsx` for shared UI. `page.tsx` for leaf pages.
- **Metadata**: export `metadata` or `generateMetadata()` from pages/layouts.
- **Loading/Error**: use `loading.tsx` and `error.tsx` boundary files.
- **Dynamic routes**: `[param]/page.tsx` for dynamic segments.

## Checklist
- [ ] Server vs. Client Component split is intentional and minimal.
- [ ] API routes use proper HTTP status codes and error handling.
- [ ] Metadata (title, description) is set for new pages.
- [ ] Loading states exist for data-fetching pages.
- [ ] No `useEffect` for data that could be fetched server-side.

## STOP conditions
- Middleware or auth changes needed → ask the human.
- New dynamic route that changes URL structure → confirm with human.
