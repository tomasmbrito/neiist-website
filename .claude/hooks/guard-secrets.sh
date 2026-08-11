#!/usr/bin/env bash
# PreToolUse hook — blocks reads of and writes to secret-bearing files.
#
# Rationale: CLAUDE.md §2 forbids reading or editing secrets. A rule in a prompt is advisory;
# this makes it enforced. Reading .env into a transcript is itself the leak, so we block the
# read as well as the write.
#
# stdin: PreToolUse JSON payload. Deny by printing a permissionDecision of "deny".
set -uo pipefail

payload=$(cat)

tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')
path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // ""')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Files that must never be read, written, or printed.
# .env.example and docker/.env.example are explicitly allowed — they hold placeholders only.
is_secret_path() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  case "$p" in
    *.example|*.example.*) return 1 ;;
  esac
  [[ "$p" =~ (^|/)\.env($|\.) ]] && return 0
  [[ "$p" =~ (google-key|client_secret|token)\.json$ ]] && return 0
  [[ "$p" =~ \.(pem|key|pfx|p12)$ ]] && return 0
  return 1
}

case "$tool" in
  Read|Edit|Write|NotebookEdit)
    if is_secret_path "$path"; then
      deny "Blocked by guard-secrets hook: '$path' holds credentials. CLAUDE.md §2 forbids reading or editing it — reading it would leak it into the transcript. Use .env.example (placeholders only) to document variables, and ask the human to set real values."
    fi
    ;;
  Bash)
    # Catch shell-based exfiltration of the same files (cat/less/grep/cp/tee ... .env)
    if printf '%s' "$cmd" | grep -qE '(^|[^a-zA-Z0-9_./-])(\.env|docker/\.env)([^a-zA-Z0-9_.-]|$)' \
       && ! printf '%s' "$cmd" | grep -qE '\.env\.example'; then
      deny "Blocked by guard-secrets hook: this command touches a .env file. CLAUDE.md §2 forbids reading or printing secrets. If you need to know which variables exist, read .env.example instead."
    fi
    if printf '%s' "$cmd" | grep -qE '(google-key|client_secret|token)\.json|\.(pem|pfx|p12)( |$)'; then
      deny "Blocked by guard-secrets hook: this command touches a credential file (CLAUDE.md §2)."
    fi
    ;;
esac

exit 0
