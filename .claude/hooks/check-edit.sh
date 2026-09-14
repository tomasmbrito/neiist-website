#!/usr/bin/env bash
# PostToolUse(Edit|Write) hook — fast static checks on the file just written.
#
# Rationale: `pnpm type:check` is too slow to run on every edit, but a handful of this
# project's worst failure modes are detectable with a regex in milliseconds. Catching them at
# write time is far cheaper than catching them in review.
#
# Exit 2 surfaces stderr back to Claude as feedback to act on. This never blocks the edit
# itself (it already happened) — it prompts an immediate fix.
set -uo pipefail

payload=$(cat)
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')

[[ -z "$path" || ! -f "$path" ]] && exit 0
case "$path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

problems=()

# --- SQL injection: interpolation inside a query string -------------------------------------
# Matches a template literal containing SQL alongside ${...}. Parameterised queries use $1,$2.
if grep -nE '`[^`]*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[^`]*\$\{' "$path" >/dev/null 2>&1; then
  hits=$(grep -nE '`[^`]*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[^`]*\$\{' "$path" | head -3)
  problems+=("SQL INJECTION RISK — a value is interpolated into a SQL string. Use parameterised placeholders (\$1, \$2) with an argument array. Identifiers that cannot be parameterised must be allow-listed against a fixed set.
$hits")
fi

# --- Bypassing the shared pool -----------------------------------------------------------------
# db_query in src/lib/db/connection.ts is the only sanctioned way to reach Postgres. The one
# deliberate exception is dbBroadcaster.ts, which needs a dedicated Client for LISTEN.
case "$path" in
  *src/lib/db/connection.ts|*src/lib/dbBroadcaster.ts) ;;
  *)
    if grep -nE 'new (Pool|Client)\s*\(|\bpool\.query\s*\(' "$path" >/dev/null 2>&1; then
      hits=$(grep -nE 'new (Pool|Client)\s*\(|\bpool\.query\s*\(' "$path" | head -3)
      problems+=("DIRECT pg ACCESS — this file opens its own connection instead of using db_query from src/lib/db/connection.ts. Only connection.ts (the pool) and dbBroadcaster.ts (LISTEN needs a dedicated Client) may do that. See CLAUDE.md §4.
$hits")
    fi
    ;;
esac

# --- Type-safety escape hatches ----------------------------------------------------------------
if grep -nE '@ts-(expect-error|ignore)|eslint-disable' "$path" >/dev/null 2>&1; then
  hits=$(grep -nE '@ts-(expect-error|ignore)|eslint-disable' "$path" | head -3)
  problems+=("SUPPRESSED CHECK — CLAUDE.md §2 forbids silencing a gate to make it pass. Fix the underlying error or report it as a blocker.
$hits")
fi

if grep -nE ':\s*any\b|<any>|as any\b' "$path" >/dev/null 2>&1; then
  hits=$(grep -nE ':\s*any\b|<any>|as any\b' "$path" | head -3)
  problems+=("'any' introduced — use 'unknown' and narrow, or a real type from src/types/.
$hits")
fi

# --- console.log is an ESLint error in this project ---------------------------------------------
if grep -nE '(^|[^.\w])console\.log\s*\(' "$path" >/dev/null 2>&1; then
  hits=$(grep -nE '(^|[^.\w])console\.log\s*\(' "$path" | head -3)
  problems+=("console.log is an ESLint ERROR here (only warn/error are allowed) — 'pnpm lint' will fail.
$hits")
fi

# --- Secrets shipped to the browser --------------------------------------------------------------
if grep -nE 'NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD)' "$path" >/dev/null 2>&1; then
  hits=$(grep -nE 'NEXT_PUBLIC_[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD)' "$path" | head -3)
  problems+=("NEXT_PUBLIC_* values are inlined into the client bundle and shipped to every browser. A secret must never carry that prefix.
$hits")
fi

# --- Hardcoded credentials -----------------------------------------------------------------------
if grep -nEi '(password|secret|api_?key|jwt_?secret)\s*[:=]\s*["'"'"'][^"'"'"']{8,}' "$path" >/dev/null 2>&1; then
  hits=$(grep -nEi '(password|secret|api_?key|jwt_?secret)\s*[:=]\s*["'"'"'][^"'"'"']{8,}' "$path" | head -3)
  problems+=("POSSIBLE HARDCODED CREDENTIAL — move it to an environment variable and document the name in .env.example.
$hits")
fi

if [[ ${#problems[@]} -gt 0 ]]; then
  {
    echo "check-edit hook flagged ${#problems[@]} issue(s) in $path:"
    echo
    for p in "${problems[@]}"; do
      echo "  • $p"
      echo
    done
    echo "Address these now rather than leaving them for review."
  } >&2
  exit 2
fi

exit 0
