#!/usr/bin/env bash
# Pre-task check — run before starting any implementation task.
# Ensures the working tree is clean and the project builds.

set -euo pipefail

echo "🔍 Running pre-task checks..."

# 1. Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  Warning: You have uncommitted changes."
  git status --short
fi

# 2. TypeScript check
echo "📦 Running type:check..."
yarn type:check

# 3. Lint check
echo "🔍 Running lint..."
yarn lint || echo "⚠️  Lint has warnings/errors (review above)"

# 4. Format check
echo "✨ Running format:check..."
yarn format:check || echo "⚠️  Formatting issues found (run 'yarn format' to fix)"

echo "✅ Pre-task checks complete."
