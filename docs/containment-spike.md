# Containment spike: default-deny egress with a proxy-only path

Status: **spike, throwaway**. Not production. This proves one thing on this Mac (arm64,
Docker Desktop, engine 28.3.2) and records exactly how: a container's network namespace can be
made default-deny at the kernel level, with a single HTTP proxy as its only egress path, so DNS,
raw TCP, IP literals, UDP (including the QUIC port), and DoH all stop at the kernel.

It exists because finding 34 in `freebot-plan.md` section 5.2 is a blocker for Phase 2: an HTTP
proxy is bypassed by QUIC/HTTP-3, WebRTC, DoH, and by anything that resolves a name the proxy
never sees. The plan's answer is kernel-level default deny in the sandbox netns, with the proxy
as the only route out and the proxy doing its own DNS. This unit is the kernel half; the Chromium
half (`--proxy-server`, `--host-resolver-rules`, `--disable-quic`) belongs to a later unit and is
not covered here.

Artifact: `packages/verify/artifacts/containment/57a229d/probes.txt` (7/7 probes PASS, produced by
`bash spikes/containment/run.sh` at commit `57a229d`).

## How the container is contained

`spikes/containment/entrypoint.sh` writes one nftables table inside the container's own network
namespace before the container command runs:

```nft
table inet freebot_containment {
  chain output {
    type filter hook output priority filter; policy drop;

    ip daddr 127.0.0.11 counter drop comment "docker embedded dns"
    oifname "lo" counter accept comment "loopback"
    ip daddr $proxy_ip tcp dport $proxy_port ct state new,established,related counter accept comment "egress proxy only"
    meta l4proto udp counter drop comment "all udp including quic"
  }
}
```

Why each line:

- `policy drop` on the output hook is the whole guarantee. Anything not matched by a later rule
  never leaves the namespace, including traffic to the Docker gateway, the VM's outer networks,
  and any protocol not named in a rule.
- The embedded-DNS drop comes first on purpose: reply packets are `ct state established`, so a
  generic established rule placed earlier would have reopened DNS.
