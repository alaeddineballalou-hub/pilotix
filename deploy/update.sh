#!/usr/bin/env bash
# Updates Pilotix on this server: a database backup, then the latest code from GitHub.
# Run by the GitHub "Deploy" button (through an SSH key that can run nothing else), or by hand:  sudo /opt/pilotix/deploy/update.sh
# Everything is inside { } so bash reads the whole file before running it (git pull may change this file).
{
set -euo pipefail
trap 'echo "ERROR: the update stopped at line $LINENO. Nothing else was changed; the site keeps the previous version." >&2' ERR
cd /opt/pilotix
# one update at a time
exec 9>/var/lock/pilotix-update
flock -n 9 || { echo "An update is already running."; exit 1; }
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
DOMAIN=$(grep -E '^DOMAIN=' deploy/.env | cut -d= -f2-)

echo "==> Backup before the update"
mkdir -p /opt/pilotix-backups
B="/opt/pilotix-backups/before-update-$(date +%F-%H%M).sql.gz"
$C exec -T postgres pg_dump -U pilotix pilotix | gzip > "$B"
echo "    $B ($(du -h "$B" | cut -f1))"

echo "==> Latest code"
git fetch -q origin && git reset -q --hard origin/main
git log -1 --format='    %h %s'

# the new version is built while the old one keeps running; the switch itself takes a few seconds
exec bash deploy/install.sh "$DOMAIN" </dev/null
}
