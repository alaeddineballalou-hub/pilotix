#!/usr/bin/env bash
# Installs (or updates) Pilotix on an Ubuntu / Debian server, in /opt/pilotix:
#   curl -fsSL https://raw.githubusercontent.com/alaeddineballalou-hub/pilotix/main/deploy/install.sh | sudo bash -s -- babyjoydz.net
# Run it again later to update to the latest version: the settings (deploy/.env) and the data are kept.
set -euo pipefail
DOMAIN="${1:-babyjoydz.net}"
DIR=/opt/pilotix
REPO=https://github.com/alaeddineballalou-hub/pilotix.git
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

echo "==> Docker and git"
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "==> Pilotix code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 50 "$REPO" "$DIR"; fi
cd "$DIR"

FIRST=0
if [ ! -f deploy/.env ]; then
  FIRST=1
  rnd() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  umask 077
  cat > deploy/.env <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(rnd 32)
JWT_SECRET=$(rnd 64)
ENV
  echo "    settings written to $DIR/deploy/.env (keep this file secret)"
fi

if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null; fi

echo "==> Building and starting (the first time takes 5-10 minutes)"
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C up -d --build
for i in $(seq 1 60); do $C exec -T server wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 && break; sleep 3; done

if [ "$FIRST" = 1 ]; then
  echo "==> First administrator"
  read -r -p "    Admin e-mail: " EMAIL </dev/tty
  while :; do
    read -r -s -p "    Admin password (10+ characters): " PASS </dev/tty; echo
    [ "${#PASS}" -ge 10 ] && break; echo "    Too short."
  done
  $C exec -T -e SEED_ADMIN_EMAIL="$EMAIL" -e SEED_ADMIN_PASSWORD="$PASS" server node apps/server/dist/migrate.js seed
fi

echo "==> Daily database backup (03:15, 14 days kept in /opt/pilotix-backups)"
mkdir -p /opt/pilotix-backups
cat > /etc/cron.d/pilotix-backup <<CRON
15 3 * * * root cd $DIR && $C exec -T postgres pg_dump -U pilotix pilotix | gzip > /opt/pilotix-backups/pilotix-\$(date +\%F).sql.gz && find /opt/pilotix-backups -name '*.sql.gz' -mtime +14 -delete
CRON

echo
echo "Pilotix is running: https://$DOMAIN"
echo "(HTTPS works once the domain's DNS points to this server; Caddy gets the certificate by itself.)"
