# Putting the server up

How coCine's signalling server and its voice relay are deployed on Oracle Cloud's
Always Free tier, and why each piece is the way it is. Phase B2.

Everything here is scripted in [`infra/`](../infra). The steps below are what the
scripts do and what you have to do yourself, because two of the steps are outside
the instance and nothing running on it can do them for you.

---

## What you end up with

Two Always Free instances, both AMD micro shapes:

```
  instance 1 — signalling                    instance 2 — voice relay
  ┌───────────────────────────────┐          ┌──────────────────────────┐
  │ Caddy  :443  TLS              │          │ coturn                   │
  │   └── 127.0.0.1:8787          │          │   :3478 udp/tcp          │
  │         coCine server         │          │   :443   tls             │
  │         ├── websocket, rooms  │          │   :49160-49200 udp relay │
  │         ├── /announce tracker │          └──────────────────────────┘
  │         └── /health           │
  │ keepalive timer               │
  └───────────────────────────────┘
```

**Why two.** A relayed call and a room's signalling would otherwise share one
1/8-OCPU box, and voice is what people notice first when it stutters. The second
instance is free and would otherwise sit idle.

**Why Oracle at all**, and the measurements behind it, are in
[`phase-B-plan.md`](phase-B-plan.md#b2--a-publicly-reachable-server). The short
version: 10 TB of egress against Render's 5 GB, rooms that survive somebody
else's maintenance window, and UDP — so the relay can live on the same account
rather than on a third party's free tier.

---

## Before you start

- A domain you control, so you can point two names at two IPs.
- An Oracle Cloud account. A card is required for identity verification even
  though Always Free costs nothing.
- **Ask for the AMD micro shape (`VM.Standard.E2.1.Micro`), not Ampere.** The
  June 2026 halving of the ARM allowance and the notorious "out of host
  capacity" errors both apply to Ampere alone. The micros were untouched and
  provision immediately, and a 140 MB process has no use for 12 GB.

---

## 1. Create the instances

Two `VM.Standard.E2.1.Micro` instances, Oracle Linux, in your home region. Add
your SSH public key. Note both public IPs.

## 2. Open the ports — in the console, not on the box

This is the step nothing on the instance can do for you, and the one that makes
people think the software is broken. Oracle's **security lists** sit in front of
the instance's own firewall; a port has to be open in both.

In *Networking → Virtual Cloud Networks → your VCN → Security Lists → Default*,
add ingress rules:

| Instance | Source | Protocol | Port | For |
| --- | --- | --- | --- | --- |
| signalling | 0.0.0.0/0 | TCP | 80 | Let's Encrypt's HTTP challenge |
| signalling | 0.0.0.0/0 | TCP | 443 | everything the app does |
| relay | 0.0.0.0/0 | TCP | 80 | Let's Encrypt, at setup and at every renewal |
| relay | 0.0.0.0/0 | TCP | 3478 | TURN |
| relay | 0.0.0.0/0 | UDP | 3478 | TURN, the path that matters |
| relay | 0.0.0.0/0 | TCP | 443 | TURN over TLS, for networks that block UDP |
| relay | 0.0.0.0/0 | UDP | 49160–49200 | the relay's own port range |

`setup.sh` opens the instance-side firewall. It cannot touch the security list.

## 3. Point DNS at them

```
cocine.example.com      A   <signalling public IP>
turn.cocine.example.com A   <relay public IP>
```

Wait for them to resolve before running the setup, or Let's Encrypt's challenge
fails and you will be debugging the wrong thing.

## 4. Build the server and copy it over

Nothing is compiled on the instance. A 1 GB box has no business holding a
toolchain, and `npm ci` at the repository root would pull Electron onto it.

```bash
npm run build:server                       # -> dist/server.mjs, about 1.6 MB
scp dist/server.mjs opc@<signalling-ip>:/tmp/
scp -r infra opc@<signalling-ip>:/tmp/
```

The bundle carries everything except one dependency: `webrtc-polyfill`, which
the tracker needs and which pulls a native addon (`node-datachannel`) that
cannot be bundled. `setup.sh` installs it — about 12 MB, and the only
`node_modules` on the machine.

## 5. Run the setup

```bash
ssh opc@<signalling-ip>
sudo mv /tmp/server.mjs /opt/cocine/server.mjs   # setup.sh creates /opt/cocine
sudo /tmp/infra/setup.sh cocine.example.com
```

It installs Node and Caddy, creates the `cocine` user, writes
`/etc/cocine/server.env`, installs the systemd units, opens the local firewall,
and starts everything. It is written to be run twice — see *Rebuilding* below
for why that matters more than it usually does.

Check it:

```bash
curl https://cocine.example.com/health
# {"ok":true,"rooms":0,"members":0,"uptimeSec":12,"version":"2026-09-10"}
```

## 6. The voice relay

```bash
SECRET=$(openssl rand -hex 32)
ssh opc@<relay-ip>
sudo /tmp/infra/setup-turn.sh turn.cocine.example.com "$SECRET" cocine.example.com
```

The third argument is optional and only tells this instance's keepalive where to
ask whether a film is playing; see below.

Then on the signalling instance, in `/etc/cocine/server.env`:

```
COCINE_TURN_URLS=turn:turn.cocine.example.com:3478,turns:turn.cocine.example.com:443
COCINE_TURN_SECRET=<the same secret>
```

and `sudo systemctl restart cocine-server`.

**Both variables or neither.** Half a configuration is worse than none: the
server refuses to start a relay it cannot authenticate against, and says so,
rather than handing out credentials nothing will accept.

**Verify a credential is actually accepted**, rather than assuming it. This is a
recorded footgun: the coturn image used in testing ignored `use-auth-secret`
entirely and fell through to a user database, rejecting every minted credential
identically whether the digest was right or wrong.

```bash
journalctl -u coturn -f
```

The first call that needs the relay should log `ALLOCATE processed, success`.
`401: Unauthorized` means the secret does not match.

The script also installs a renewal hook. Certbot renews every ninety days and
coturn goes on serving the certificate it read at startup, so `turns://` calls
would begin failing three months after a setup that went perfectly — long enough
that nobody would connect the two events. The hook restarts coturn when the
certificate changes.

## 7. Point the app at it

```bash
COCINE_DEFAULT_SERVER=wss://cocine.example.com npm run dist:linux
```

The address is baked in at build time and is still editable in the app's
settings, so nobody is stuck with it.

---

## The keepalive, and why it exists

Oracle **terminates** — not stops — an Always Free instance it judges idle:

> CPU utilisation for the 95th percentile is less than 20%, **and** network
> utilisation is less than 20%, over a 7-day period.

coCine's server idles at 0.1% of a core. That is precisely the profile that gets
reclaimed, and there is no documented warning or grace period.

All the conditions must hold, so breaking one is enough — and the choice is not
close. Twenty per cent of the micro's 50 Mbps is about 750 GB a week. CPU is the
affordable one, and the *95th percentile* is what makes it cheap: clearing it
needs more than five per cent of samples above the threshold, roughly **8.4
hours a week**, not a week of load.

[`infra/keepalive.sh`](../infra/keepalive.sh) burns twelve minutes every two
hours — about fourteen hours a week, for margin — and does two things that stop
it being the crude cron everyone writes:

- `nice 19` and `CPUSchedulingPolicy=idle`, so the server preempts it instantly.
  This is a one-vCPU box; that is not automatic.
- **It asks `/health` first and skips entirely while anybody is connected.** A
  keepalive that ran during a film would be protecting the server by degrading
  it — and the idle stretches it waits for are the ones that accrue the risk
  anyway.

A server it cannot reach counts as idle, because an instance whose server is
down is the one that most needs protecting.

```bash
systemctl list-timers cocine-keepalive.timer
journalctl -u cocine-keepalive -n 20
```

Both instances get it, and the relay is the one that needs it more — it does
nothing at all unless somebody's call cannot connect directly. Given the
signalling domain as its third argument, `setup-turn.sh` points that instance's
keepalive at the same `/health`, so it stays quiet during a film as well.

---

## Rebuilding

Assume the box will go. Oracle halved the Ampere allowance in June 2026 with no
announcement of any kind, and reclamation carries no warning. The question is
not whether this needs rebuilding but how long it takes when it does.

Everything that makes this instance what it is lives in the repository. To
rebuild: create an instance, repeat steps 2 to 5, and put back the one thing
that is not in git — `/etc/cocine/server.env`, which holds the TURN secret and
any storage credentials. **Keep a copy of that file somewhere you will still
have it.**

Nothing else is state. Rooms are in memory and are meant to be: they last an
evening, and a server restart ends them, which is why the client reconnects by
room code and why `RoomStore` sits behind an interface should that ever need to
change.

---

## When something is wrong

**Chat works but the film never transfers.** Almost always `COCINE_PUBLIC_HOST`.
The server derives the tracker address from the `Host` header, which behind a
terminating proxy gives clients `ws://` on the wrong port. Everything else keeps
working, which is what makes it confusing — `multi-machine-testing.md` calls it
the single most misleading symptom there is.

```bash
grep COCINE_PUBLIC_HOST /etc/cocine/server.env   # wss://, not ws://
```

**Nothing reaches the server at all.** The security list and the instance
firewall are two separate gates and both have to be open. Check the console
first; it is the one `setup.sh` cannot do.

**Voice fails only for some people.** That is what a relay is for. Confirm the
server is handing out credentials (`COCINE_TURN_*` set, server restarted since),
then watch `journalctl -u coturn -f` during a call.

**The instance vanished.** Reclamation. Check the keepalive was running —
`journalctl -u cocine-keepalive` — and rebuild.

```bash
systemctl status cocine-server
journalctl -u cocine-server -n 100
curl -s localhost:8787/health
```
