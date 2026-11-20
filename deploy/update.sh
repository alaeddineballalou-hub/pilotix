#!/usr/bin/env bash
# Updates Pilotix on this server: a database backup, then the code from GitHub (the version asked for, else the latest main).
# Run by the GitHub "Deploy" button (through an SSH key that can run nothing else), or by hand:  sudo /opt/pilotix/deploy/update.sh
# Everything is inside { } so bash reads the whole file before running it (git pull may change this file).
{
set -euo pipefail
trap 'echo "ERROR: the update stopped at line $LINENO. Nothing else was changed; the site keeps the previous version." >&2' ERR
cd /opt/pilotix
# The version to put live. The Deploy button sends « update <version> »: the one its check approved (the owner's yes,
# with Pilotix CI green). Without it (by hand, or an older Deploy button) the latest main, as before. Until 20 Nov 2026
# it always took the latest main: a push that landed seconds after the check went live without the owner's yes.
WANT="${1:-}"
case "${SSH_ORIGINAL_COMMAND:-}" in
  "" | update) ;;
  "update "*) WANT="${SSH_ORIGINAL_COMMAND#update }" ;;
  *) echo "ERROR: unknown request « ${SSH_ORIGINAL_COMMAND} » (only « update » or « update <version> »). Nothing was changed." >&2; exit 1 ;;
esac
if [ -n "$WANT" ] && ! [[ "$WANT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: « $WANT » is not a version (40 characters, 0-9 a-f). Nothing was changed." >&2
  exit 1
fi
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

echo "==> Code"
git fetch -q origin
if [ -n "$WANT" ]; then
  # a version of main only (never another branch); an older one is allowed (going back to it)
  if ! git merge-base --is-ancestor "$WANT" origin/main 2>/dev/null; then
    echo "ERROR: version $WANT is not on main (or too old for this server's copy). Nothing else was changed; the site keeps the previous version." >&2
    exit 1
  fi
  git reset -q --hard "$WANT"
else
  git reset -q --hard origin/main
fi
git log -1 --format='    %h %s'

# the new version is built while the old one keeps running; the switch itself takes a few seconds. install.sh keeps
# this version (it never pulls a later push)
PILOTIX_KEEP_VERSION=1 exec bash deploy/install.sh "$DOMAIN" </dev/null
}
