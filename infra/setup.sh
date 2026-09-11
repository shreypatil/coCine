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

# The three sections below run BEFORE any package work, and the order is the
# point. Stopping the unused services frees memory the install wants, the nice
# drop-ins stop Ksplice and dnf-makecache fighting it for an eighth of a core,
# and the crashkernel change is staged for the next boot. Run after the install
# instead -- as they originally were -- and the install is the one thing that
# has to survive without them, which on this shape it does not.

# --- swap --------------------------------------------------------------------
# The image ships a 498 MB swapfile, which is not enough to install its own
# packages. dnf loading metadata for six repositories reached a 748 MB resident
# set on a 945 MB box and was OOM-killed mid-transaction -- and because the
# kernel picks a victim by size, what dies is whatever is largest, not whatever
# is at fault.
#
# 2 GB on a disk with 24 GB free. `vm.swappiness=10` keeps it out of the way in
# normal running: the server holds rooms in memory and should not be paged out
# during a film, but having somewhere to spill beats being killed. This is
# provisioning headroom, not a runtime crutch.
say "swap"
if [ ! -f /cocine.swap ]; then
  fallocate -l 2G /cocine.swap || dd if=/dev/zero of=/cocine.swap bs=1M count=2048 status=none
  chmod 600 /cocine.swap
  mkswap /cocine.swap >/dev/null
  swapon /cocine.swap
  grep -q '^/cocine.swap' /etc/fstab || echo '/cocine.swap none swap sw 0 0' >> /etc/fstab
fi
sysctl -qw vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.d/99-cocine.conf 2>/dev/null \
  || echo 'vm.swappiness=10' > /etc/sysctl.d/99-cocine.conf

# --- reclaim memory the image gives away -------------------------------------
# Oracle Linux reserves a crash-dump area sized by a rule that reads
# `crashkernel=1G-64G:448M` -- sensible on a 32 GB server, catastrophic here.
# It takes 448 MB of the 945 MB, which is 47% of the machine, to hold a vmcore
# nobody on this deployment would ever read; journald is what we would look at.
#
# It does not apply on the provisioning boot, so a fresh instance reports the
# full 945 MB and looks fine. The reservation appears on the FIRST REBOOT, which
# is a memorably bad time to discover it -- a 1 GB box drops to 498 MB with the
# cloud agent already holding 156 MB of that, and sshd starts failing to fork.
say "reclaiming crash-dump memory"
systemctl disable --now kdump >/dev/null 2>&1 || true
grubby --update-kernel=ALL --remove-args=crashkernel >/dev/null 2>&1 || true
grubby --update-kernel=ALL --args=crashkernel=no >/dev/null 2>&1 || true
if grep -q 'crashkernel=[0-9]' /proc/cmdline 2>/dev/null; then
  RECLAIM_PENDING=1   # reservation is live right now; a reboot gets it back
fi

# mcelog cannot work on the AMD family these shapes use and fails on every boot,
# leaving a permanently red `systemctl --failed`.
systemctl disable --now mcelog >/dev/null 2>&1 || true

# Persistent logs. The journal defaults to /run and dies with the boot, so the
# evidence of any incident is gone by the time you reboot to recover from it.
# There are 24 GB free; this is cheap.
mkdir -p /var/log/journal
systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
systemctl restart systemd-journald

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

# --- stop routine maintenance from starving the box --------------------------
# This shape is 1/8 OCPU -- about an eighth of a core sustained, whatever nproc
# reports. Ksplice's live kernel patching and dnf's metadata refresh each
# saturate it completely, and while one runs nothing else gets enough CPU to be
# useful: sshd accepts the TCP connection and then never manages to send a
# banner, which looks exactly like a firewall problem and is not one. Left
# alone, either firing mid-film would stall the server and every room with it.
#
# The fix is priority, not removal. Ksplice is applying kernel security patches
# and should keep doing so; it just must yield, the same way keepalive.sh does.
say "de-prioritising maintenance jobs"

