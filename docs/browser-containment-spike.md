# Browser containment spike: headless Chromium inside the default-deny netns

Status: **spike, throwaway**. This is the Chromium half of forge test B (plan §5.2
finding 34), the U0.4 kernel rules with a real browser inside them. It proves one thing on
this Mac (arm64, Docker Desktop engine 28.3.2). A headless Chromium inside the
default-deny netns reaches the outside world **only** through the egress proxy, gets there
**only** with the proxy flags set. Every attempt without them dies at the kernel, including
an in-page JavaScript fetch of a DoH endpoint or an IP literal, a navigation to a public
URL or an IP literal, and a forced-QUIC navigation. The receipts are netfilter counters and
a browser-rendered denial page.

The kernel half is U0.4's, unchanged. `spikes/browser-containment/entrypoint.sh` is a copy
of `spikes/containment/entrypoint.sh`, and it applies the same ruleset (policy drop on the
output hook, embedded-DNS drop, loopback accept, one accepted proxy destination, all UDP
dropped). Read [`docs/containment-spike.md`](containment-spike.md) for why each rule is
there. This document covers only the browser.

Artifact: `packages/verify/artifacts/containment-browser/<short-sha>/probes.txt` plus four
PNG screenshots in the same directory, produced by `bash spikes/browser-containment/run.sh`
at that commit.

## What runs

`run.sh` (host) starts the throwaway proxy (`proxy.ts` is a copy of U0.4's, noted in the
file header) and a page server of our own (`origin.ts`), then one `docker run` with
`--cap-add=NET_ADMIN --cap-drop=NET_RAW`, no `--privileged`, no host networking. Inside,
`entrypoint.sh` applies the ruleset and `browser-probes.sh` drives seven Chromium arms.
Screenshots are written straight into the artifact directory through a volume mount, so
the PNGs and the probes text are the same run's. The harness fails closed at every level. A
missing probe line, a missing screenshot, a missing proxy dial, or a container killed mid-run
all produce `RESULT: FAIL` and a non-zero exit, which is how a mid-development run ended when
another unit's cleanup killed every container on this shared Docker engine.

Two measurement details carry most of the weight.

- **Port buckets.** Three counter-only nft rules are inserted ahead of the drop rule
  (`udp dport 443`, `udp dport 53`, other UDP). Counter-only means no verdict. Packets fall
  through to the policy exactly as before, but every arm can now say *which* UDP it emitted.
  The whole-UDP counter cannot. The first run of this probe used it, read `+96` in the
  `--disable-quic` arm, and failed the probe. The packets were DNS (udp/53), the browser's
  own updater traffic during the arm's 136-second denied TCP fallback, not QUIC. That
  attribution is what the bucket split now keeps visible in every row.
- **Real-process checks.** A sampler reads `/proc/<pid>/cmdline` of the lowest-pid
  `/usr/lib/chromium/chromium` process every 50 ms while an arm runs. Debian's
  `/usr/bin/chromium` is a wrapper that execs this binary, so "the flag was passed" and
  "the flag reached the real process" are different claims. A quiescence gate also waits
  for a previous arm's processes to disappear before the next arm starts, and the count is
  reported, so a leaked process cannot have its retries counted against a later arm.

## The flags a contained browser needs, and which are proven

| Flag | Necessary for | How it is known |
| --- | --- | --- |
| `--proxy-server` | Browsing at all | p1 and p2 render a public page and the host-served origin through the proxy, with the proxy's dial lines in the log. p3 and p4 run the public-URL and IP-literal navigations with `--no-proxy-server` and produce no page content. |
| `--disable-quic` | Removing the browser's QUIC attempt | p6 reads the udp/443 bucket. With QUIC allowed, the forced navigation emits 3 datagrams (1278 bytes each, QUIC Initials) that the policy drops and the netlog records 5 × `ERR_QUIC_HANDSHAKE_FAILED` (-358). With the flag, the identical navigation emits **0** datagrams to udp/443 and the netlog holds no QUIC error. The flag's presence is confirmed in the real process cmdline, not the wrapper argv. |
| `--host-resolver-rules="MAP * ~NOTFOUND"` | Answering every resolution (names and IP literals) locally before any socket opens | p7 runs the same in-page attempt set as p5 with the guard on. Still denied, but zero packets at all (all three buckets +0) against p5's counters with the guard off. |
| `--proxy-bypass-list=<-loopback>` | The p2 control | Chromium implicitly bypasses the proxy for loopback, so without this override a proxy-local page cannot load through the proxy at all. |
| `EXCLUDE <proxy host>` inside the resolver rules | The combination | `MAP * ~NOTFOUND` alone also answers the browser's lookup of the *proxy's own name* with NOTFOUND and nothing loads. `EXCLUDE` carves the proxy back out. Observed during development, then fixed. The final flag set has it. |
| `--no-sandbox` | Container reality | Chromium refuses to start as root without it ("No usable sandbox!" without the setuid helper), and this container's process is root. It does not touch egress, because the containment under test is the netns ruleset. A production sandbox image runs the browser as a non-root user with the Chromium sandbox on. |

