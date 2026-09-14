#!/usr/bin/env bash
# PreToolUse(Bash) hook — protects the upstream org repo and the main branch.
#
# Rationale: this checkout is a fork. The single worst irreversible mistake available is
# pushing to neiist-dev/neiist-website or opening a PR against it. CLAUDE.md §2 forbids it;
# this enforces it. Also blocks direct commits to main and unrequested history rewriting.
set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
[[ -z "$cmd" ]] && exit 0

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

# --- 1. Never write to upstream -------------------------------------------------------------
if printf '%s' "$cmd" | grep -qE '\bgit\s+push\b.*\bupstream\b'; then
  deny "Blocked by guard-git hook: pushing to 'upstream' (neiist-dev/neiist-website) is forbidden. upstream is fetch-only. Push to 'origin' (the fork) instead."
fi

if printf '%s' "$cmd" | grep -qE 'neiist-dev/neiist-website' \
   && printf '%s' "$cmd" | grep -qE '\bgit\s+push\b|gh\s+pr\s+(create|merge)|gh\s+repo\s+(delete|edit)'; then
  deny "Blocked by guard-git hook: this targets the upstream org repo (neiist-dev). All PRs and pushes must go to tomasmbrito/neiist-website. Pass --repo tomasmbrito/neiist-website explicitly."
fi

# gh defaults to the PARENT repo on a fork — an unqualified `gh pr create` silently
# opens the PR against neiist-dev. Require an explicit --repo.
if printf '%s' "$cmd" | grep -qE '\bgh\s+pr\s+create\b' \
   && ! printf '%s' "$cmd" | grep -qE '\-\-repo[= ]+tomasmbrito/neiist-website'; then
  deny "Blocked by guard-git hook: 'gh pr create' without --repo defaults to the PARENT repo on a fork, which would open the PR against neiist-dev. Re-run with: --repo tomasmbrito/neiist-website"
fi

# --- 2. No direct commits to main, and never push main ----------------------------------------
branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Committing while HEAD is main.
if printf '%s' "$cmd" | grep -qE '\bgit\s+commit\b' \
   && [[ "$branch" == "main" ]] \
   && ! printf '%s' "$cmd" | grep -qE '\-\-dry-run'; then
  deny "Blocked by guard-git hook: you are on 'main'. CLAUDE.md §2 requires a branch + PR for every change. Run: git checkout -b <type>/<description> first (your staged changes carry over)."
fi

# Pushing main itself — either explicitly, or a bare `git push` while HEAD is main.
# Note: pushing a *feature* branch while HEAD happens to be main is legitimate and allowed.
#
# One exception, added when the fork was reset onto upstream v3.0.0 (2026-09-14): `main` is now
# a pure mirror of `upstream/main`, so pushing it to origin after a fast-forward is how the
# mirror stays current — it is a sync, not a direct commit. Allowed ONLY when the local main
# is exactly upstream/main; anything else is somebody committing to main and must still stop.
if printf '%s' "$cmd" | grep -qE '\bgit\s+push\b' && ! printf '%s' "$cmd" | grep -qE '\-\-dry-run'; then
  if printf '%s' "$cmd" | grep -qE '\bgit\s+push\b[^|;&]*\bmain\b' \
     || { [[ "$branch" == "main" ]] && printf '%s' "$cmd" | grep -qE '\bgit\s+push\s*(-[a-zA-Z-]+\s*)*(origin\s*)?$'; }; then
    local_main=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse main 2>/dev/null || echo "x")
    up_main=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse upstream/main 2>/dev/null || echo "y")
    if [[ "$local_main" != "$up_main" ]]; then
      deny "Blocked by guard-git hook: pushing 'main' is only allowed when it is an exact mirror of upstream/main (a fast-forward sync). Local main is $local_main, upstream/main is $up_main — so this carries local commits, and those reach main through a PR on the fork. Push a feature branch instead."
    fi
  fi
fi

# --- 3. No unrequested history rewriting ------------------------------------------------------
if printf '%s' "$cmd" | grep -qE '\bgit\s+push\b.*(--force([^-]|$)|-f( |$))' \
   && ! printf '%s' "$cmd" | grep -qE '\-\-force-with-lease'; then
  deny "Blocked by guard-git hook: bare --force can destroy pushed history. Use --force-with-lease, and only when the human has asked for it."
fi

if printf '%s' "$cmd" | grep -qE '\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f'; then
  deny "Blocked by guard-git hook: this discards uncommitted work irreversibly. Ask the human first, or stash instead (git stash -u)."
fi

# --- 4. Take upstream by fast-forward, never by a silent merge commit --------------------------
# Before the 2026-09-14 reset this rule blocked upstream merges outright, because the fork
# carried a parallel architecture a merge would have clobbered. It no longer does: `main` is a
# mirror of upstream/main and taking their work is the normal case. What is still forbidden is
# the *merge commit* — if --ff-only refuses, something drifted and a human needs to look,
# rather than a merge quietly papering over it.
if printf '%s' "$cmd" | grep -qE '\bgit\s+(merge|pull)\b[^|;&]*\bupstream/main\b' \
   && ! printf '%s' "$cmd" | grep -qE '\-\-ff-only'; then
  deny "Blocked by guard-git hook: take upstream with 'git merge --ff-only upstream/main'. A merge commit here means main has drifted from upstream — that is worth a human looking at it, not a silent merge. Local branches rebase onto main; they do not merge it."
fi

exit 0
