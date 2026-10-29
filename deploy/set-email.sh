#!/usr/bin/env bash
# Sets the e-mail account Pilotix sends from (the control room's login codes, « Mot de passe oublié » links,
# invitations, sign-ups), restarts the server with it, and checks that it can log in. Nothing is sent.
#   sudo bash /opt/pilotix/deploy/set-email.sh
# Brevo by default: server smtp-relay.brevo.com, port 587. Its « SMTP login » and an « SMTP key » are in
# Brevo → Settings → SMTP & API → SMTP (an SMTP key, not an API key). Any other SMTP server works too.
# The old settings are kept in deploy/.env.before-email-<date> (only this server can read it).
{
set -euo pipefail
trap 'echo "ERROR: stopped at line $LINENO. Your e-mail settings were not changed." >&2' ERR
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
DIR=${PILOTIX_DIR:-/opt/pilotix}
cd "$DIR"
ENV=deploy/.env
[ -f "$ENV" ] || { echo "No $DIR/$ENV: install Pilotix first (deploy/install.sh)."; exit 1; }
DOMAIN=$(grep -E '^DOMAIN=' "$ENV" | cut -d= -f2- | tr -d "\"'" || true)
DOMAIN=${DOMAIN:-pilotix.online}

echo "Pilotix e-mails: the account the server sends from."
read -r -p "  SMTP server [smtp-relay.brevo.com]: " HOST </dev/tty
HOST=${HOST:-smtp-relay.brevo.com}
read -r -p "  Port [587]: " PORT </dev/tty
PORT=${PORT:-587}
read -r -p "  SMTP login (Brevo: it looks like 1a2b3c001@smtp-brevo.com): " LOGIN </dev/tty
read -r -s -p "  SMTP key / password (it stays hidden while you paste it): " PASS </dev/tty
echo
read -r -p "  Sender people see [Pilotix <contact@$DOMAIN>]: " FROM </dev/tty
FROM=${FROM:-Pilotix <contact@$DOMAIN>}

# a quick look before anything changes
LOGIN=$(printf '%s' "$LOGIN" | tr -d '[:space:]')
PASS=$(printf '%s' "$PASS" | tr -d '\r\n')
printf '%s' "$PORT" | grep -Eq '^[0-9]{2,5}$' || { echo "The port must be a number (587, 465 or 2525)."; exit 1; }
[ -n "$LOGIN" ] || { echo "The SMTP login is empty."; exit 1; }
[ -n "$PASS" ] || { echo "The SMTP key is empty."; exit 1; }
printf '%s' "$FROM" | grep -Eq '@' || { echo "The sender needs an e-mail address, like: Pilotix <contact@$DOMAIN>"; exit 1; }
case "$HOST$LOGIN$PASS$FROM" in *"'"*) echo "A value contains a ' (single quote): it cannot be saved here. Use another key."; exit 1 ;; esac
case "$PASS" in xkeysib-*) echo "That is a Brevo API key. Pilotix needs an SMTP key (Brevo → Settings → SMTP & API → SMTP)."; exit 1 ;; esac

# the old settings kept, then the five e-mail lines replaced (single quotes: Docker reads the values as they are)
umask 077
cp "$ENV" "$ENV.before-email-$(date +%F-%H%M%S)"
grep -vE '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS|MAIL_FROM)=' "$ENV" > "$ENV.new" || true
{
  echo "SMTP_HOST='$HOST'"
  echo "SMTP_PORT='$PORT'"
  echo "SMTP_USER='$LOGIN'"
  echo "SMTP_PASS='$PASS'"
  echo "MAIL_FROM='$FROM'"
} >> "$ENV.new"
cat "$ENV.new" > "$ENV"
rm -f "$ENV.new"

echo "==> Restarting the server with the new e-mail settings (a few seconds)"
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C up -d server >/dev/null
HEALTH="fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
for i in $(seq 1 60); do $C exec -T server node -e "$HEALTH" >/dev/null 2>&1 && break; sleep 2; done

echo "==> Checking the e-mail account (nothing is sent)"
OUT=$($C exec -T server node apps/server/dist/mailcheck.js 2>&1 || true)
echo "$OUT"
if printf '%s' "$OUT" | grep -q '^E-mail: OK'; then
  echo
  echo "Done: Pilotix sends its e-mails from $FROM."
else
  echo
  echo "Not working yet. Check that the login and the key are Brevo's SMTP ones, and that your domain is"
  echo "authenticated in Brevo. Run this again to change them (your old settings are in $ENV.before-email-*)."
fi
exit 0
}