## Probes

Run at 27cf9dee665547356177d8c0ce3d39b2c8f623b9 (2026-10-17T07:23:52Z, Docker engine 28.3.2,
Chromium 155.0.8059.79, arm64). Every row below is copied from `probes.txt` for that run.

| id | attempt | how it is driven | observed |
| --- | --- | --- | --- |
| p1 | Load `https://example.com` through the proxy (the working control) | Chromium with `--proxy-server`, the resolver guard with the proxy `EXCLUDE`, `--disable-quic`, and the loopback bypass removal | Rendered in 671 ms, the DOM carries the page marker, screenshot 68,132 bytes, and the arm emitted zero UDP |
| p2 | Load the page we serve on the host at `http://localhost:9109/host-origin`, through the proxy | Same flags | Rendered in 325 ms, screenshot 30,240 bytes, zero UDP, and the host proxy log shows the `localhost:9109` dials |
| p3 | Navigate to `https://example.com` with `--no-proxy-server` | Adversarial navigation | Denied in 212 ms, empty DOM, no capture written, 63 datagrams to udp/53 (its own resolver attempts) counted and dropped, netlog 69 × `net::ERR_ACCESS_DENIED` (-10) |
| p4 | Navigate to `https://1.1.1.1/` with `--no-proxy-server` | Adversarial navigation with no DNS step | Denied after 136,343 ms (the TCP blackhole holds until Linux gives up), empty DOM, no capture, 174 datagrams to udp/53 and **0** to udp/443, and no QUIC error in the netlog |
| p5 | In-page JavaScript runs five attempts from `file://` with `--no-proxy-server`: DoH fetch to `https://1.1.1.1/dns-query`, DoH fetch to `https://dns.google/dns-query`, fetch of `https://1.1.1.1/`, fetch of `https://example.com/`, image load from `https://1.1.1.1/favicon.ico` | The page records each attempt as a row plus a verdict banner, and the row values are read back from that rendered DOM | All five DENIED. The hostname attempts fail in 10 ms, the IP-literal attempts at 134.9 s. 192 datagrams to udp/53, zero elsewhere. Screenshot 92,808 bytes |
| p6 | Force QUIC (`--origin-to-force-quic-on=1.1.1.1:443`) on the `https://1.1.1.1/` navigation, twice, without then with `--disable-quic` | The udp/443 bucket, a `/proc` cmdline sampler during the arm, and a process-quiescence gate between the arms | Without the flag: 3 datagrams to udp/443 (1,278 bytes each, the bucket's byte counter reads 3,834) inside 204 ms, the netlog records `ERR_QUIC_HANDSHAKE_FAILED` (-358) ×5, nothing rendered, and the sampled real-process cmdline lacks the flag (4 samples). With the flag: 0 datagrams to udp/443, no QUIC error, nothing rendered, and the flag is in the sampled cmdline (2,108 of 2,109 samples, and the network-service cmdline carries it once). The gate saw 0 processes before each arm. The 96 datagrams to udp/53 in the second arm are the browser's own lookups during the 134,771 ms denied fallback, attributed by the bucket rather than read as QUIC |
| p7 | The p5 page again, with `--host-resolver-rules="MAP * ~NOTFOUND"` | Resolver guard arm | Still contained, every attempt denied in 3 ms, and zero packets in all three buckets and in the whole-UDP counter. Screenshot 87,184 bytes |

The run's final counters are consistent with the rows. The udp/443 bucket reads 3 packets
(3,834 bytes), the udp/53 bucket 567 (38,010 bytes), the other-UDP bucket 0, and the UDP drop
rule 570 packets (41,844 bytes). The buckets partition the drop exactly (3 + 567 + 0 = 570), so
no datagram escaped the accounting. The accepted-proxy rule carried 193 TCP packets (50,636
bytes), and the loopback and embedded-DNS rules read 0.

## What the kernel counters prove, and what remains reasoning

The counters are read inside the same netns the browser runs in, at the output hook, before the
device queue. A datagram counted there was dropped by these rules, and that is the only place a
dropped packet stays observable.

Proven by the counters:

1. The proxy is the only egress that works. The accepted-proxy rule is the only accept path
   that fires, both controls rendered through it (DOM marker, screenshot, and the host-side dial
   log agree), and every adversarial arm's attempts landed on the drop rules instead.
2. The UDP denial is a kernel decision, and the buckets partition it exactly (3 + 567 + 0 =
   570 against the drop rule's own count). Nothing on UDP left unaccounted.
3. The `--disable-quic` claim is measured, not asserted. Forced QUIC emitted 3 datagrams
   (1,278 bytes each) and failed the handshake inside the browser's own log; the same navigation
   with the flag emitted zero and logged no QUIC error. The flag's presence in the real process
   and the quiescence gate between arms exclude the two ways this reading could be wrong (a flag
   that never reached the process, or a previous arm's processes still retrying).
4. The resolver guard changes where the denial happens, not whether. With it, the same five
   in-page attempts fail in 3 ms and emit nothing at all. Without it, names fail at 10 ms and IP
   literals hold the connection open until Linux's SYN retries run out at 134.9 s.

Reasoning, not mechanics the counters can show:

- Hook completeness. These rules live at netfilter's output hook, and a path that bypasses the
  hook is outside what any counter here could see. The spike inherits U0.4's argument about
  that. It adds a browser, not a new proof about the hook.
- Flag completeness. The plan's three flags plus the two this container needs were exercised. A
  different Chromium configuration could still open a path these arms do not touch (WebRTC,
  WebSocket, or proxy settings injected by policy JSON, none of which is used here).
- The 133 to 136 second durations are Linux's SYN retry schedule on this host, not part of the
  denial claim.
- The denial page is our own. Headless Chromium writes no capture for a failed navigation, so
  the browser's own error page could not be photographed.

## What this does not prove

- **The proxy's policy.** It still has no allowlist and no auth, and it dials any host it
  can reach. "Proxy-only egress" means "anywhere this proxy is willing to dial". The proxy
  log in the artifact shows it dialing Chromium's own updater hosts unprompted. The
  production proxy's allowlist is later work (U0.4 documents the same limit).
- **The browser's own background traffic shares the netns.** Chromium dials Google updater
  endpoints by itself. Through the proxy those succeed, and without it they die with
  everything else. Per-arm buckets and the fail-closed assertions keep that noise from
  flattering a denial, but it is part of the measured system.
- **Other engines, other builds.** One Mac, one Docker Desktop engine (28.3.2), one
  Chromium (Debian bookworm's, 155.0.8059.79). The `127.0.0.11` embedded-DNS rule reads 0
  packets here (this engine's resolver is 192.168.65.7), exactly as U0.4 found.
- **WebRTC and WebSockets** were not exercised. Their UDP and TCP paths fall under the same
  rules, but that sentence is reasoning, not a probe result.
- **IPv6.** This engine gives the container only `::1`, so no IPv6 egress exists to deny.
- **The denial screenshots are our own rendered page.** A failed navigation writes no
  capture at all in headless mode, so Chromium's own error page cannot be screenshotted.
  The receipt is the probe page rendering its JavaScript verdicts. The `--no-sandbox`
  caveat above applies to every arm.
- **Body bytes of a denial.** "No page content" is an empty DOM and a missing capture. It is
  not proof that zero bytes crossed the netns interior, where the local origin and the
  proxy are both reachable by design.

## Files and how to re-run

```
spikes/browser-containment/Dockerfile         arm64 bookworm-slim + chromium nftables curl dnsutils python3 fonts
spikes/browser-containment/entrypoint.sh      copy of the U0.4 default-deny ruleset entrypoint
spikes/browser-containment/browser-probes.sh  the seven Chromium arms, buckets, gate, sampler
spikes/browser-containment/probe-page.html    the in-page denial probe (DoH, IP literal, host, image)
spikes/browser-containment/proxy.ts           copy of the U0.4 throwaway proxy (noted in its header)
spikes/browser-containment/origin.ts          the host-side page server for the through-proxy control
spikes/browser-containment/run.sh             the one command: build, proxy, origin, container, artifact
spikes/browser-containment/tsconfig.json      typechecks the two TS files
```

```sh
bash spikes/browser-containment/run.sh     # ~8 minutes, writes packages/verify/artifacts/containment-browser/<short-sha>/
```

## Follow-ups (later units)

1. The production sandbox image runs the flags above with a non-root browser user and the
   Chromium sandbox on, and fails closed when the ruleset cannot be applied. The entrypoint
   already exits non-zero in that case.
2. The production egress proxy needs its allowlist, auth, and audit log (U0.4's follow-up
   1). The browser arm's proxy log here shows why the allowlist is not optional.
3. Add WebRTC and WebSocket attempts and an IPv6 probe once an address exists to deny.
4. Forge test B is now assembled from both halves (U0.4 script-level, this browser-level)
   with a ledger row pinned to the commit each artifact was produced at.
