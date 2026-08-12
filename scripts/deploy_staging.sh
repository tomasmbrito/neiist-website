#!/bin/bash
set -e
export PATH="$HOME/.nvm/versions/node/v24.11.1/bin:$PATH"

echo "🚀 Deploying to Staging..."

APP_DIR=/home/neiist/website-staging
PM2_NAME=staging

cd $APP_DIR || { echo "❌ Directory not found: $APP_DIR"; exit 1; }

echo "📦 Fetching latest code..."
git fetch origin
git checkout main
git reset --hard origin/main

echo "📁 Installing dependencies..."
yarn install --frozen-lockfile

echo "🏗️ Building project..."
NODE_OPTIONS="--max-old-space-size=4096" yarn build

# After the build, before the restart — see the note in deploy_prod.sh. Staging is where a
# migration gets to fail first.
echo "🗄️ Applying database migrations..."
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi
yarn db:migrate

echo "♻️ Restarting PM2 process..."
pm2 restart $PM2_NAME || pm2 start ecosystem.config.js

echo "🧹 Cleaning up..."
git status

echo "✅ Staging deployment complete!"
