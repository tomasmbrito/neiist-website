# Decision Log

Technical decisions made during NEIIST Website development. Each entry records
the decision, alternatives considered, and rationale.

| Date | Decision | Alternatives | Rationale | Author |
|------|----------|-------------|-----------|--------|
| 2026-07-24 | Use Vitest for testing | Jest | Vitest is faster, ESM-native, better Next.js support | AI + tomasmbrito |
| 2026-07-24 | Keep raw pg (no ORM) | Drizzle, Prisma | Existing codebase uses raw pg extensively; migration risk too high for now | tomasmbrito |
