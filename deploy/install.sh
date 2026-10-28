#!/usr/bin/env bash
# Installs (or updates) Pilotix on an Ubuntu / Debian server, in /opt/pilotix:
#   curl -fsSL https://raw.githubusercontent.com/alaeddineballalou-hub/pilotix/main/deploy/install.sh | sudo bash -s -- pilotix.online
# Run it again later to update to the latest version: the settings (deploy/.env) and the data are kept.
set -euo pipefail
DOMAIN="${1:-pilotix.online}"
DIR=/opt/pilotix
REPO=${PILOTIX_REPO:-git@github.com:alaeddineballalou-hub/pilotix.git}
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
# never stop silently: say which line failed
trap 'echo "ERROR: the installer stopped at line $LINENO. Send a screenshot of this screen." >&2' ERR

echo "==> Docker and git"
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "==> Pilotix code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 50 "$REPO" "$DIR"; fi
cd "$DIR"

if [ ! -f deploy/.env ]; then
  rnd() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  umask 077
  cat > deploy/.env <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(rnd 32)
JWT_SECRET=$(rnd 64)
ENV
  echo "    settings written to $DIR/deploy/.env (keep this file secret)"
fi
# shops' own domains (myshop.com) point to this server's public address; behind Cloudflare the platform's DNS shows
# Cloudflare's addresses, so the server's own is written once here (change it in deploy/.env if the server moves)
if ! grep -q '^PUBLIC_IP=' deploy/.env; then
  IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  if printf '%s' "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
    echo "PUBLIC_IP=$IP" >> deploy/.env
    echo "    server address for shops' own domains: $IP"
  fi
fi

echo "==> Server protection"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw fail2ban python3-systemd unattended-upgrades >/dev/null
# security updates install themselves every night
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
# firewall: only SSH and the website are reachable (PostgreSQL and Redis never are; Docker publishes only 80 and 443)
# (Ubuntu 24.04 starts SSH on demand: sshd -T fails without /run/sshd, and must never stop the installer)
mkdir -p /run/sshd
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true); SSH_PORT=${SSH_PORT:-22}
ufw allow "$SSH_PORT"/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
ufw --force enable >/dev/null
# fail2ban: an address that fails SSH logins 5 times is banned for an hour
cat > /etc/fail2ban/jail.d/pilotix.conf <<JAIL
[sshd]
enabled = true
port = $SSH_PORT
backend = systemd
maxretry = 5
bantime = 1h
JAIL
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || echo "    WARNING: fail2ban did not start (the site still works; the firewall is on)"
# SSH by key only: ONLY when asked (SSH_KEY_ONLY=1). Never automatic: a key file put there by the hosting company
# (not by the owner) turned off root password logins on Ubuntu 24.04 and locked the owner out of the server.
if [ "${SSH_KEY_ONLY:-0}" = 1 ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/99-pilotix.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  echo "    SSH: key only (passwords refused)"
else
  # undo the old automatic key-only setting, so a server that was locked by it accepts the root password again
  if [ -f /etc/ssh/sshd_config.d/99-pilotix.conf ]; then
    rm -f /etc/ssh/sshd_config.d/99-pilotix.conf
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  fi
fi

echo "==> Building and starting (the first time takes 5-10 minutes)"
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C up -d --build
for i in $(seq 1 60); do $C exec -T server wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 && break; sleep 3; done

# first administrator, asked until one exists (so a run that stopped half-way asks again next time)
ADMINS=$($C exec -T postgres psql -U pilotix -d pilotix -tAc "SELECT count(*) FROM profiles WHERE 'admin' = ANY(roles)" 2>/dev/null | tr -dc '0-9' || true)
if [ "${ADMINS:-0}" = 0 ]; then
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

echo "==> E-mails (the control room's login code, password links, invitations, sign-ups)"
$C exec -T server node apps/server/dist/mailcheck.js || echo "E-mail: FAILED (the check did not run)"

echo
echo "Pilotix is running: https://$DOMAIN"
echo "(HTTPS works once the domain's DNS points to this server; Caddy gets the certificate by itself.)"
