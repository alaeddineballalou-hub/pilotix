#!/usr/bin/env bash
# Once, on the server: lets the GitHub "Deploy" button update this server.
# Makes an SSH key that can ONLY run deploy/update.sh (no shell, no tunnels), then prints what to put in GitHub.
#   sudo bash /opt/pilotix/deploy/setup-github-deploy.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
K=/root/.ssh/pilotix_github_deploy
install -m 700 -d /root/.ssh
[ -f "$K" ] || ssh-keygen -q -t ed25519 -N '' -C 'pilotix-github-deploy' -f "$K"
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
if ! grep -qF "$(cut -d' ' -f2 "$K.pub")" /root/.ssh/authorized_keys; then
  echo "command=\"/opt/pilotix/deploy/update.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $(cat "$K.pub")" >> /root/.ssh/authorized_keys
fi
chmod +x /opt/pilotix/deploy/update.sh
IP=$(hostname -I | awk '{print $1}')
cat <<MSG

On GitHub: your repository > Settings > Secrets and variables > Actions > New repository secret

1) Name: DEPLOY_HOST
   Secret: $IP

2) Name: DEPLOY_SSH_KEY
   Secret: everything below, from -----BEGIN to END----- included:

$(cat "$K")

Then: Actions > "Deploy to the server" > Run workflow.
MSG
