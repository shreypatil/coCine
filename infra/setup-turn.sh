#!/usr/bin/env bash
#
# coturn on the *second* Always Free instance.
#
#     sudo ./setup-turn.sh turn.cocine.example.com <shared-secret>
#
# On its own instance deliberately. A relayed call and the room's signalling
# would otherwise compete for one 1/8-OCPU box, and voice is the thing people
# notice first when it stutters. The second micro instance is free and idle.
#
# The shared secret must match COCINE_TURN_SECRET in /etc/cocine/server.env on
# the signalling box: the server mints credentials as an HMAC over an expiry
# under that secret, and coturn recomputes it. A mismatch is silent -- every
# relayed call simply fails to connect.
set -euo pipefail

DOMAIN="${1:-}"; SECRET="${2:-}"; SIGNALLING="${3:-}"
if [ -z "$DOMAIN" ] || [ -z "$SECRET" ]; then
  echo "usage: sudo $0 <turn-domain> <shared-secret> [signalling-domain]" >&2
  echo "  generate a secret with: openssl rand -hex 32" >&2
  echo "  the signalling domain is optional and only tells the keepalive where" >&2
  echo "  to ask whether anybody is watching a film." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v dnf >/dev/null; then dnf install -y coturn firewalld certbot
else apt-get update -y && apt-get install -y coturn firewalld certbot; fi

# The firewall comes before certbot, because the challenge needs port 80 open
# and Oracle Linux images ship rules that reject it. Note that this only opens
# the instance's own firewall -- the ports have to be open in Oracle's security
# list too, which is done in the console and is the step nothing here can do.
systemctl enable --now firewalld
firewall-cmd --permanent --add-port=80/tcp   >/dev/null  # certbot, now and at renewal
firewall-cmd --permanent --add-port=3478/udp >/dev/null
firewall-cmd --permanent --add-port=3478/tcp >/dev/null
firewall-cmd --permanent --add-port=443/tcp  >/dev/null
firewall-cmd --permanent --add-port=49160-49200/udp >/dev/null
firewall-cmd --reload >/dev/null

# Certificates for turns:// on 443. The same reason as the signalling server:
# a network that blocks UDP and odd ports usually still allows TLS on 443, and
# that listener is what saves a call on a corporate or hotel network.
certbot certonly --standalone -d "$DOMAIN" --agree-tos --register-unsafely-without-email -n || \
  echo "  certbot failed; turns:// on 443 will not work until it succeeds" >&2

# The denial lists and auth scheme come from the repository's config, which is
# tested: apps/server/test/turn-denials.test.ts reads that exact file and checks
# a relay cannot be pointed at loopback, private ranges, link-local, or the
# IPv4-mapped forms of any of them.
sed -e "s/^static-auth-secret=.*/static-auth-secret=${SECRET}/" \
    -e "s/^realm=.*/realm=${DOMAIN}/" \
    -e "s#^# cert=.*#cert=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem#" \
    -e "s#^# pkey=.*#pkey=/etc/letsencrypt/live/${DOMAIN}/privkey.pem#" \
    "$HERE/turnserver.conf" > /etc/coturn/turnserver.conf
chmod 640 /etc/coturn/turnserver.conf

# Renewal. certbot renews every ninety days and coturn goes on serving the
# certificate it read at startup, so calls on turns:// start failing three
# months after a setup that went perfectly -- long enough for nobody to connect
# the two. The hook restarts it; the pre-hook frees port 80, which coturn does
# not hold but Caddy would if this were ever run beside the server.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/cocine-coturn.sh <<'HOOK'
#!/bin/sh
systemctl is-active --quiet coturn && systemctl restart coturn
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/cocine-coturn.sh
systemctl enable --now certbot-renew.timer 2>/dev/null ||   systemctl enable --now certbot.timer 2>/dev/null || true

systemctl enable --now coturn
sleep 2
systemctl is-active --quiet coturn && echo "  coturn is running" || {
  echo "  coturn did not start. journalctl -u coturn -n 50" >&2; exit 1; }

# Reclamation applies to this instance as much as the other one, and it idles
# harder -- a relay does nothing at all unless somebody's call needs it. Point
# the keepalive at the signalling server's /health when we were told where that
# is, so it still stays out of the way during a film; without it, keepalive.sh
# finds nothing to ask and treats the box as idle, which here it is.
mkdir -p /opt/cocine/infra
install -m 755 "$HERE/keepalive.sh" /opt/cocine/infra/keepalive.sh
install -m 644 "$HERE/cocine-keepalive.service" /etc/systemd/system/
install -m 644 "$HERE/cocine-keepalive.timer" /etc/systemd/system/
if [ -n "$SIGNALLING" ]; then
  mkdir -p /etc/systemd/system/cocine-keepalive.service.d
  cat > /etc/systemd/system/cocine-keepalive.service.d/health.conf <<CONF
[Service]
Environment=COCINE_HEALTH_URL=https://${SIGNALLING}/health
CONF
fi
systemctl daemon-reload
systemctl enable --now cocine-keepalive.timer

cat <<NEXT

  Now on the signalling instance, in /etc/cocine/server.env:

      COCINE_TURN_URLS=turn:${DOMAIN}:3478,turns:${DOMAIN}:443
      COCINE_TURN_SECRET=${SECRET}

  then: sudo systemctl restart cocine-server

  Verify a credential is actually accepted rather than assuming:
      journalctl -u coturn -f
  should show "ALLOCATE processed, success" and not "401: Unauthorized" the
  first time somebody's call needs the relay.
NEXT
