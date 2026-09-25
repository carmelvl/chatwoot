#!/bin/bash
# Kita staging auto-deploy: run every 30s by kita-staging-deploy.timer. Logs go to journald.
# Pulls origin/staging; code reloads live (bind mount). Restarts only what needs it.
set -euo pipefail
# git reset rewrites this file; run from a private copy so bash never reads a changed script.
if [ "$0" != /run/kita-staging-autodeploy.sh ]; then
  cp "$0" /run/kita-staging-autodeploy.sh && exec bash /run/kita-staging-autodeploy.sh
fi
cd /opt/chatwoot-staging
BRANCH=staging
DC=(docker compose -f docker-compose.staging.yaml)

git fetch --quiet origin "$BRANCH"
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse "origin/$BRANCH")
[ "$OLD" = "$NEW" ] && exit 0

CHANGED=$(git diff --name-only "$OLD" "$NEW")
echo "deploying $OLD -> $NEW ($(echo "$CHANGED" | wc -l) files)"
git reset --hard --quiet "$NEW"

if echo "$CHANGED" | grep -qE '^(package\.json|pnpm-lock\.yaml)$'; then
  echo "package.json/pnpm-lock changed: restarting vite (pnpm install)"
  "${DC[@]}" restart vite
fi

if echo "$CHANGED" | grep -qE '^docker-compose\.staging\.yaml$|^Caddyfile\.staging$'; then
  echo "compose/Caddyfile changed: docker compose up -d"
  "${DC[@]}" up -d --remove-orphans
  "${DC[@]}" restart caddy
fi

if echo "$CHANGED" | grep -qE '^(Gemfile|Gemfile\.lock)$|^db/migrate/|^db/schema\.rb$|^config/(initializers|environments)/|^config/(application|sidekiq|database)\.(rb|yml)$'; then
  if echo "$CHANGED" | grep -qE '^Gemfile'; then
    echo "Gemfile changed: bundle install"
    "${DC[@]}" run --rm --no-deps rails bundle install
  fi
  echo "running migrations"
  "${DC[@]}" run --rm --no-deps --entrypoint "" rails bundle exec rails db:migrate
  echo "restarting rails + sidekiq"
  "${DC[@]}" restart rails sidekiq
elif echo "$CHANGED" | grep -qE '^(app|lib|config)/'; then
  # Rails autoreloads app/ and lib/; sidekiq in development reloads too. Nothing to do.
  echo "ruby/frontend change: relying on live reload"
fi

echo "deployed $(git log -1 --format='%h %s')"
