# Localhost auth for the control plane

Plan §2.5 (Hono + oRPC on Bun) and Part 6 Phase 1 ("localhost auth: per-launch token + Origin/Host
allowlist"). The threat this answers is plan Part 13's item 14: a control plane on loopback that any
page in the operator's browser, or any process that can make the browser resolve a hostname to
127.0.0.1, could drive without a credential.

## The threat model

| Actor | Reaches the port? | What stops it |
| --- | --- | --- |
| A remote host on the network | No | The listener binds `127.0.0.1`; nothing else is addressable. Proved by the artifact's `lsof` line and a LAN-address probe. |
| Another local process (any user's) | Yes, by design | It is the operator's machine and there is no user separation in local mode. Such a process can read the printed token anyway. Documented as out of scope below. |
| A page on a foreign origin in the operator's browser | Yes | `Origin` check, then the token. A browser cannot forge `Origin`, and cannot read the response cross-origin regardless. |
| A page on a loopback origin (any port) | Yes | The token. Loopback origins are allowlisted because the web app is one of them; the token is what distinguishes a page that was handed the token from one that was not. |
| DNS rebinding: an attacker hostname resolves to 127.0.0.1 | The socket, yes | `Host` check on both legs. The rebound request arrives with the attacker's hostname in `Host`, which is refused before any credential is compared. The tunnel leg allows loopback plus `host.docker.internal`, since its HTTP reads are how the in-sandbox agent sees the log. |
| A WebSocket upgrade from a foreign page | Yes (WebSockets escape CORS) | `Origin` check at upgrade time on both listeners, plus the token on the API leg. |

## The checks, in order

`apps/server/src/auth.ts` holds them; `apps/server/src/api-server.ts` runs them before any handler.

1. **`Host` must be an allowed hostname** (`127.0.0.1`, `localhost`, `::1`, with or without a port;
   the tunnel leg adds `host.docker.internal`). A missing `Host` is refused too. Refusal: **403
   `host_not_allowed`**. This runs first so a rebound request is refused without its bearer token
   being compared against anything.
2. **A present `Origin` must be a loopback http(s) origin.** `http://127.0.0.1:<port>`,
   `http://localhost:<port>`, and their https forms pass; anything else, including `null`, `file:`,
   and `chrome-extension:`, is **403 `origin_not_allowed`**.
   An **absent** `Origin` passes. Non-browser clients (curl, the operator CLI, the in-process test
   client, the Electron main process) send none, and a browser cannot reach a cross-origin state
   without sending one. The two vectors an absent `Origin` could hide are covered elsewhere: a
   rebinding attack fails the `Host` check, and a same-origin page still needs the token.
3. **The bearer token must match the one this launch minted.** Missing: **401 `token_missing`**.
   Present but wrong: **401 `token_mismatch`**. Both digests are compared with
   `crypto.timingSafeEqual` over SHA-256 digests, so a wrong guess of the wrong length costs what a
   wrong guess of the right length costs.

`GET /healthz` runs check 1 only. It answers a liveness question with two constant fields and no
state, and the launcher's first question about the server is whether it is up.

The tunnel leg runs the same order on its HTTP reads (`/events`, `/audit`, `/healthz`) with
`TUNNEL_HOSTNAMES`, and check 2 on its two WebSocket upgrades. It runs no token check, for the reason
given under "Two listeners, two gates".

Refusals answer `{"error":{"code":...,"message":...}}` with that status. Each refusal also logs one
line to stdout, `[auth] refused code=... method=... path=...`, which never carries the token or any
header value.

## The token lifecycle

- **Minted** at boot by `mintToken()`: 32 bytes from `crypto.randomBytes`, base64url, 43 characters.
  `apps/server/src/index.ts` prints it once as `operator token: <value>` and never again.
- **Not stored.** No file, no environment variable, no repo, no log line, no artifact. The evidence
  script asserts the token appears exactly once in the server's whole output, that no `[auth]` line
  carries it, and refuses to write an artifact containing it.
- **Accepted** as `Authorization: Bearer <token>` on `POST /rpc`, and as `?token=` on the
  `ws://…/rpc-ws` upgrade, because a browser cannot set headers on a WebSocket. The query is read
  only on that path.
- **Replaced** every launch: the process mints a new one, so a token from a previous run is refused.
- **Injected**, when a launcher already holds one: `startApiServer({ token })`. A launcher that
  injects a token does not print it. This is the seam the Electron preload uses to hand the token to
  the web session (plan Part 13 item 14); the web app's side of it is not built yet.

## Two listeners, two gates

`apps/server/src/index.ts` starts both:

- The **tunnel leg** (`tunnel.ts`, `PORT`): the agent leg at `/tunnel`, the display leg at `/stream`,
  `/events`, `/audit`, `/healthz`. The in-sandbox agent reaches it as `host.docker.internal` through
  the TCP relay, so its `Host` check allows `host.docker.internal` besides loopback
  (`TUNNEL_HOSTNAMES` in `auth.ts`) and a strict loopback set would break the agent. Its two
  WebSocket upgrades carry the `Origin` check, because WebSockets escape CORS and a foreign page
  could otherwise read the log. Its HTTP reads carry the `Host` check with that allowance, because a
  rebound page's `fetch` to its own hostname is same-origin: it sends no `Origin` and CORS does not
  apply, so `Host` is the only control that covers those reads.
- The **API leg** (`api-server.ts`, `API_PORT`): `POST /rpc`, `ws://…/rpc-ws`, `/healthz`. The full
  gate. The agent never holds the operator token, so the sandbox cannot drive the operator's API.

The tunnel leg carries **no token**, by design: the sandbox must not hold the operator's token, and
what `/events` and `/audit` serve is the seq log its own frames fill, so a token there would be a
credential protecting the caller's own data. That is affordable now because the two ways a different
actor could reach those reads are both closed: a foreign-origin page is refused by CORS (no
`Access-Control-Allow-Origin` header is sent, so it cannot read the response), and a rebound page is
refused by the `Host` check. What is left open is a process already running on this machine, which
the "deliberately not covered" list below covers.

## What is deliberately not covered yet

- **No TLS.** Loopback only, so traffic does not leave the machine; a local attacker sniffing
  loopback is out of scope for local mode.
- **No multi-user, no accounts, no sessions.** One operator, one machine, one token. Plan §2.5's
  Better Auth or Lucia layer is the hosted-mode answer and is not in this unit.
- **No protection against another local process.** A process running as the operator can read the
  printed token and the operator's memory. Local mode assumes the machine's own processes are
  trusted; the sandbox exists to make that not matter for untrusted code.
- **No revocation, rotation, or expiry.** The token dies with the process. Rotation arrives with the
  hosted mode.
- **Nothing persists.** The control plane's run table and `SeqLog` are in memory; a restart loses the
  log and mints a new token. Durability is a later unit.
- **`get_events`, `approve`, `deny`, `list_files`, and `read_file`** have zod shapes in
  `packages/protocol/src/dto.ts` but no contract arm and no handler yet, so calling them is a 404.
