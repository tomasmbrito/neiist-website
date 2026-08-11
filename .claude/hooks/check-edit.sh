#!/usr/bin/env bash
# PostToolUse(Edit|Write) hook — fast static checks on the file just written.
#
# Rationale: `yarn type:check` is too slow to run on every edit, but a handful of this
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

# --- Growing the legacy god object ------------------------------------------------------------
if [[ "$path" == *"src/utils/dbUtils.ts" ]]; then
  problems+=("You edited src/utils/dbUtils.ts (the ~1065-line legacy monolith). This is allowed ONLY for fixing live behaviour — it is the code that actually runs. Do NOT add new functions here. If you are adding rather than fixing, stop and reconsider: see CLAUDE.md §4.")
fi

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
  problems+=("console.log is an ESLint ERROR here (only warn/error are allowed) — 'yarn lint' will fail.
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
