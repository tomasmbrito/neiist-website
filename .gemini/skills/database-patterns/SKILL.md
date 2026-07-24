---
name: database-patterns
description: PostgreSQL database patterns for NEIIST website — raw SQL via pg pool, dbUtils.ts mappers, schema.sql changes, and parameterized queries. Use when working with database code.
---

# Skill: database-patterns

## Objective
Maintain safe, consistent database access patterns using raw PostgreSQL.

## Key Patterns
- All DB access goes through `src/utils/dbUtils.ts`.
- Use **parameterized queries** (`$1, $2, ...`) — never string interpolation.
- Type mappers (`mapDbUserToUser()`, etc.) convert DB rows to typed interfaces.
- Schema lives in `docker/schema.sql` under the `neiist` schema.
- DB pool is initialized once via `pg.Pool` in `dbUtils.ts`.

## Checklist
- [ ] All queries use parameterized values (no SQL injection risk).
- [ ] New DB functions have corresponding TypeScript return types.
- [ ] Mapper functions handle null/undefined fields gracefully.
- [ ] Schema changes are documented and require human approval.
- [ ] Connection pooling is used (never create new pools per request).

## STOP conditions
- Schema changes (`ALTER TABLE`, `CREATE TABLE`) → STOP, document in plan, ask human.
- New stored procedures/functions → STOP, confirm approach with human.
- Any change to `docker/schema.sql` → requires human review.
