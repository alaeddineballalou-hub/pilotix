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
# the key that seals the secrets saved in the database (couriers' keys, Meta / TikTok / WhatsApp tokens, AI keys): made
# once and never changed (what was sealed with it cannot be read with another). The off-site backup keeps it, under its
# passphrase (deploy/backup.sh): a copy of the database alone shows none of these secrets.
if ! grep -q '^DATA_KEY=' deploy/.env; then
  echo "DATA_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')" >> deploy/.env
  echo "    DATA_KEY added to deploy/.env (it seals the saved secrets: keep this file safe)"
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
# the server's own lines, safe for a public log: only what matters, cut short, no e-mails, no phone or long numbers
safe_log() { $C logs --no-color --tail "${1:-300}" server 2>&1 | grep -av -E '^\s*$|RouterExplorer|RoutesResolver|InstanceLoader' | tail -n "${2:-25}" | sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/***@***/g; s/[0-9]{7,}/#######/g' | cut -c1-260 | sed 's/^/    | /' || true; }
# what the database is doing right now (a long move of the shops' data shows here), without any data in it
db_now() { $C exec -T postgres psql -U pilotix -d pilotix -tAc "SELECT coalesce(string_agg(round(extract(epoch FROM now() - query_start))::text || ' s: ' || left(regexp_replace(query, '[0-9]{4,}|''[^'']*''', '…', 'g'), 90), ' / '), 'idle') FROM pg_stat_activity WHERE datname = 'pilotix' AND state = 'active' AND pid <> pg_backend_pid()" 2>/dev/null | cut -c1-400 || true; }
echo "    before the switch: server $($C ps --format '{{.State}} {{.Status}}' server 2>/dev/null | head -1)"
safe_log 400 30
echo "    database now: $(db_now)"
# the move into shared tables (or any long migration) still running: never stopped half-way by a new start
RUNNING=$($C exec -T postgres psql -U pilotix -d pilotix -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'pilotix' AND state = 'active' AND pid <> pg_backend_pid() AND (query ILIKE '%px_tenantize%' OR query ILIKE '%px_move_shop%' OR query ILIKE '%ALTER TABLE%' OR query ILIKE '%CREATE INDEX%')" 2>/dev/null | tr -dc '0-9' || true)
if [ "${RUNNING:-0}" -gt 0 ]; then
  echo "    a migration is running: the new images are built, the server is not restarted until it ends"
  $C build
  $C up -d --no-recreate
else
  $C up -d --build
fi
# asked with node to 127.0.0.1 (busybox wget to « localhost » may try IPv6, where the server does not listen: it never
# answered, so this waited the full 3 minutes on every update)
HEALTH="fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# up to 20 minutes: moving a big shop's data the first time takes a while; a line every minute says what is happening
CRASHES=0
for i in $(seq 1 400); do
  $C exec -T server node -e "$HEALTH" >/dev/null 2>&1 && break
  if [ $((i % 20)) = 0 ]; then
    STATE=$($C ps --format '{{.State}}' server 2>/dev/null | head -1 || true)
    echo "    waiting ($((i * 3)) s): server $STATE; database: $(db_now)"
    # it keeps stopping and starting again (a crash, not a long migration): no use waiting longer
    if [ "$STATE" = restarting ]; then CRASHES=$((CRASHES + 1)); else CRASHES=0; fi
    [ "$CRASHES" -ge 3 ] && break
  fi
  sleep 3
done
# said in one line the Deploy button reads: the proof the new version runs, checked here on the server itself
if $C exec -T server node -e "$HEALTH" >/dev/null 2>&1; then
  echo "Server: OK (the new version answers on the server itself)"
else
  echo "Server: NOT ANSWERING on the server itself (see: $C logs --tail 80 server)"
  safe_log 2000 40
fi

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

echo "==> Daily database backup (03:15, 14 days kept in /opt/pilotix-backups; an encrypted copy to Backblaze B2 once set up: deploy/backup.sh)"
mkdir -p /opt/pilotix-backups
cat > /etc/cron.d/pilotix-backup <<CRON
15 3 * * * root bash $DIR/deploy/backup.sh >> /var/log/pilotix-backup.log 2>&1
CRON

echo "==> E-mails (the control room's login code, password links, invitations, sign-ups)"
$C exec -T server node apps/server/dist/mailcheck.js || echo "E-mail: FAILED (the check did not run)"

# the server's own SSH key (public: anyone can ask the server for it), for GitHub's « Deploy » to check it talks to this
# server and no other (the secret DEPLOY_KNOWN_HOSTS: these words, as they are)
for k in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub; do
  if [ -r "$k" ]; then echo "Host key: $(cut -d' ' -f1,2 "$k")"; break; fi
done

echo
echo "Pilotix is running: https://$DOMAIN"
echo "(HTTPS works once the domain's DNS points to this server; Caddy gets the certificate by itself.)"
