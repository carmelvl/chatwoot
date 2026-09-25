#!/bin/bash
# One-time setup of the Kita staging desk on a fresh Ubuntu 24.04 instance (run as root by user-data).
# Fresh secrets and a fresh database: nothing is copied from production.
set -eux
DIR=/opt/chatwoot-staging
DC=(docker compose -f docker-compose.staging.yaml)
cd "$DIR"

rnd() { openssl rand -hex "$1"; }

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i -e "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$(rnd 64)|" \
    -e "s|^FRONTEND_URL=.*|FRONTEND_URL=https://staging.support.internal.kita.ai|" \
    -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(rnd 24)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 24)|" \
    -e "s|^REDIS_URL=.*|REDIS_URL=redis://redis:6379|" \
    -e "s|^ENABLE_ACCOUNT_SIGNUP=.*|ENABLE_ACCOUNT_SIGNUP=false|" \
    -e "s|^RAILS_ENV=.*|RAILS_ENV=development|" \
    -e "s|^FORCE_SSL=.*|FORCE_SSL=false|" \
    -e "s|^LOG_SIZE=.*|LOG_SIZE=200|" \
    -e "s|^MAILER_SENDER_EMAIL=.*|MAILER_SENDER_EMAIL=Kita Staging <staging@support.internal.kita.ai>|" \
    -e "s|^SMTP_ADDRESS=.*|SMTP_ADDRESS=mailhog|" \
    -e "s|^SMTP_PORT=.*|SMTP_PORT=1025|" \
    -e "s|^SMTP_ENABLE_STARTTLS_AUTO=.*|SMTP_ENABLE_STARTTLS_AUTO=false|" \
    -e "s|^SMTP_OPENSSL_VERIFY_MODE=.*|SMTP_OPENSSL_VERIFY_MODE=none|" .env
  printf '\n# Kita staging\nDISABLE_ENTERPRISE=true\n' >> .env
  chmod 600 .env
fi

BASIC_USER=kita
if [ ! -f .env.caddy ]; then
  BASIC_PASS=$(rnd 16)
  HASH=$(docker run --rm caddy:2 caddy hash-password --plaintext "$BASIC_PASS")
  printf "BASIC_AUTH_USER=%s\nBASIC_AUTH_HASH='%s'\n" "$BASIC_USER" "$HASH" > .env.caddy
  chmod 600 .env.caddy
fi

"${DC[@]}" build base
"${DC[@]}" pull postgres redis mailhog caddy bridges grip-sync
"${DC[@]}" up -d postgres redis mailhog
sleep 15

# Schema only (no db:seed: the upstream dev seed creates a user with a public password).
"${DC[@]}" run --rm --no-deps rails bundle exec rails db:create db:schema:load db:migrate

if [ ! -f /root/staging-admin.txt ]; then
  ADMIN_EMAIL=admin@staging.kita.ai
  ADMIN_PASS="Stg-$(rnd 12)!"
  "${DC[@]}" run --rm --no-deps -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASS="$ADMIN_PASS" rails \
    bundle exec rails runner '
      account = Account.create!(name: "Kita Staging")
      Seeders::AccountSeeder.new(account: account).perform!
      # Seeded sample users share a well-known password; randomize them all.
      User.find_each { |u| u.update!(password: "Rnd-#{SecureRandom.hex(16)}!") }
      admin = User.new(name: "Staging Admin", email: ENV["ADMIN_EMAIL"], password: ENV["ADMIN_PASS"], type: "SuperAdmin")
      admin.skip_confirmation!
      admin.save!
      AccountUser.create!(account: account, user: admin, role: :administrator)
      puts "seeded account #{account.id}: #{account.conversations.count} conversations, #{account.contacts.count} contacts"
    '
  umask 077
  cat > /root/staging-admin.txt <<CREDS
Kita support desk STAGING
URL: https://staging.support.internal.kita.ai

HTTP basic auth (whole site):
  user:     $BASIC_USER
  password: ${BASIC_PASS:-see .env.caddy (hash only); regenerate if lost}

Chatwoot admin login (SuperAdmin, account "Kita Staging"):
  email:    $ADMIN_EMAIL
  password: $ADMIN_PASS
CREDS
  chmod 600 /root/staging-admin.txt
fi

"${DC[@]}" up -d

install -m 644 deployment/kita-staging/kita-staging-deploy.service /etc/systemd/system/
install -m 644 deployment/kita-staging/kita-staging-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kita-staging-deploy.timer
echo "kita staging bootstrap done"
