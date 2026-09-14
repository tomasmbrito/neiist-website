#!/usr/bin/env bash
# SessionStart hook — injects live repo state so the session starts grounded in facts
# rather than in whatever the last session assumed.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

sync="upstream not fetched"
if git rev-parse --verify upstream/main >/dev/null 2>&1; then
  counts=$(git rev-list --left-right --count upstream/main...origin/main 2>/dev/null || echo "? ?")
  behind=$(echo "$counts" | awk '{print $1}')
  ahead=$(echo "$counts" | awk '{print $2}')
  sync="${behind} commits behind upstream/main, ${ahead} ahead"
fi

ctx="Repo state at session start:
- Branch: ${branch}$( [[ "$branch" == "main" ]] && echo "  <- on main; create a branch before committing" )
- Uncommitted files: ${dirty}
- Fork vs upstream: ${sync}

Standing reminders for this repo:
- origin = tomasmbrito/neiist-website (the fork; all work goes here).
  upstream = neiist-dev/neiist-website (fetch-only; never push, never PR against it).
- The fork was reset to upstream v3.0.0 on 2026-09-14. The previous phase is archived at
  tag archive/fase-1 — read-only history, not a base to build on. Nothing it introduced
  (workspace, Zod, withTransaction, docker/migrations/) exists here.
- Toolchain: pnpm 12.3.4, Node 24.14.0. It is a pnpm workspace — @neiist/ui is in packages/ui.
- The data layer is src/lib/db/repositories/*; db_query lives in src/lib/db/connection.ts.
- There are NO tests and no test job in CI. Do not claim coverage that does not exist.
- There are NO transactions: every multi-table write is non-atomic.
- docker/schema.sql only runs on an empty database. There is no migration path to production.
- CI runs type-check, lint and format only — no build job. Run pnpm build yourself.
- Gates before claiming done: pnpm type:check && pnpm lint && pnpm format:check"

jq -n --arg c "$ctx" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $c
  }
}'
exit 0
