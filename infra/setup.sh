#!/usr/bin/env bash
#
# Build a coCine server from a bare Oracle Always Free instance.
#
#     sudo ./setup.sh cocine.example.com
#
# Written to be run twice. Oracle terminates instances it judges idle and gives
# no warning, so the question is not whether this box will need rebuilding but
# how long that takes when it does -- and a runbook somebody follows by hand at
# eleven at night is the wrong answer. Every step here is idempotent.
#
# What it does NOT do, deliberately:
#   - open the ports in Oracle's security list. That is done in the console or
#     the CLI, outside the instance, and is the one step nothing on the machine
#     can perform for you.
#   - install coturn. That belongs on the *second* free instance; see
#     docs/deploying.md. Running the relay beside the server would have voice
#     traffic and film signalling competing for one 1/8-OCPU box.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: sudo $0 <domain>    e.g. sudo $0 cocine.example.com" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say () { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- packages ----------------------------------------------------------------
say "packages"
if command -v dnf >/dev/null; then
  # Oracle Linux, which is what the micro shapes default to.
  dnf install -y curl firewalld
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs
  dnf install -y 'dnf-command(copr)' || true
  dnf copr enable -y @caddy/caddy || true
  dnf install -y caddy
else
  apt-get update -y
  apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https firewalld
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# --- user and layout ---------------------------------------------------------
say "user and directories"
id -u cocine >/dev/null 2>&1 || useradd --system --home /opt/cocine --shell /usr/sbin/nologin cocine
mkdir -p /opt/cocine /etc/cocine /var/log/caddy
chown -R cocine:cocine /opt/cocine

# --- the server --------------------------------------------------------------
# `server.mjs` is built on your machine with `npm run build:server` and copied
# here. Nothing is compiled on the instance: a 1 GB box has no business holding
# a toolchain, and `npm ci` at the repo root would pull Electron onto it.
say "server"
if [ ! -f /opt/cocine/server.mjs ]; then
  cat >&2 <<'MISSING'
  /opt/cocine/server.mjs is not there.

  On your own machine:
      npm run build:server
      scp dist/server.mjs opc@<instance>:/tmp/server.mjs
      sudo mv /tmp/server.mjs /opt/cocine/server.mjs

  Then run this again.
MISSING
  exit 1
fi

# The bundle keeps one dependency external: the native WebRTC addon that
# bittorrent-tracker needs. It cannot be bundled, so it is installed.
if [ ! -d /opt/cocine/node_modules/webrtc-polyfill ]; then
  say "the one runtime dependency"
  sudo -u cocine bash -c 'cd /opt/cocine && npm init -y >/dev/null && npm i --omit=dev webrtc-polyfill'
fi

# --- configuration -----------------------------------------------------------
say "configuration"
if [ ! -f /etc/cocine/server.env ]; then
  cat > /etc/cocine/server.env <<EOF
PORT=8787

# Not optional behind TLS. The server derives the tracker address from the Host
# header otherwise, which gives clients ws:// on the wrong port -- and the
# failure looks like the transfer being broken rather than the address being
# wrong.
COCINE_PUBLIC_HOST=wss://${DOMAIN}

# Voice relay. Fill these in once coturn is running on the second instance; see
# docs/deploying.md. Both or neither -- half a configuration hands out
# credentials nothing will accept.
# COCINE_TURN_URLS=turn:turn.${DOMAIN}:3478,turns:turn.${DOMAIN}:443
# COCINE_TURN_SECRET=

# Relay mode storage, optional. Without it the host is simply offered no
# peer-to-peer-or-relay toggle.
# COCINE_R2_ENDPOINT=
# COCINE_R2_BUCKET=
# COCINE_R2_KEY_ID=
# COCINE_R2_SECRET=

COCINE_VERSION=$(date -u +%Y-%m-%d)
EOF
  chmod 640 /etc/cocine/server.env
  chown root:cocine /etc/cocine/server.env
fi

sed "s/cocine\.example\.com/${DOMAIN}/" "$HERE/Caddyfile" > /etc/caddy/Caddyfile

install -m 644 "$HERE/cocine-server.service" /etc/systemd/system/
install -m 644 "$HERE/cocine-keepalive.service" /etc/systemd/system/
install -m 644 "$HERE/cocine-keepalive.timer" /etc/systemd/system/
mkdir -p /opt/cocine/infra
install -m 755 "$HERE/keepalive.sh" /opt/cocine/infra/keepalive.sh

# --- trim ---------------------------------------------------------------------
# Oracle Linux ships services this box has no use for. Worth about 45 MB of the
# 945 MB, which is housekeeping rather than rescue -- but a rebuild should not
# have to rediscover it.
#
# Only these two. Two neighbouring candidates must stay, and the reasons are
# worth recording because both look disposable:
#
#   oracle-cloud-agent (156 MB, the largest single consumer) runs the `gomon`
#   plugin that reports CPU and network metrics to OCI Monitoring -- which is
#   exactly what the idle-reclamation policy reads. Disabling it would leave
#   keepalive.sh burning CPU that Oracle never observes, while the instance
#   reported no metrics at all.
#
#   tuned is not generic tuned here: its profile is
#   `oci-rps-xps oci-busy-polling oci-cpu-power oci-nic`, which is Oracle's own
#   packet steering and NIC tuning. Not a trade worth making on a box whose
#   whole job is network traffic.
#
# PCP was checked rather than assumed -- `gomon` contains the strings "pcp" and
# "Pc"/"Pd", which look like a dependency and are Go runtime artefacts and a
# Unicode category table. The agent does not require the package, gomon holds
# no descriptors on any PCP path, and nothing connects to pmcd.
say "trimming unused services"
systemctl disable --now pmlogger pmie pmcd >/dev/null 2>&1 || true
systemctl disable --now rpcbind.socket rpcbind >/dev/null 2>&1 || true

# --- firewall ----------------------------------------------------------------
# Oracle Linux images ship iptables rules that reject almost everything, which
# is the reason "I opened the port in the console and it still does not work"
# is the most common way this goes wrong.
say "firewall"
systemctl enable --now firewalld
firewall-cmd --permanent --add-service=http >/dev/null
firewall-cmd --permanent --add-service=https >/dev/null
firewall-cmd --reload >/dev/null

# --- start -------------------------------------------------------------------
say "starting"
systemctl daemon-reload
systemctl enable --now cocine-server.service
systemctl enable --now cocine-keepalive.timer
systemctl restart caddy

sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:8787/health >/dev/null; then
  echo
  echo "  server is up locally."
  echo "  Next: point ${DOMAIN} at this instance's public IP, then check"
  echo "      curl https://${DOMAIN}/health"
  echo "  and build the desktop app with"
  echo "      COCINE_DEFAULT_SERVER=wss://${DOMAIN} npm run dist:linux"
else
  echo "  server did not answer. journalctl -u cocine-server -n 50" >&2
  exit 1
fi