# dnf-makecache is DISABLED rather than de-prioritised, and the difference
# matters. Nicing it produced a textbook priority inversion: the refresh crawled
# along at SCHED_IDLE holding the dnf lock, while the install that wanted the
# lock waited behind it -- so the box sat at 41 MB free with 1.4 GB in swap,
# achieving nothing. It was also the single largest process on the machine at
# 677 MB resident. Scheduled refresh buys nothing anyway: dnf refreshes on
# demand when something is installed.
systemctl disable --now dnf-makecache.timer >/dev/null 2>&1 || true
systemctl stop dnf-makecache.service >/dev/null 2>&1 || true
rm -rf /etc/systemd/system/dnf-makecache.service.d

# Ksplice keeps running -- it applies kernel security patches -- but yields.
# It does not take the dnf lock, so the inversion above does not apply to it.
mkdir -p /etc/systemd/system/ksplice-agent.service.d
cat > /etc/systemd/system/ksplice-agent.service.d/nice.conf <<'DROPIN'
[Service]
Nice=19
CPUSchedulingPolicy=idle
IOSchedulingClass=idle
DROPIN

# Disabling the PCP services left their check timers armed, firing every ~24
# minutes to restart what was just disabled.
systemctl disable --now \
  pmlogger_check.timer pmlogger_farm_check.timer pmlogger_daily.timer \
  pmie_check.timer pmie_farm_check.timer pmie_daily.timer >/dev/null 2>&1 || true

# --- packages ----------------------------------------------------------------
# Run the package manager at idle priority. This shape is 1/8 OCPU, and dnf
# loading repository metadata saturates it so completely that sshd stops being
# able to complete a handshake -- the box accepts TCP on 22 and then goes
# silent, which looks like a network fault and is not one. Nicing it costs
# nothing when nothing else wants the CPU, and keeps the machine reachable
# while a fifteen-minute install runs.
#
# The Ksplice repository is excluded from these calls for the same reason: 30 MB
# of metadata to parse, on a box that installs nothing from it. Ksplice itself
# keeps working -- it does not go through these transactions.
PKG="nice -n 19 ionice -c3"
NOKS="--disablerepo=ol9_ksplice"

say "packages"
if command -v dnf >/dev/null; then
  # Oracle Linux, which is what the micro shapes default to.
  $PKG dnf $NOKS install -y curl firewalld
  curl -fsSL https://rpm.nodesource.com/setup_20.x | $PKG bash -
  $PKG dnf $NOKS install -y nodejs
  $PKG dnf $NOKS install -y 'dnf-command(copr)' || true
  $PKG dnf $NOKS copr enable -y @caddy/caddy || true
  $PKG dnf $NOKS install -y caddy
else
  $PKG apt-get update -y
  $PKG apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https firewalld
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  $PKG apt-get install -y nodejs
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  $PKG apt-get update -y && $PKG apt-get install -y caddy
fi

# --- user and layout ---------------------------------------------------------
say "user and directories"
id -u cocine >/dev/null 2>&1 || useradd --system --home /opt/cocine --shell /usr/sbin/nologin cocine
mkdir -p /opt/cocine /etc/cocine /var/log/caddy
chown -R cocine:cocine /opt/cocine
# Caddy runs as its own user and writes the access log itself. Without this it
# starts, fails to open the log, and exits 1 -- leaving the server healthy on
# 127.0.0.1:8787 and nothing at all listening on 443.
id -u caddy >/dev/null 2>&1 && chown -R caddy:caddy /var/log/caddy || true

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
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:8787/health >/dev/null; then
  echo
  echo "  server is up locally."
  echo "  Next: point ${DOMAIN} at this instance's public IP, then check"
  echo "      curl https://${DOMAIN}/health"
  if [ -n "${RECLAIM_PENDING:-}" ]; then
    echo
    echo "  NOTE: 448 MB is still reserved for kdump on the running kernel."
    echo "        Reboot to get it back -- this box has 945 MB, not 498 MB."
  fi
  echo "  and build the desktop app with"
  echo "      COCINE_DEFAULT_SERVER=wss://${DOMAIN} npm run dist:linux"
else
  echo "  server did not answer. journalctl -u cocine-server -n 50" >&2
  exit 1
fi
