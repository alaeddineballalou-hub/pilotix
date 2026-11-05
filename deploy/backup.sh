#!/usr/bin/env bash
# The nightly backup (03:15, set by install.sh): the database dumped and compressed on this server (14 days kept in
# /opt/pilotix-backups). The off-site copy is set in the control room (Sauvegardes › Copie hors du serveur: the server
# sends it, apps/server/src/offsite.ts); or here, once deploy/.env has the cloud storage's 4 settings — an encrypted
# copy sent to Backblaze B2, so the data survives even if this server is lost:
#   BACKUP_B2_BUCKET=pilotix-backups        the bucket's name (a private bucket)
#   BACKUP_B2_KEY_ID=...                    the application key's keyID (a key for this bucket only)
#   BACKUP_B2_KEY=...                       the application key itself
#   BACKUP_PASSPHRASE=...                   a long password of your own: the copies are unreadable without it (keep it
#                                           somewhere safe, away from this server)
# To read a copy back:  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in <file>.sql.gz.enc -out <file>.sql.gz
# (and pilotix-keys.enc the same way: the DATA_KEY line to put in the new server's deploy/.env, without which the saved
# couriers' keys and tokens in the copy cannot be read)
# Run by hand to test:  sudo bash /opt/pilotix/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
DIR=/opt/pilotix-backups
mkdir -p "$DIR"
F="$DIR/pilotix-$(date +%F).sql.gz"
$C exec -T postgres pg_dump -U pilotix pilotix | gzip > "$F"
find "$DIR" -name '*.sql.gz' -mtime +14 -delete
echo "Backup: $F ($(du -h "$F" | cut -f1))"

# the value of one setting of deploy/.env ('' when it is not there)
setting() { grep -E "^$1=" deploy/.env 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true; }
BUCKET=$(setting BACKUP_B2_BUCKET)
KEY_ID=$(setting BACKUP_B2_KEY_ID)
KEY=$(setting BACKUP_B2_KEY)
PASS=$(setting BACKUP_PASSPHRASE)
if [ -z "$BUCKET" ] || [ -z "$KEY_ID" ] || [ -z "$KEY" ] || [ -z "$PASS" ]; then
  echo "Off-site copy: not set up (the 4 BACKUP_… lines in deploy/.env)"
  exit 0
fi
if [ "${#PASS}" -lt 16 ]; then
  echo "Off-site copy: NOT SENT — BACKUP_PASSPHRASE must have 16 characters or more" >&2
  exit 1
fi
E="$F.enc"
K="$DIR/pilotix-keys.enc"
trap 'rm -f "$E" "$K"' EXIT
# encrypted here, before it leaves: the storage company never sees the data
BACKUP_PASSPHRASE="$PASS" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$F" -out "$E" -pass env:BACKUP_PASSPHRASE
# the key that seals the saved secrets goes too, under the same passphrase (a new server needs it to read them)
printf 'DATA_KEY=%s\n' "$(setting DATA_KEY)" | BACKUP_PASSPHRASE="$PASS" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out "$K" -pass env:BACKUP_PASSPHRASE
for f in "$E" "$K"; do
  docker run --rm -v "$DIR:/data:ro" \
    -e RCLONE_CONFIG_B2_TYPE=b2 -e RCLONE_CONFIG_B2_ACCOUNT="$KEY_ID" -e RCLONE_CONFIG_B2_KEY="$KEY" \
    rclone/rclone:1 copyto "/data/$(basename "$f")" "b2:$BUCKET/$(basename "$f")" --no-traverse
done
echo "Off-site copy: OK (b2:$BUCKET/$(basename "$E"), and the key of the saved secrets)"
