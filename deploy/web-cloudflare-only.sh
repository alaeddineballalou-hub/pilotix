#!/usr/bin/env bash
# Only Cloudflare reaches the website (ports 80 and 443): step 5 of the owner's security list (21 Nov 2026).
# OFF for now: the owner keeps the backup door direct.pilotix.online, which reaches the server without Cloudflare, and a
# shop's own domain that is not behind Cloudflare would stop working too (and the GitHub check of the server itself).
# Turn it on only when every address of the site is orange in Cloudflare: add WEB_CLOUDFLARE_ONLY=1 to deploy/.env,
# then update (or run it by hand: sudo /opt/pilotix/deploy/web-cloudflare-only.sh on). Off again: remove that line, then
# update (or: sudo /opt/pilotix/deploy/web-cloudflare-only.sh off).
# Docker opens 80 and 443 past ufw (its own iptables rules), so the filter sits in Docker's DOCKER-USER chain: a
# connection to 80 or 443 (as the visitor dialled it) passes only from Cloudflare's addresses (https://www.cloudflare.com/ips/,
# the same list as the Caddyfile), the server itself and Docker's own networks. A service puts it back after a restart.
#   sudo deploy/web-cloudflare-only.sh on | off | status
set -euo pipefail
CHAIN=PILOTIX-WEB
UNIT=/etc/systemd/system/pilotix-web-cloudflare.service
CF4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"
LOCAL4="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
LOCAL6="::1/128 fc00::/7 fe80::/10"
HERE=$(cd "$(dirname "$0")" && pwd)

# the jumps into the filter: TCP and UDP (HTTP/3), ports 80 and 443 as dialled (before Docker changes the port)
jumps() { for port in 80 443; do for proto in tcp udp; do echo "-p $proto -m conntrack --ctorigdstport $port --ctdir ORIGINAL -j $CHAIN"; done; done; }

on_family() { # iptables|ip6tables, allowed ranges
  local ipt=$1 allowed=$2
  # Docker makes DOCKER-USER (and sends forwarded traffic through it); without it, Docker does not publish here
  if ! $ipt -w -nL DOCKER-USER >/dev/null 2>&1; then echo "    $ipt: no DOCKER-USER chain (Docker without it): skipped"; return 0; fi
  $ipt -w -N "$CHAIN" 2>/dev/null || $ipt -w -F "$CHAIN"
  for r in $allowed; do $ipt -w -A "$CHAIN" -s "$r" -j RETURN; done
  $ipt -w -A "$CHAIN" -j DROP
  while read -r j; do
    # shellcheck disable=SC2086
    $ipt -w -C DOCKER-USER $j 2>/dev/null || $ipt -w -I DOCKER-USER $j
  done < <(jumps)
}

off_family() {
  local ipt=$1
  while read -r j; do
    # shellcheck disable=SC2086
    while $ipt -w -C DOCKER-USER $j 2>/dev/null; do $ipt -w -D DOCKER-USER $j; done
  done < <(jumps)
  $ipt -w -F "$CHAIN" 2>/dev/null || true
  $ipt -w -X "$CHAIN" 2>/dev/null || true
}

case "${1:-status}" in
  on)
    on_family iptables "$CF4 $LOCAL4"
    if command -v ip6tables >/dev/null; then on_family ip6tables "$CF6 $LOCAL6"; fi
    # after a restart: Docker first, then this filter again
    if [ -d /etc/systemd/system ] && [ "${NO_UNIT:-}" != 1 ]; then
      printf '[Unit]\nDescription=Pilotix: only Cloudflare reaches the website\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\nEnvironment=NO_UNIT=1\nExecStart=/bin/bash %s/web-cloudflare-only.sh on\n[Install]\nWantedBy=multi-user.target\n' "$HERE" > "$UNIT"
      systemctl daemon-reload && systemctl enable pilotix-web-cloudflare.service >/dev/null 2>&1 || true
    fi
    echo "    website: only Cloudflare (and the server itself) reaches ports 80 and 443"
    ;;
  off)
    off_family iptables
    if command -v ip6tables >/dev/null; then off_family ip6tables; fi
    if [ -f "$UNIT" ]; then systemctl disable pilotix-web-cloudflare.service >/dev/null 2>&1 || true; rm -f "$UNIT"; systemctl daemon-reload || true; fi
    echo "    website: open to all on ports 80 and 443 (Cloudflare and the backup door)"
    ;;
  status)
    if iptables -w -nL "$CHAIN" >/dev/null 2>&1; then echo "on: only Cloudflare reaches ports 80 and 443"; else echo "off: ports 80 and 443 open to all"; fi
    ;;
  *) echo "usage: $0 on | off | status" >&2; exit 2 ;;
esac
