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
- src/lib/db/repositories/* is DEAD CODE — 0 call sites. src/utils/dbUtils.ts is what runs.
- There are no tests and no CI quality gate. Do not claim coverage that does not exist.
- Gates before claiming done: yarn type:check && yarn lint && yarn format:check"

jq -n --arg c "$ctx" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $c
  }
}'
exit 0
