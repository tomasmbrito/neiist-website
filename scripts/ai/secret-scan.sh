#!/usr/bin/env bash
# Secret scan — checks staged files and working tree for accidental secrets.
# Adapted from OCP's secret-guard concept for use as a local validation script.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🔒 Running secret scan..."

BLOCKED_FILES=(
  ".env"
  "google-key.json"
  "client_secret.json"
  "token.json"
)

BLOCKED_PATTERNS=(
  "\.env\.[^e]"   # .env.* but not .env.example
  "\.pem$"
  "\.pfx$"
  "\.p12$"
  "\.key$"
)

SECRET_PATTERNS=(
  "password\s*[:=]"
  "api[_-]?key\s*[:=]"
  "secret\s*[:=]"
  "token\s*[:=]\s*['\"]?[a-zA-Z0-9]"
  "Bearer\s+[a-zA-Z0-9._-]+"
  "ghp_[a-zA-Z0-9]{36}"
  "github_pat_[a-zA-Z0-9_]+"
  "-----BEGIN.*PRIVATE KEY-----"
)

FOUND=0

# Check for blocked files in git staging
for f in "${BLOCKED_FILES[@]}"; do
  if git diff --cached --name-only 2>/dev/null | grep -qE "^${f}$"; then
    echo -e "${RED}❌ BLOCKED: Secret file staged for commit: ${f}${NC}"
    FOUND=1
  fi
done

# Check for blocked patterns in staged files
for p in "${BLOCKED_PATTERNS[@]}"; do
  matches=$(git diff --cached --name-only 2>/dev/null | grep -E "${p}" || true)
  if [ -n "$matches" ]; then
    echo -e "${RED}❌ BLOCKED: Sensitive file pattern staged: ${matches}${NC}"
    FOUND=1
  fi
done

# Check for secret patterns in staged diff
for p in "${SECRET_PATTERNS[@]}"; do
  matches=$(git diff --cached -U0 2>/dev/null | grep -iE "^\+.*${p}" | head -3 || true)
  if [ -n "$matches" ]; then
    echo -e "${YELLOW}⚠️  WARNING: Possible secret pattern found in diff:${NC}"
    echo "$matches" | head -3
    FOUND=1
  fi
done

if [ $FOUND -eq 0 ]; then
  echo -e "${GREEN}✅ Secret scan passed — no issues found.${NC}"
  exit 0
else
  echo -e "${RED}🚫 Secret scan FAILED — review the issues above.${NC}"
  exit 1
fi
