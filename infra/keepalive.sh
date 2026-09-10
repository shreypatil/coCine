#!/usr/bin/env bash
#
# Stop Oracle reclaiming the instance for looking idle.
#
# Oracle's always-free tier terminates — not stops, terminates — an instance it
# judges idle, and the published test is:
#
#     CPU utilisation for the 95th percentile is less than 20%
#     AND network utilisation is less than 20%
#     (AND memory under 20%, on Ampere shapes only)
#
# All of them must be true, so breaking any one is enough. Network is not the
# one to break: twenty per cent of the micro shape's 50 Mbps is about 750 GB a
# week, which is neither honest nor affordable. CPU is, and the *95th
# percentile* is what makes it cheap — clearing it needs more than five per cent
# of samples above twenty per cent, which is around 8.4 hours a week, not a week
# of load.
#
# So this burns CPU for a bounded stretch, several times a day, and does it
# without getting in the way:
#
#   - `nice 19`, so coCine preempts it instantly on a one-vCPU box.
#   - It asks the server whether anybody is watching a film first, and skips if
#     they are. A keepalive that ran during a film would be protecting the
#     server by degrading it — and the idle stretches it skips in favour of are
#     exactly the ones that accrue the reclamation risk anyway.
#
# Run from a systemd timer; see infra/cocine-keepalive.{service,timer}.
set -euo pipefail

# How long to burn for, per run. With the timer at every 2 hours this is 12
# runs a day at 12 minutes — 14 hours a week, comfortably past the 8.4 needed.
BURN_SECONDS="${COCINE_KEEPALIVE_SECONDS:-720}"
HEALTH_URL="${COCINE_HEALTH_URL:-http://127.0.0.1:8787/health}"

log () { echo "[keepalive] $*"; }

# --- is anybody watching? ----------------------------------------------------
# A failure to ask is not a reason to skip: if the server is down, the instance
# is idle by definition and is exactly what needs protecting.
members=0
if body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null); then
  members=$(printf '%s' "$body" | sed -n 's/.*"members":[[:space:]]*\([0-9]*\).*/\1/p')
  members=${members:-0}
else
  log "no answer from $HEALTH_URL; treating the server as idle"
fi

if [ "$members" -gt 0 ]; then
  log "$members member(s) connected — staying out of the way"
  exit 0
fi

# --- burn ---------------------------------------------------------------------
# One busy loop in the shell itself: no dependency to install, and `nice` plus a
# hard deadline is the whole safety story. `timeout` sends TERM at the deadline
# and KILL shortly after, so a wedged loop cannot outlive the run — which
# matters more than it sounds, because this runs unattended for years.
log "idle; burning ${BURN_SECONDS}s of CPU at nice 19"
timeout --kill-after=10s "${BURN_SECONDS}s" \
  nice -n 19 bash -c 'while :; do :; done' || true
log "done"
