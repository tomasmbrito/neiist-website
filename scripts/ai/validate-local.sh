#!/usr/bin/env bash
# Full local validation — run before creating a PR.
# Combines all quality checks into one script.

set -euo pipefail

echo "🏗️  Running full local validation..."

echo ""
echo "=== 1/5: TypeScript Check ==="
yarn type:check

echo ""
echo "=== 2/5: ESLint ==="
yarn lint

echo ""
echo "=== 3/5: Prettier ==="
yarn format:check

echo ""
echo "=== 4/5: Build ==="
yarn build

echo ""
echo "=== 5/5: Secret Scan ==="
bash scripts/ai/secret-scan.sh

echo ""
echo "✅ All local validations passed! Ready for PR."
