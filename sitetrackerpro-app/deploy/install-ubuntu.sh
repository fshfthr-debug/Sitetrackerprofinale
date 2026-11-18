#!/usr/bin/env bash
# SiteTrackerPro v3 — one-command install on Ubuntu 22.04 / 24.04
#
#   sudo DOMAIN=app.example.com bash install-ubuntu.sh
#
# Installs Node.js + PostgreSQL, creates the database, loads the schema,
# configures the app as a systemd service and puts Caddy in front for HTTPS.
# Safe to re-run: it will not duplicate users, databases or services.

set -euo pipefail

DOMAIN="${DOMAIN:-}"
APP_DIR="${APP_DIR:-/opt/sitetrackerpro}"
DB_NAME="${DB_NAME:-sitetrackerpro}"
DB_USER="${DB_USER:-stp}"
DB_PASS="${DB_PASS:-$(openssl rand -hex 16)}"
NODE_MAJOR="${NODE_MAJOR:-20}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root (sudo)."
[ -d "$APP_DIR/backend" ] || die "App not found at $APP_DIR (copy the sitetrackerpro-app folder there first)."
command -v apt-get >/dev/null || die "This script targets Ubuntu/Debian."

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

log "Installing Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

log "Installing PostgreSQL"
apt-get install -y -qq postgresql postgresql-contrib >/dev/null
systemctl enable --now postgresql >/dev/null
PGVER="$(ls /etc/postgresql | sort -V | tail -1)"
pg_ctl_path="/usr/lib/postgresql/${PGVER}/bin"

log "Creating database and role (idempotent)"
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"" | grep -q 1 || \
  su postgres -c "psql -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1 || \
  su postgres -c "createdb -O ${DB_USER} ${DB_NAME}"

log "Loading the schema"
if [ "$(su postgres -c "psql -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='users'\"" -d "${DB_NAME}" | tr -d ' ')" = "0" ]; then
  su postgres -c "psql -q -d ${DB_NAME}" < "$APP_DIR/database/schema.sql"
  su postgres -c "psql -q -d ${DB_NAME}" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO ${DB_USER}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};"
  echo "schema loaded"
else
  echo "schema already present, leaving data untouched"
fi

log "Installing application dependencies"
cd "$APP_DIR/backend"
npm install --omit=dev --no-audit --no-fund --loglevel=error

log "Writing production configuration"
mkdir -p "$APP_DIR/backend/public"
cat > "$APP_DIR/backend/.env" <<ENVFILE
PORT=3000
NODE_ENV=production
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=${DB_NAME}
JWT_SECRET=$(openssl rand -hex 32)
CORS_ORIGIN=
TRUST_PROXY=1
ENVFILE
chmod 600 "$APP_DIR/backend/.env"

log "Creating the service"
cat > /etc/systemd/system/sitetrackerpro.service <<UNIT
[Unit]
Description=SiteTrackerPro v3 API and app
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/backend
EnvironmentFile=${APP_DIR}/backend/.env
ExecStart=/usr/bin/node ${APP_DIR}/backend/backend-v3-enhanced.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sitetrackerpro >/dev/null
systemctl restart sitetrackerpro
sleep 2

log "Checking the app responds"
if curl -fsS http://127.0.0.1:3000/health >/dev/null; then
  echo "health check passed"
else
  echo "health endpoint did not answer — recent log:"; journalctl -u sitetrackerpro -n 25 --no-pager || true
  die "App failed to start."
fi

if [ -n "$DOMAIN" ]; then
  log "Configuring HTTPS for ${DOMAIN}"
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq caddy >/dev/null 2>&1 || {
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq && apt-get install -y -qq caddy >/dev/null
    }
  fi
  cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
CADDY
  systemctl reload caddy || systemctl restart caddy
  echo "HTTPS configured for https://${DOMAIN} (certificate issued automatically)"
fi

log "Firewall"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

cat <<DONE

────────────────────────────────────────────────────────────
SiteTrackerPro is running.

  Local URL : http://127.0.0.1:3000
  Public URL: ${DOMAIN:+https://$DOMAIN}${DOMAIN:-<set DOMAIN=your.domain and re-run>}
  Database  : ${DB_NAME} on 127.0.0.1:5432 (user ${DB_USER})
  Credentials: saved in ${APP_DIR}/backend/.env  (mode 600)
  Logs      : journalctl -u sitetrackerpro -f
  Backups   : bash ${APP_DIR}/deploy/backup.sh

Next: open the public URL and create the first account — that
becomes your admin login. Then create a project and run a cut &
fill calculation to confirm the database round-trip.

Registering is open by default. Once your clients have accounts,
close it: add DISABLE_REGISTRATION=1 to the .env and restart.
────────────────────────────────────────────────────────────
DONE