- `oifname "lo"` keeps loopback working (the container's own services) and nothing else.
- Exactly one destination is allowed: the proxy's IP and TCP port. The IP is read from
  `/etc/hosts` (`--add-host=host.docker.internal:host-gateway`), never from DNS.
- All UDP is dropped explicitly. That is what closes QUIC/HTTP-3, plain DNS, and every other
  UDP-based escape at once. With the policy drop, UDP would be dropped anyway; the explicit rule
  is what makes the guarantee greppable in a counter.
- No proxy environment variables are set anywhere in the image or the `docker run`. Proxied
  requests name the proxy with `curl -x`. `probes.sh` asserts that all nine `*_proxy` names are
  unset before it probes, so a PASS cannot come from environment redirection.

The proxy (`spikes/containment/proxy.ts`) is a minimal bun forward proxy: absolute-form GET plus
CONNECT, one request per connection, TLS is tunneled and never terminated. It resolves hostnames
itself with `dns.lookup` (IPv4 first) and pipes both sockets with `setNoDelay(true)`. The artifact
includes its host-side log, which shows the resolution the container cannot do:
`proxy dial example.com:443 -> 172.66.147.243:443 (family 4)`.

## Capabilities required

| Flag | Needed? | Evidence |
| --- | --- | --- |
| `--cap-add=NET_ADMIN` | **Yes** | Without it the entrypoint fails: `netlink: Error: cache initialization failed: Operation not permitted`, and a one-rule `nft add table inet t` fails with `Error: Could not process rule: Operation not permitted` on an unmodified `debian:bookworm-slim`. |
| `--cap-drop=NET_RAW` | Safe to drop | `NET_RAW` is in Docker's default set. The full run passes with it dropped (effective set in the artifact: no `NET_RAW`), and nothing in the spike needs raw sockets: `dig`, `nc -z`, and `curl` use ordinary sockets. |
| `--privileged` | **No** | All runs above used `--cap-add=NET_ADMIN --cap-drop=NET_RAW` only. |

So the smallest set this spike needed is exactly `NET_ADMIN` added to Docker's defaults, with
`NET_RAW` removed. Note that nftables requires this capability *inside* the container's user
namespace; the rules live in the container's netns and never in the VM's host netns.

## Probes

`spikes/containment/probes.sh` runs inside the container after the policy is applied. Each probe
prints one `PROBE(<id>) PASS|FAIL` line with the observed evidence; the run fails if any probe
fails. Results at `57a229d`:

| # | What it attempts | Why it should fail | Observed at 57a229d |
| --- | --- | --- | --- |
| a | `curl https://example.com` with no proxy | default deny | `PASS` — curl exit 6 after 4 ms, `Could not resolve host: example.com` |
| b | `curl -x http://host.docker.internal:8788 https://example.com` | this must succeed, or (a) proves nothing | `PASS` — HTTP 200 after 188 ms through the proxy |
| c | `dig +short example.com`, `nslookup example.com`, `dig +tcp example.com` | resolver unreachable over UDP and TCP | `PASS` — dig exit 9 after 3035 ms (`communications error to 192.168.65.7#53: timed out`), nslookup exit 124, dig +tcp exit 9 |
| d | `nc -z 1.1.1.1 443` | raw TCP to a public IP | `PASS` — exit 1 after 4009 ms, connect timed out |
| e | `dig @8.8.8.8 example.com`, two 1200-byte and 64-byte datagrams to `1.1.1.1:443` (QUIC port) | UDP, including QUIC | `PASS` — dig exit 9 after 3045 ms; both `sendto` calls returned `errno 1 EPERM`; no reply in 3 s; the UDP rule counter advanced by exactly 2 packets for the datagrams (+3 for the probe) |
| f | `curl --doh-url https://1.1.1.1/dns-query https://example.com` and a direct `application/dns-message` GET to `https://1.1.1.1/dns-query` | DoH to an IP literal | `PASS` — exit 28 (resolving timed out / connect timeout) for both |
| g | `curl -k https://1.1.1.1/` | https to a bare IP literal | `PASS` — exit 28, connect timed out after 4007 ms |

Notes on reading the evidence:

- Probe (a) fails at **name resolution**, not at TCP. If an attacker knew an IP, (a) would not
  stop them; (d) and (g) are the probes that deny the TCP path itself.
- Probe (e)'s `EPERM` is not a missing capability. Linux surfaces a netfilter drop on a locally
  generated datagram as `EPERM` from `sendto`, and the rule's packet counter confirms the
  datagram reached the ruleset: two datagrams sent, counter +2. An earlier variant that counted
  only "no reply" was rejected as evidence, because UDP has no delivery feedback at all and a
  dropped packet is indistinguishable from an ignored one.
- Probe (c)'s resolver is **192.168.65.7**, which is what this Docker Desktop engine writes into
  `/etc/resolv.conf`. The `127.0.0.11` rule therefore reads 0 packets on this engine; the UDP
  drop is what actually denies DNS here. The rule stays because other engines and network modes
  do use the embedded resolver, and the artifact prints the resolver address and the counter so
  the difference is visible rather than assumed.
- DNS over TCP is covered by the policy drop, not by the UDP rule; `dig +tcp` in probe (c) is
  what demonstrates that.

## Overhead

Method: a 2-byte origin served by `Bun.serve` on loopback, then 50 sequential GETs sent over raw
sockets with `connection: close` on both arms, so the only difference between the arms is the
proxy hop. `spikes/containment/overhead.ts`; numbers in the artifact.

At `57a229d`: direct `n=50 p50=0.28ms p95=0.54ms`; proxied `n=50 p50=0.72ms p95=2.20ms`;
**overhead p50 +0.44 ms, p95 +1.66 ms**.

These are **spike measurements, not the production budget**. Repeated runs gave p50 overhead between
+0.27 ms and +0.44 ms and p95 between +0.66 ms and +2.59 ms. The spread is scheduler jitter on 50
loopback samples, not a property of the proxy, and loopback with a 2-byte body is the cheapest
case that exists: it measures added hop latency, not the throughput or connection-reuse behavior
a real workload would see. A production budget needs a realistic origin, connection reuse, and
many more samples.

## What this does not prove

- **Browser egress.** No Chromium ran here. A browser can bypass proxy settings in ways curl
  cannot (QUIC, DoH, WebRTC, its own DNS stack). The kernel rules in this spike would still drop
  those packets, but the end-to-end claim with the browser flags (`--proxy-server`,
  `--host-resolver-rules`, `--disable-quic`) is a later unit's job, as is forge test B.
- **Anything about the host or the VM.** These rules live in the container's netns. They say
  nothing about what the Docker VM's own host namespace, the daemon, or another container can
  reach, and nothing about a container that is given more capabilities or `--network host`.
- **An in-VM agent that does not need the network.** Containment is not isolation: a compromised
  agent can still write files, spawn processes, and exfiltrate through the proxy to any host the
  proxy will reach. The throwaway proxy has no allowlist, no auth, and tunnels any CONNECT, so
  "the proxy is the only path out" currently means "any host the proxy can reach is reachable
  through it". The production proxy needs an allowlist, auth, and its own policy; that work is
  later.
- **IPv6.** This engine gives the container only `::1` (checked `/proc/net/if_inet6`), so no IPv6
  egress could be exercised. The policy drop would deny it if an address ever appeared, but that
  sentence is reasoning, not a probe result.
- **Host-side measurement of the proxy under load.** The overhead numbers come from 50 requests
  with one client, sequentially, on loopback.

## Files and how to re-run

```
spikes/containment/Dockerfile      arm64 bookworm-slim + nftables curl dnsutils python3 netcat-openbsd
spikes/containment/entrypoint.sh   applies the default-deny ruleset, prints capabilities + ruleset
spikes/containment/probes.sh       the seven probes, PASS/FAIL with evidence
spikes/containment/proxy.ts        throwaway CONNECT + absolute-form GET proxy, own DNS, unbuffered
spikes/containment/overhead.ts     50 sequential GETs direct vs through the proxy
spikes/containment/run.sh          the one command: build, proxy, probes, overhead, artifact
spikes/containment/tsconfig.json   typechecks the two TS files (the root `bun run typecheck` does not include spikes/)
```

```sh
bash spikes/containment/run.sh            # writes packages/verify/artifacts/containment/<short-sha>/probes.txt
CONTAINMENT_PROXY_PORT=8899 bash spikes/containment/run.sh   # if the default port is busy
```

`run.sh` refuses to run when the proxy port is already in use and requires this run's own proxy to
be alive with its bind line logged. That guard is not decoration: during development a stale proxy
from an earlier manual test answered the health check while the run's own proxy had failed to bind,
which would have credited a passing probe to the wrong process.

## Follow-ups (later units)

1. Production egress proxy: allowlist, auth, audit log, and its own DNS policy; this one is a
   spiked socket, not the product.
2. Chromium containment: `--proxy-server`, `--host-resolver-rules`, `--disable-quic`, plus a
   browser-egress probe set; then forge test B end to end.
3. The production sandbox image must apply these rules as its own startup step, with the proxy
   address injected by the sandbox provider rather than baked in, and must fail closed when the
   ruleset cannot be applied (the entrypoint already exits non-zero in that case).
4. IPv6: probe it once a scenario exists with a global IPv6 address.
