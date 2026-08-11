# Decision Log

Technical decisions made during NEIIST Website development. Each entry records
the decision, alternatives considered, and rationale.

| Date | Decision | Alternatives | Rationale | Author |
|------|----------|-------------|-----------|--------|
| 2026-07-24 | Use Vitest for testing | Jest | Vitest is faster, ESM-native, better Next.js support | AI + tomasmbrito |
| 2026-07-24 | Keep raw pg (no ORM) | Drizzle, Prisma | Existing codebase uses raw pg extensively; migration risk too high for now | tomasmbrito |
| 2026-08-11 | Yarn is the authoritative package manager; delete `package-lock.json` | Migrate to pnpm (matching upstream), keep both lockfiles | All `package.json` scripts and the husky hooks already assume yarn. Two committed lockfiles can disagree and produce different dependency trees for different developers. pnpm is deliberately deferred, not rejected — it is a breaking change to scripts, CI and the server deploy scripts, and should be its own project. | tomasmbrito |
| 2026-08-11 | Deliver via branch + PR on the fork; human reviews and merges | Full autonomy including self-merge | The code handles real card payments and student PII. For security and payment changes a wrong fix is worse than a slow one, so a human reads the diff before it lands. | tomasmbrito |
