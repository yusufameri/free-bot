> Provenance. This is a synced copy of the master plan, which lives outside the repository at `/Users/yusufameri/.opencode/plan/freebot-plan.md`. The coordinator refreshes this copy at every drain and keeps its hash in the line below, so a stale copy is detectable. `STATUS.md` records what is built against this plan, and the orchestration registers live at `/Users/yusufameri/.opencode/orchestrate/freebot`.
>
> Master sha256 `1504b04866c75bc8cc58c76722f56b40af5cdd84cd1faf6b8a37be030a8b49de`, synced 2026-10-18T05:06:30Z.

# FreeBot — Implementation Plan

An open-source recreation of Grok Bot: named AI "Bots", each with an isolated sandbox computer, that do multi-step work inside real tools and come back for approval. Bring your own key or subscription, run any OpenAI-compatible / open-source model, on the Pi harness, reachable from desktop, mobile, and web.

- **Status:** planning. Execution program prepared (Part 9); starts on operator go
- **Repo:** `/Users/yusufameri/projects/free-bot` (scaffold commit only; remote `github.com/yusufameri/free-bot`)
- **Harness:** Pi (`@earendil-works/pi-coding-agent`, MIT, TypeScript)
- **Adversarial review:** run 2026-10-16 with `opencode/glm-5.3-flash-free`
- **Execution program:** Part 9 (`/goal`, Orchestrate protocol), prepared 2026-10-16

---

# Part 1 — Grok Bot: reference capability model

Grok Bot (x.ai / Cursor, codename "Sand") is an agent platform where each **Bot** is a persistent AI teammate that owns a cloud computer and does work inside real tools rather than returning chat drafts.

Mental model: **Bots = named agents. Account = one shared cloud computer. Chat = the control surface. Skills + Routines = the automation layer. Auto Review = the guardrail.**

## 1.1 Functional capability domains

### A. Identity, accounts, plans
- Sign in with Cursor account (SSO: SAML 2.0 — Okta, Entra, Google Workspace, OneLogin; SCIM 2.0 on Enterprise).
- Access gated by plan (SuperGrok tiers, Cursor Pro/Pro+/Ultra, Cursor Teams, Enterprise).
- Grok Bot has its **own usage meter**, separate from the underlying subscription.
- Bots have **no independent identity/credentials** — a Bot can never hold more access than the signed-in member; every action is attributable to a named human.

### B. Bots as first-class entities
- Create/name/delete Bots, each with a role/job, personality, and its own context.
- Per-Bot: memory, conversation history, files, browser sessions, preferences persist across sessions.
- Create a Bot by describing a job in a message (no workflow builder).
- Deleting a Bot removes its routines but **not** shared computer files or browser sessions.

### C. Messaging surface
- Text chat, dictation, real-time voice chat, voice-memo playback.
- Attach photos/files; take photos from mobile.
- Threads, reactions, `@mentions`, `/` for skills, `@` for Bots/groups/routines/connectors.
- Same thread from desktop and mobile; search across Messages, Bots, Group Chats, Files, Routines.
- Pin / hide conversations.

### D. The shared cloud computer
- One persistent cloud computer **per account**, shared by all Bots (files, browser cookies, signed-in sessions, CLI credentials).
- Desktop, filesystem, terminal, apps, and a browser.
- Durable disk survives hibernation and image updates; idle computers auto-hibernate.
- Shared workspace at `/workspace` for durable project files.
- One screen per Bot on the shared computer; parallel browser/desktop work; one computer-use task per screen at a time.
- Remote-desktop takeover: preview clicks/typing, take control for password/2FA/CAPTCHA/payment/identity checks, then "I'm done."
- Lifecycle: Recover / Update (keeps files) / Reset (rebuild from snapshot); admins can terminate a member's computer.

### E. Computer use + connectors
- Connectors/plugins from "Connect apps", OAuth-authenticated; account-wide; tokens stored on the backend, never on the computer.
- MCP servers, plugins, and skills on the same footing as Cursor's.
- Computer use for services without a connector.
- Preference for connectors over clicking; human-only steps handed off, not bypassed.
- Read-only X search/read out of the box; X plugin adds DMs/bookmarks/home timeline.
- Start work by tagging `@bot` on X (region-limited).
- Team connectors may use team/service-account credentials (the one Bot-credential exception).

### F. Skills, routines, triggers, teaching
- Skill = reusable instructions: when to use, inputs/access, sequence, validation, output, approval boundary. Private skills are one library shared across all Bots.
- Routine = schedule a skill on one owner Bot. Up to **50 routines per Bot**; keeps **20 recent runs** each; schedules ≥ **5 minutes** apart; runs while the laptop is closed.
- Event triggers from account integrations with narrow matching rules.
- Teach-by-demonstration: record a live browser workflow (≤10 min, no mic) → Bot drafts a skill → test → schedule.
- Test run performs real work; review inputs, output format, audit trail, approval stop, failure states.
- Manage: enable/pause, test, edit, inspect history, delete (immediate, no undo).
- Unattended-usage controls: confirm keeping routines running after long absence; auto-pause.

### G. Memory & context
- Per-Bot durable memory: stable preferences, role context, summaries of prior work.
- Conversations and learned context stay **separate per Bot**; shared files, browser sessions, and handoffs move context between Bots.
- Cross-session continuity; Bots become proactive over time.

### H. Multi-Bot coordination
- Bots run in parallel, message each other, share context in group chats, pass ownership.
- Orchestrator ("chief of staff") Bot over specialists.
- Delegation to subagents and "Cloud Agents" is a reviewable action.

### I. Approvals & Auto Review
- Inline approval cards: Allow once / Always allow (rule) / Deny.
- Auto Review: an independent review model evaluates actions **before they run** (shell, plugin calls, computer use, automation writes, delegation) and returns allow / require-approval / deny.
- "Ask first" rules always stop matching actions and win conflicts; "Allow automatically" only proceeds if the reviewer finds no other reason.
- Approvals govern the proposed action, not work already done.
- Auto Review does not cover every side effect (memory writes, most settings).
- Deterministic controls underneath: per-action approvals, network policy, per-user isolation.

### J. Local computer execution
- Optional: Bots act on the member's own machine (run commands, read files, move files between cloud and local).
- Policy: Ask every time / Always allow / Never allow (default per-command approval). Admins can cap the team policy; the stricter wins.
- Separate control from Auto Review.

### K. Notifications
- Conversation updates, approval requests, routine results, voice memos.
- Time-zone and usage controls; language; appearance.

### L. Admin & enterprise controls
- Org-wide enable switch; Network Controls (allow-all / defaults+allowlist / allowlist-only; domain + IP:port; per-group policies, most-restrictive wins).
- Connector policy (separate layer from network policy).
- Team Secrets, Team Setup manifests, "Allow Sudo on Bot Computers", "Allow Local Egress Routing".
- Enforce Auto Review + team Auto Review rules.
- MCP allowlist; execution-on-local-computer cap; team model allowlist (honored by default, enforcement not guaranteed).

### M. Logging, audit, data
- Audit Logs (Enterprise): admin/security/auth + Bot control-plane events; SIEM streaming.
- Action Recording (Enterprise, off by default): scrubbed Bot actions, **90-day retention**.
- OpenTelemetry Export (`cursor.surface=grok_bot`); optional conversation-content export with credential/PEM/email redaction.
- Durable disk per member; connector tokens never on the computer; daily encrypted backups; deletion within 30 days per DPA.
- Data residency: **US**. No on-prem / BYO-image / in-perimeter deployment.
- Privacy Mode (no training); Zero Data Retention via provider agreements.
- Prompt-injection defenses: untrusted content marked as data, Auto Review, network policy, per-action approvals, isolation.

### N. Surfaces
- Desktop: macOS (Apple silicon + Intel), Windows (x64 + Arm64), Linux (x64 + Arm64).
- Mobile: iPhone, iPad, Android.
- Cloud computers run in Cursor's cloud; some advanced controls and teach-by-demonstration are desktop-only.

## 1.2 Non-functional requirements

| Dimension | Requirement |
|---|---|
| Availability | Work continues 24/7 regardless of client state; laptop-closed execution |
| Concurrency | Many Bots in parallel; N screens per account; one computer-use task per screen |
| Isolation | Strict between users; soft between Bots of one account (shared screen is not a security boundary) |
| Durability | Durable disk across hibernate/update; snapshots; daily backups |
| Latency | Interactive chat + live computer preview; background routines tolerate minutes |
| Auditability | Every action attributable to a member; optional scrubbed recording + OTel |
| Safety | Independent review model + deterministic allow/block + egress control |
| Data handling | Token isolation from compute; redaction on export; residency commitment |
| Recoverability | Recover / Update / Reset computer; idempotent retries for routines |

## 1.3 Grok Bot underlying stack (documented + inferred)

**Documented:** Cursor-hosted cloud computers, browser + filesystem + terminal, MCP/plugins/skills, connectors with backend-held OAuth tokens, an independent review model, static shared egress IPs, OTel export, SAML/SCIM, ISO 27001/42001.

**Inferred reference stack:**

| Layer | Likely components |
|---|---|
| Clients | Electron/native desktop; native/RN mobile; shared React UI; WebRTC/RDP-style streaming; push (APNs/FCM) |
| API/control plane | HTTP gateway + WebSocket bus; auth (SAML/SCIM); bot/routine/skill services; approval service; connector service |
| Agent runtime | Agent loop with tool calling; system prompt + skills retrieval; memory/compaction; sub-agent orchestration |
| Model serving | Managed model mix; failover; per-request model attribution for billing |
| Cloud computer | Firecracker microVMs; Linux desktop (X11/Wayland); headless Chromium/CDP; durable volume; snapshot/hibernate; egress proxy with allowlist |
| Connector layer | OAuth vault; typed tool adapters; MCP client; event-trigger bus |
| Memory | Vector store + structured mem; per-Bot scoping; shared filesystem |
| Scheduler | Durable timers; ≥5-min granularity; run history; pause/resume |
| Safety | Review model + policy engine (allow/block/ask); network policy; audit pipeline |
| Data | Postgres (control), object storage (snapshots/files), Redis/queue, SIEM stream |

---

# Part 2 — FreeBot architecture

## 2.1 Thesis

Grok Bot = agent + persistent sandbox computer + multi-surface chat + guardrails. FreeBot keeps that shape but swaps the two lock-in points — the **model** and the **compute host** — for open, pluggable interfaces.

## 2.2 Design principles

1. **BYOM.** Any OpenAI-compatible `/v1/chat/completions` endpoint, plus subscription OAuth where Pi supports it.
2. **Harness = Pi.** Do not rebuild the agent loop.
3. **Sandbox = pluggable interface.** Docker (local/MVP), E2B, boat.dev; self-hosted Firecracker later.
4. **Run the harness where the tools are.** Pi runs inside the sandbox; the control plane drives it over RPC through a tunnel.
5. **Server optional.** Local-first single-user mode must work with no backend; hosted mode adds multi-tenant features.
6. **Guardrails first-class.** Approvals + review + egress policy are not bolt-ons.
7. **One product, three skins.** Shared TypeScript UI core; thin shells.
8. **No vendor hardcoding.** MCP is the connector wire; Composio is one adapter, not a dependency.

## 2.3 Non-goals (v1)

- Training or serving base models.
- Enterprise SSO/SCIM, DLP, private networking (design seams, ship later).
- On-prem control plane (document a self-host path, do not block v1).
- Guaranteeing subscription ToS compliance (surface a warning; user owns the risk).

## 2.4 Architecture

```
        ┌──────────── Clients (shared TS UI core) ────────────┐
        │  Web (Next.js)   Desktop (Electron)   Mobile (Expo/RN)  │
        └───────────────┬───────────────┬─────────────────────┘
                        │ oRPC (typed RPC) + WebSocket (events, tokens)
              ┌─────────▼──────────────────────────────────────┐
              │              FreeBot Control Plane              │
              │  auth · bots · threads · skills · routines      │
              │  approvals · review policy · connectors · sched  │
              │  WebSocket hub · credential vault · egress proxy │
              └─────────┬───────────────────────┬──────────────┘
                        │                       │
             (sandbox lifecycle)        (Pi RPC over WSS tunnel)
                        │                       │
        ┌───────────────▼───────────────────────▼──────────────┐
        │             SandboxProvider (interface)               │
        │   Docker (local) · E2B · boat.dev · Firecracker       │
        └───────────────┬───────────────────────────────────────┘
                        │
        ┌───────────────▼───────────────────────────────────────┐
        │              Sandbox VM  (per Bot by default)          │
        │  freebot-sandbox-agent (supervises Pi RPC)             │
        │  Pi harness · bash/read/write/edit tools · MCP clients │
        │  Linux desktop (Xvfb + noVNC) · Chromium/CDP           │
        │  /workspace (durable) · scoped egress token            │
        └───────────────────────────────────────────────────────┘
```

**Key decision:** Pi runs inside the sandbox; its tools operate on the sandbox filesystem natively; the control plane only shuttles JSON. Driven in **RPC mode** (`pi --mode rpc`, strict JSONL over stdin/stdout) wrapped in a WebSocket tunnel. SDK for local single-process mode.

## 2.5 Component breakdown & stack

| Component | Choice | Why |
|---|---|---|
| Harness | `@earendil-works/pi-coding-agent` (MIT) | 4 tools, <1k-token prompt, RPC + SDK, replaceable everything |
| Model layer | `@earendil-works/pi-ai` + custom OpenAI-compatible provider | 15+ providers + arbitrary base URL/key |
| API layer | Hono + oRPC on Bun | Typed end-to-end RPC contract; portable, first-class Bun WebSockets |
| Real-time | WebSocket hub + Redis pub/sub | token streaming + event fan-out |
| DB | Postgres (+ `pgvector`) | relational + vector |
| Queue/scheduler | Redis (BullMQ) or NATS + durable timers | routines, triggers, retries |
| Object storage | S3 / MinIO | snapshots, attachments, backups |
| Sandbox (dev) | Docker + sysbox/gVisor | fast, no cloud |
| Sandbox (prod) | E2B (Apache-2.0, Firecracker) + boat.dev adapter | isolation + persistence + desktop |
| Desktop shell | Electron | mature, ubiquitous; full Node in the main process; same web UI |
| Mobile | Expo / React Native | iOS + Android, shares TS logic |
| Web | Next.js | primary surface |
| Desktop VM streaming | noVNC/websockify over tunnel (Xvfb + Chromium) | standard tooling |
| Auth (v1) | Better Auth or Lucia + JWT | email/OAuth; Keycloak seam later |
| Credential vault | libsodium sealed box / age, server-side | BYOK keys + connector tokens never touch the VM |
| Observability | OpenTelemetry | audit seams |

## 2.6 Sandbox abstraction

Designed against the **strictest adapter (boat: screen + suspend + fork)**, not Docker. The screen channel is mandatory.

```
interface SandboxProvider {
  create(spec): Handle
  exec(handle, cmd, { stream?, detached? }): Stream
  upload(handle, local, remote) / download(handle, remote, local)
  snapshot(handle, name?) / fork(fromHandle): Handle
  stop(handle) / resume(handle) / delete(handle)
  exposePort(handle, port): Url
  desktop(handle): VncStream            // MANDATORY; Docker first impl = Xvfb + noVNC
  tunnel(handle): Duplex                // for the Pi-RPC agent daemon
  capabilities(): { memoryPause, dockerInVm, kvm, gpu, regions[] }
}
```

| | Docker (local MVP) | E2B | boat.dev |
|---|---|---|---|
| Isolation | container (sysbox/gVisor) | Firecracker microVM | full KVM VM |
| Docker-in-VM | no | no | yes |
| Pause keeps memory | n/a | yes | no (disk only) |
| Desktop/VNC | local Xvfb + noVNC | desktop env | 60fps |
| Snapshots/fork | manual | yes | every 1 min + named + fork |
| Region | local | US/EU/BYOC | EU |
| Cost shape | free | per-second, no GPU | ~$0.036/hr, no GPU |

## 2.7 Repo layout

```
freebot/
  packages/
    protocol/        # shared TS types: events, Pi RPC records, oRPC contract, API DTOs, Connector
    core/            # control-plane logic (bots, threads, approvals, routines, runs)
    sandbox/         # SandboxProvider interface + docker/e2b/boat adapters
    pi-bridge/       # spawn `pi --mode rpc`, JSONL framing, event mapping, tunnel, REPLAY MODE
    providers/       # BYOK OpenAI-compatible client + Pi tool-call smoke test
    connectors/      # Connector interface + mcp / composio / raw-http adapters
    review/          # review-model policy engine + allow/block rules
    ui/              # shared React components + hooks
    verify/          # emulator fixture server, seeds/reset, golden screenshots, e2e drivers
  apps/
    server/          # Hono + oRPC control plane
    web/             # Next.js
    desktop/         # Electron shell around ui/
    mobile/          # Expo app
    sandbox-agent/   # in-VM daemon: supervises Pi, Xvfb, Chromium, MCP clients
  docs/              # self-host + BYOK + connector guides
```

## 2.8 Data model (core entities)

- `user` — account, plan, BYOK config refs.
- `provider_config` — `{id, kind: openai-compatible|subscription, base_url, model, encrypted_key_ref, capabilities}`.
- `bot` — `{id, user_id, name, role, system_prompt, sandbox_id, model_ref, memory_scope, tool_allowlist}`.
- `sandbox` — `{id, provider, vm_ref, status, snapshot_ref, egress_policy}`.
- `thread` / `message` — conversations; `message.parts` (text, tool_call, approval, attachment, voice).
- `group_thread` + `group_member` — multi-Bot coordination.
- `skill` — `{id, owner_scope, body, triggers, approval_boundary}`.
- `routine` — `{bot_id, skill_id, schedule, trigger, active, last_run}`; `routine_run` history.
- `run` — one agent execution: resume, cost, failure forensics (separate from thread).
- `connection` — `{id, user_id, service, kind: mcp|composio|raw-http, token_ref, scopes, health}`.
- `approval_request` / `approval_ledger` — action, inputs, decision, decided_by, review_verdict; ledger defines what "always" means across sessions/models/sandboxes.
- `audit_event` — append-only action log.
- `usage_event` — tokens/cost per provider/model.

## 2.9 The three hard parts

**1. Model-agnostic agent quality.** The OpenAI-compatible contract is only the chat body + `Authorization: Bearer`. Tool calling is the failure mode. FreeBot ships: a save-time smoke test that drives a **real Pi tool-call turn**, per-connection+model capability flags learned from that test, a structured-output fallback for weak tool callers, and honest UI when a model cannot drive Pi reliably.

**2. Sandbox isolation + persistence at acceptable cost.** One sandbox per Bot by default (stronger isolation) with an optional shared workspace volume for handoffs. `SandboxProvider` abstracts lifecycle. Start with Docker (dev) + E2B (prod) + boat.dev; add Firecracker for cost at scale. **Idle-kill and auto-stop are Phase 1.**

**3. Multi-surface sync + in-VM streaming.** One WebSocket event protocol for all three clients. The tunnel multiplexes three channels with explicit sequencing: Pi RPC (JSONL, attach/detach + event sequence numbers), computer screen (VNC), files. `sandbox-agent` supervises Pi and can **reattach to a running Pi**, replaying missed events after a disconnect.

---

# Part 3 — Verification ("Proof") layer

**Bar stated in writing:** *every shipped surface passes a scripted golden path each commit; every in-tree connector has an emulator-backed e2e; real OAuth is verified nightly against test accounts. Arbitrary third-party MCP servers and arbitrary models cannot be absolutely verified and are labeled as such.*

Agent runs are nondeterministic, VNC frames have no frame boundary, and font rendering drifts across CI runners — so verification is split into three tiers at three cadences.

### Tier 1 — Deterministic, per-commit (the "absolute" gate)
- `pi-bridge` has a **replay mode**: record real Pi RPC JSONL transcripts once, replay them in CI so the agent is frozen and the UI is a pure function of events.
- **Playwright** drives web and Electron (via CDP) through each scripted golden path; **Maestro** drives mobile on iOS/Android emulators.
- **Golden screenshots** with perceptual-hash diffing, pinned runner images/fonts, `pixelmatch` thresholds. Includes a screenshot of the **sandbox desktop** (VNC frame) for computer use.
- Assertions on transcript/state + pixels, both deterministic.

### Tier 2 — Emulator-backed connector e2e, per-commit
- `vercel-labs/emulate` runs as a **fixture server on `0.0.0.0`** so sandboxes reach it. Each test seeds, runs, asserts, resets. The Inspector is the debug surface.
- Works only because **every connector base URL is overridable** — the same seam that keeps vendors out of the code.
- Built-in emulated services include Vercel, GitHub, Google (Gmail/Calendar/Drive), Slack, Apple, Microsoft, Okta, AWS, Resend, Stripe, MongoDB Atlas, Clerk, Linear, Twilio; custom services via `defineEmulator`.

### Tier 3 — Real-service smoke + agent judge, nightly/monthly
- Nightly: real OAuth against **test accounts** (Stripe test mode, test GitHub org).
- Nightly: **agent-behavior runs scored by a judge model** (recorded fallback replays so CI has no live dependency).
- Monthly: paid-service smoke.

### Known limits of `emulate`, and the plan for them
- Local Node and platform-shaped: does not fully cover GitHub-App webhook signing nuances, long Google consent flows, mobile Apple/Microsoft sign-in (OS plumbing), or a user's arbitrary MCP server.
- Custom emulators via `defineEmulator` get a **hard cap (5 services)** — not a fidelity treadmill.
- Anything not emulated, or any arbitrary user MCP server / arbitrary model, is **outside the "absolute" guarantee** and gets best-effort diagnostics plus a live smoke lane.

---

# Part 4 — Connectors: plug-and-play MCP

MCP is the wire; Composio is one adapter behind a vendor-neutral seam. **No `@composio/*` types appear above the adapter.**

```
interface Connector {
  describe(): ToolSchema[]          // for discovery/allowlists
  authenticate(): Promise<TokenRef> // token ref, never the raw secret
  call(tool, args): Promise<Result>
  health(): ConnectorHealth
}
```

Implementations, all peers:
- `McpConnector` — stdio / SSE / HTTP MCP. The primary plug-and-play path; Pi loads MCP through its built-in `createMcpExtension()`.
- `ComposioConnector` — the **MVP default**: `composio.create(userId, {mcp: true})` → take `session.mcp.url` + headers → hand to `McpConnector`. (Composio also ships an experimental Pi provider, `@composio/experimental`; not needed, and raw MCP keeps the seam clean.)
- `RawHttpConnector` — for services without an MCP server.

### Failure modes designed for now
- **OAuth callback in a sandbox.** Remote browsers/mobile cannot hit `localhost`. Callback broker from day one: localhost broker + **Electron custom-protocol deep link** + **Expo URL scheme** in local mode; a hosted callback route when the ambient backend is on.
- **Tool schema explosion.** Per-bot tool allowlists + lazy loading via Pi's `tool_search`/`codemode` extensions; the model searches for tools instead of receiving all of them.
- **Token custody.** Tokens live in the control-plane vault; the sandbox gets scoped, short-lived tokens through the egress proxy. A compromised bash call cannot leak the user's OAuth grant.
- **Versioning.** Pin the MCP protocol version; re-verify connector schemas in CI against the emulator fixture server.
- **Anti-coupling test.** A CI job that a Composio-out build still passes the connector contract tests with `McpConnector` + `RawHttpConnector`. If Composio is ever load-bearing, that test fails.

---

# Part 5 — Adversarial findings and their fixes

| # | Finding (severity) | Fix |
|---|---|---|
| 1 | Pi-over-RPC-through-a-tunnel has no resume semantics; tunnel kill drops the stream mid-tool-call (blocker) | `pi-bridge` attach/detach + event sequence numbers; `sandbox-agent` reattaches to a running Pi and replays; Phase 0 kill-the-tunnel-mid-task test |
| 2 | "Any OpenAI-compatible model" is the easy 10%; streaming/tool-call/`response_format` vary (blocker) | Smoke test = a real Pi tool-call turn; capability flags per connection+model, learned from the test |
| 3 | Approvals may be post-hoc, not a real gate; Pi extension points never named (major) | One-page Pi extension-point contract before Phase 0 code |
| 4 | `SandboxProvider` Docker-shaped, would be rewritten when E2B/boat land (major) | Design against the strictest adapter (boat); screen channel mandatory |
| 5 | Secrets custody undecided; model key in the VM is exfiltratable (blocker) | Keys/connector tokens never enter the sandbox; credential-injecting egress proxy; custody decided before Phase 2 |
| 6 | Egress control scheduled too late; guardrails after computer use (major) | Egress allowlist to Phase 1 (flag form); review/approval gates ≤ Phase 2 |
| 7 | UI-core abstraction unvalidated until Phase 6 (major) | Electron + Expo spike against `packages/ui` in Phase 1 |
| 8 | No cost/quota control; bots are an open tap (major) | Idle-kill, per-bot + per-user spend caps, sandbox auto-stop in Phase 1 |
| 9 | Data model gaps (major) | Add `connection`, `approval_ledger`, `run` |
| 10 | Self-contradictions (no-hosted-backend vs OAuth callbacks/push/review; OSS vs Composio SaaS) | Ambient-backend boundary documented; Composio behind MCP seam + Composio-out CI test |

**Ambient backend boundary (explicit):** local mode runs bots, sandboxes, approvals, and local connectors with **zero hosted components**. OAuth callbacks, push notifications for routines, and the default review model are the features that **intentionally require** a hosted component or a user-supplied alternative (e.g., a local model as the reviewer).

## 5.1 Second adversarial pass (MiMo V2.6 Flash Free + Beam Free, parallel)

Two independent reviews ran in parallel. Findings the first pass missed, each now folded into the design:

| # | Finding (severity) | Fix |
|---|---|---|
| 11 | **Approvals enforced inside the VM** the agent controls — the agent can kill/forge its supervisor and bypass the gate (blocker) | Approvals become a **control-plane invariant**: pi-bridge refuses to dispatch a gated tool call without a matching, unexpired grant in `approval_ledger`. The in-VM agent is an untrusted reporter. Phase 0 test: kill/forge the in-VM agent mid-call and assert the call still blocks. |
| 12 | **VM egress not actually constrained** — DNS, raw TCP, IP-literals, and DoH bypass a domain allowlist (blocker) | **Default-deny network at the VM level**, proxy-only reachability, proxy performs DNS. Ships with the **first** sandbox (Phase 0/1), not Phase 2. The proxy must **stream through unbuffered** with a measured p95 overhead budget. |
| 13 | **Tier-1 replay injection point undefined** — replaying above the sandbox bypasses the machinery under test (blocker for Gate 6) | Replay is a **stub at the egress proxy's OpenAI-compatible endpoint**. Goldens hit the stub; smoke tests hit the real endpoint; proxy-captured completions are recorded. |
| 14 | **Unauthenticated localhost control plane** in local-first mode (blocker) | Loopback bind + per-launch random bearer token injected into the Electron preload / web session; `Host`/`Origin` allowlist; block cross-origin WebSocket upgrades. |
| 15 | **Two untyped transports reintroduce type drift**; oRPC acks race WS events (major) | WS message schemas (zod) live in `packages/protocol`; one monotonic `seq` per run shared across oRPC and WS; clients reorder. Screen frames get a separate topic with drop-latest + gap detection. |
| 16 | **Mutations are not idempotent** — retried allow/deny/routine-create double-fires (major) | Client-generated idempotency keys on messages, approvals, and routine creation; enforced server-side in `approval_ledger`. |
| 17 | **TOCTOU on approvals** — approve X, execute Y after args change (major) | Approvals bind to a **canonical action hash** (normalized tool + args); re-approve on mismatch. |
| 18 | **Prompt injection through tool results** can coerce the review model (major) | Tool results marked untrusted; **taint tracking** — any action whose trigger chain includes untrusted content requires human approval. |
| 19 | **stdio MCP placed in the VM** is untrusted code with VM filesystem/network access (blocker) | Connectors (including stdio MCP) run in the **control plane**; only tool results enter the VM. |
| 20 | **Sub-agent delegation leaks scope** (major) | Delegation mints a scoped capability token; a child run's egress allowlist ⊆ parent's. |
| 21 | **Two execution paths** (one-shot vs Pi RPC) duplicate recording/approval/streaming and break replay (major) | One-shot mode runs **through the same bridge** and emits the same JSONL event stream. Anything that cannot emit it is out of MVP. |
| 22 | **Pi version skew** invalidates golden replay; Pi shares a cgroup with Chromium (major) | Pin Pi per image; record `{pi_version, image_digest}` in `run`; replay asserts equality; reserve CPU for Pi. |
| 23 | **Per-Bot vs per-account** is asserted, not proven — N idle VMs cost linearly and cold-wake is tens of seconds (major) | Measure cold-wake p95 and $/bot-month before Phase 2; keep a **hybrid** (one account VM, per-bot containers) as the documented fallback. |
| 24 | **Multi-Bot** sharing/coordination/thread ownership undefined; deadlocks and lost updates (major) | Decide in **Phase 3**: orchestrator-mediated messages with deadlines + human escalation; `/shared` path ownership with a single writer assigned by the control plane; bot-to-bot on a separate channel; only the orchestrator appends to the user thread. |
| 25 | **Golden screenshots churn** on font/OS/Chromium drift (major) | All captures in **one pinned container image on one runner class**; phash threshold + region assertions; golden failures are blockers, never skipped. |
| 26 | **Async run model undefined** — a 20-min task cannot ride one request; mid-run edits/cancel undefined (major) | `start_run` returns `run_id` immediately; events stream with `seq`; `get_run` for late attach; `cancel_run` + rewind; partial turns staged in `run_events`, committed on turn-complete. |
| 27 | **Failover breaks determinism** — a silent model switch changes tool-calling and replay (major) | Pin the model **per run**; retry the same model with backoff on 429/5xx; fail the run rather than switch, unless the user approves a change. |
| 28 | **Memory has no schema, staleness, or forget** (major) | Entries carry source run, timestamp, confidence; retrieval filters by recency; explicit `forget` tool. |
| 29 | **Teach-by-demonstration undefined** (major) | Record the Pi tool-call transcript + screen actions as a routine draft; require deterministic replay before promotion. |
| 30 | **Electron packaging/security deferred past the constraint point** (minor→major) | Decide now whether the server is bundled (Bun binary) or Node; context-isolated preload + CSP with an injected transport; fuses + macOS notarization / Windows signing are Phase 6 exit criteria. |
| 31 | **Local-first boundary not drawn** — web OAuth, push, and a SaaS default connector silently reintroduce a backend (major) | The **callback relay is the one intentionally hosted component** (or drop web OAuth in MVP); push needs an opt-in relay (in-app badge only otherwise); the local default connector is MCP-local/RawHttp, Composio is the MVP easy path with a clear SaaS notice. |
| 32 | **No error taxonomy / observability until Phase 7** (major) | Structured codes (`PI_*`, `TUNNEL_*`, `SAND_*`) with retry hints and a `freebot doctor` bundle from Phase 1. |
| 33 | **Weak-model onboarding** — users hit the tool-calling wall (minor→major) | Capability probe at add-connection; show the smoke-test result; suggest a known-good list. |

## 5.2 Final adversarial pass (DeepSeek V4.1 Flash Free)

Verdict: **conditional go — Phase 0 only, with an expanded definition of done.** The pass found one unexamined assumption on which three separate fixes silently depend, plus four scoped questions to answer before implementation.

**The unexamined assumption — Pi's execution choke point.** Fixes 11/17/19 (approval invariant, action-hash binding, connectors-not-in-VM) all assume *every* Pi tool call crosses pi-bridge. But Pi's native `bash`/`read`/`write`/`edit` and its browser tool execute inside the VM. If any of those run natively without crossing the bridge, the approval gate, the canonical action hash, and taint tracking are all bypassable. **This is the one finding that can flip the design to no-go.** Fix: declare and test that Pi is configured with **no unmediated native execution surface** — Pi emits execution *intents*, and both the bridge (approval) and the sandbox-agent (perform-after-grant) mediate. If Pi cannot be configured this way, approvals move to a **control-plane executor** before any Phase 1 feature work.

Other findings, folded in:

| # | Finding (severity) | Fix |
|---|---|---|
| 34 | **Browser egress bypasses an HTTP proxy** — QUIC/HTTP-3, WebRTC, DoH ignore `HTTP_PROXY` (blocker for Phase 2) | Kernel-level netns/nftables default-deny that drops **all UDP**, plus Chromium `--proxy-server`, `--host-resolver-rules`, `--disable-quic`. Phase 0 proves a sandboxed browser cannot reach an arbitrary IP. |
| 35 | **Memory is a persistent injection channel** across runs; taint covers actions, not memory writes (major) | Memory writes from tainted turns require approval; memory reads taint their consumers. |
| 36 | **Taint policy can cause an approval storm** (major) | Reads are always allowed; taint gates only *sinks*; approvals batch; taint is tracked at the transcript level in the bridge. |
| 37 | **Rewind reuses live grants / dedupe keys** (major) | Rewind is a ledger operation that tombstones grants and idempotency keys with `seq > rewind_point`. |
| 38 | **Idempotency keys misplaced in the ledger** (minor) | A generic `idempotency` table keyed by (actor, key); the ledger holds grants only. |
| 39 | **Topology decision can reopen the schema** (major) | Add a `bot → sandbox` mapping table now, so the per-Bot vs per-account call is data, not schema. |
| 40 | **Routine promotion can't pin a transcript for a general routine** (major) | Promotion asserts the **action sequence** via the stub, with the model only at decision points. |
| 41 | **Promise drift:** self-host should not require hosted components (major) | **MVP hosts nothing.** Drop the callback relay (use `localhost` redirect or device flow); no push relay (desktop notifications / poll); the local default connector is MCP-local/RawHttp; Composio is **opt-in SaaS** — retained as the MVP's easy connector per product decision, but never required — and the known-good model list lives in-repo. |

**MVP re-cut.** Phase 1 was too big. True MVP: **single Bot, local, one surface (web), chat + terminal/filesystem tools (no browser), allow-once/deny approvals, the `seq` protocol, error taxonomy + `freebot doctor`, spend caps.** Electron/Expo spikes and the golden-screenshot infrastructure move to **Phase 1.5** — they prove the surface strategy and the verification harness, not the core thesis.

**Expanded Phase 0 definition of done** (every check fails closed and is a CI blocker):
- Pi RPC in Docker over the tunnel survives kill/reconnect with no lost or duplicate `seq`; one `seq` shared across oRPC and WS.
- **Forge test A:** a gated call — *including a Pi native terminal/browser/file call* — cannot produce an in-VM side effect without a matching, unexpired grant.
- **Forge test B:** with default-deny netns, an in-VM script and the browser cannot reach an arbitrary IP/host, UDP/QUIC, or DoH; only proxy egress works; the proxy resolves DNS and streams unbuffered within the p95 budget.
- **Extension-point contract written and tested:** every tool invocation Pi can make funnels through one intercept.
- No raw key material reachable in-VM (scan mounts, env, processes, filesystem).
- `{pi_version, image_digest}` recorded and asserted equal on a second replay.

**Ranked residual risks:** (1) an unmediated native execution surface; (2) browser egress bypassing the proxy; (3) memory poisoning; (4) taint/approval-storm usability; (5) rewind reusing live grants.

---

# Part 6 — Roadmap

**Phase 0 — Spike (prove the risky seam).** BYOK model → Pi in Docker over a tunnel → 3-step bash task → event stream renders in one web page → approval gate on a destructive command → kill/rejoin the tunnel mid-task. Plus the **execution choke-point contract**, **network containment** (default-deny, proxy-only egress, UDP/QUIC/DoH dropped), and **forge tests A and B**. Full exit criteria in §5.2. If this fails, nothing else matters.

**Phase 1 — Local single-user MVP (true cut).** Single Bot, local, one surface (web); chat + terminal/filesystem tools (**no browser**); BYOK provider with real-Pi smoke test; Pi-in-sandbox over RPC; streaming chat + tool-call cards; **allow-once/deny** approvals; `/workspace` files; localhost auth (per-launch token + Origin/Host allowlist); the `seq`-ordered event protocol with zod schemas; the async run model (`start_run`/`cancel_run`); the proxy OpenAI-compatible replay stub; error taxonomy + `freebot doctor`; spend caps.

**Phase 1.5 — Surface strategy & verification harness.** The Electron/Expo UI-core spike and the golden-screenshot + emulator infrastructure (deterministic replay → Playwright/Maestro → perceptual-hash goldens). Proves the surface strategy and the verification harness, not the core thesis.

**Phase 2 — Sandbox computer + computer use (with guardrails).** Headless Chromium + Xvfb + noVNC; screen preview; VNC over the tunnel; human takeover for 2FA/CAPTCHA; Pi browser tool. Sandbox backends follow **Part 12**: Docker first (already shipped), then a no-account backend for a local machine (microsandbox) and one for a Linux host or CI (E2B Embed), each passing the one conformance suite. Paid or account-gated services (boat.dev, E2B Cloud, Daytona Cloud) are parked optional adapters behind the same seam, never requirements. Approval + review gates ship **with** this, not after.

**Phase 3 — Retention & automation.** Skills library; routines (scheduler, ≤50/bot, run history); event triggers (webhook); teach-by-demonstration (record CDP actions → draft skill); memory via pgvector. Routine/trigger engine is its own product-sized effort — scope explicitly. Decide **multi-Bot coordination** here (orchestrator-mediated messaging, deadlines, thread ownership, `/shared` path ownership), the memory schema, and teach-by-demonstration transcript capture.

**Phase 4 — Multi-Bot + coordination.** Group threads, Bot-to-Bot messaging, task handoff, parallel execution across per-Bot sandboxes with a shared volume.

**Phase 5 — Guardrails & connectors.** Connectors follow **Part 11**: built and asserted against emulators, and every credential belongs to the person who installs FreeBot and lives in their vault, never the author's. Review model + policy engine; `Connector` framework (MCP / Composio / raw HTTP); OAuth vault + callback broker; egress proxy allowlist enforcement; audit log; usage/cost dashboard; emulator-backed connector e2e.

**Phase 6 — Multi-surface.** Electron desktop, Expo mobile, thread sync, voice (STT/TTS). Push notifications via an opt-in hosted relay (in-app badge only otherwise). Exit criteria include Electron fuses, macOS notarization, and Windows signing.

**Phase 7 — Hardening & self-host.** Firecracker adapter, snapshot/hibernate, backups, egress/DLP hardening, OTel export, docs, packaging, CI.

---

# Part 7 — Risks

| Risk | Mitigation |
|---|---|
| OSS models fail at tool calling | Capability flags, real-Pi smoke test, structured-output fallback, honest UI |
| Subscription ToS forbids third-party use | Label as user-risk; prefer API keys + local/OpenRouter; subscription only where Pi supports it |
| Sandbox cost at scale | Docker/dev → E2B/boat; idle-kill; auto-stop; spend caps |
| Prompt injection via web/connector output | Mark untrusted content, review model, deterministic allow/block, egress allowlist |
| Multi-surface drift | One protocol package, one event bus, one UI core |
| Tunnel/VNC security | mTLS to the VM, short-lived scoped tokens, secrets kept out of the VM |
| BYOK key leakage | Server-side vault only; credentials injected at the egress proxy, never in the VM |
| Composio becomes load-bearing | MCP seam + Composio-out CI contract test |

---

# Part 8 — Gates: what must be true

1. Pi has **no unmediated native execution surface**: every tool invocation funnels through one intercept, and a native terminal/browser/file call cannot produce an in-VM side effect without a matching grant (Phase 0 forge test A). If false, approvals move to a control-plane executor.
2. Tunnel + Pi RPC survives disconnect/reconnect, with one `seq` shared across oRPC and WebSocket (Phase 0, kill-tested).
3. The provider smoke test is a real Pi tool-call turn; capability flags are learned from it.
4. Keys and connector tokens never enter the VM; VM egress is default-deny, proxy-only; the proxy resolves DNS and streams unbuffered; browser egress is contained at the kernel (UDP/QUIC/DoH dropped) — shipped with the first sandbox (Phase 0 forge test B).
5. Approvals are enforced in the control plane, bound to a canonical action hash, idempotent, and rewind tombstones grants.
6. The replay stub seam is defined at the proxy's OpenAI-compatible endpoint; goldens are deterministic and run in one pinned image.
7. `SandboxProvider` is frozen against screen + suspend semantics (boat); `bot → sandbox` is a mapping table from day one; per-Bot vs per-account is decided with measured numbers.
8. Composio is reachable only via the MCP seam; the local default is MCP-local/RawHttp; a Composio-out build passes CI. MVP hosts nothing.
9. Multi-Bot coordination (messaging, deadlines, thread ownership, `/shared` path ownership) is decided in Phase 3.
10. Memory (not just actions) is protected from taint: writes from tainted turns need approval; reads taint their consumers.
11. Taint gates only sinks, reads are always allowed, approvals batch — no approval storm.
12. Each surface ships a deterministic harness; "absolute" explicitly excludes arbitrary user MCP servers/models.

---

# Appendix — Key external facts

- **Pi** (`github.com/earendil-works/pi`): MIT, TypeScript monorepo. Packages: `@earendil-works/pi-ai` (multi-provider LLM), `pi-agent-core` (runtime), `pi-coding-agent` (CLI). Four modes: interactive TUI, print/JSON, RPC (`pi --mode rpc`, JSONL), SDK. Built-in extensions: `codemode`, `tool_search`, MCP.
- **vercel-labs/emulate**: local drop-in, stateful, production-fidelity API emulators for CI and no-network sandboxes. Built-in services + `defineEmulator` + Inspector + seeds/reset/snapshot; `--host 0.0.0.0` to reach from containers.
- **boat.dev** (by ASCII): full Ubuntu KVM VMs, Docker-in-VM, 60fps desktop, snapshots/fork, Pi among 7 pre-installed harnesses, EU regions, ~$0.036/hr, `--no-env` per-user sandboxes.
- **Composio**: tool-router sessions expose MCP endpoints (`session.mcp.url`); `@composio/experimental` offers an experimental Pi provider.
- **Grok Bot**: Cursor-hosted cloud computers; desktop mac/win/linux; mobile iOS/Android; US residency; ISO 27001/42001.

---

# Part 9. Goal-run protocol (the /goal execution program)

Added 2026-10-16 before execution. This part is the contract the coordinator and every worker follows until the done predicate holds.

**Goal text (armed on the operator's go).** "Execute freebot-plan.md Part 9. Keep going until the §9.1 predicate holds. Verify every unit against the real surface and commit durable artifacts (screenshots, recordings, emulator runs) under `verify/artifacts/`. Full autonomy except the gates parked in `gates.md`."

**Routing.** poteto-mode Orchestrate playbook, run as a standing program with the human checking in at intervals. Harness adaptation is explicit throughout. Cursor's Task, gt, and orch machinery map to this session's subagents and the bundled `orch` CLI.

## 9.1 Done predicate (the countable target)

The run ends when every line below holds, each with its evidence, or is parked in `gates.md` with a named external blocker.

1. **Phase 0 exit.** All six checks in §5.2 green. Each carries a committed artifact under `verify/artifacts/phase0/` and a ledger row pinned to a commit SHA.
2. **Phase 1 MVP.** Every MVP feature merged and verified with `live-ui-verified` evidence. The feature list is fixed by §5.2's MVP re-cut.
3. **Gates 1 to 8 hold** with their tests green. A gate that fails flips the design to its stated fallback, and the fallback is re-verified before anything continues. Gate 1 false moves approvals to a control-plane executor.
4. **Phase 1.5.** Goldens deterministic in the pinned image across two consecutive CI runs within the phash threshold.
5. **Phases 2 to 7.** Exit criteria met per phase, or parked with blocker. Local-feasible parts proceed (desktop plus noVNC, the tunnel VNC channel, adapter code, a review model with a local reviewer). Credential-gated parts park (real E2B or boat.dev runs, real OAuth, signing, paid SaaS).
6. **Exclusions labeled.** Arbitrary third-party MCP servers and arbitrary models stay outside the "absolute" bar and are labeled so in `docs/VERIFICATION.md`.

"Utterly perfect" is this predicate, not a vibe. A feature without a real-surface artifact is not claimed done. No artifact is fabricated. Every screenshot, recording, and log comes from a real run of the committed script.

## 9.2 Tracks

| Track | Scope | Units (estimate) |
|---|---|---|
| T0 scaffold | repo skeleton per §2.7, CI, conventions, `verify/` harness skeleton. The pilot unit lives here | 1 to 2 |
| T1 Phase 0 spike | pi-bridge framing, tunnel plus kill/rejoin, sandbox-agent reattach, egress containment, forge tests A and B, replay stub, extension-point contract | ~10 |
| T2 control plane MVP | localhost auth, oRPC contract, `seq` protocol, approvals ledger, async run model, error taxonomy plus doctor, spend caps | ~10 |
| T3 sandbox | Docker adapter first, egress proxy, Xvfb plus noVNC, keys scan | ~8 |
| T4 web surface | Next.js shell, streamed chat, tool-call cards, approval cards, `/workspace` files | ~8 |
| T5 verification harness | emulate fixture server, Playwright drivers, goldens in the pinned image, recordings, artifact pipeline | ~6 |
| T6 design parity | the exported prototype's visual contract: frozen tokens, shell geometry, the first-run wizard, the aside and its resizer, the overlay primitives, the item components and Bot status, the landing route, and the nine-viewport matrix (Part 10) | 7 |

Counts are estimates. The authoritative count lives in `units.tsv` and is re-cut at each drain. Phase 1.5 and later phases get their own tracks when reached.

## 9.3 Proof bundle (durable verification)

All of it lives in the repo, outside any session, replayable by a stranger.

- **`verify/` package.** One script per feature. Each drives the real surface (Playwright for web, `docker exec` for the sandbox, HTTP for the API) and exits non-zero on failure.
- **`verify/artifacts/<feature>/<sha>/`.** `screenshot-*.png` for every asserted state, `run.webm` recording for UI flows, `transcript.txt` for terminal flows, `assert.txt` with the exact command and output. The latest green run per feature is kept. `verify/prune.sh` supersedes older runs by content.
- **`docs/VERIFICATION.md`.** The index. One row per feature with script command, verdict, artifact dir, SHA, and date. Regenerated from artifacts, never hand-maintained.
- **Ledger.** `ledger.tsv` in the store, one verdict per PR and head SHA. The in-repo copy is the VERIFICATION.md row at merge.
- **Emulators.** `vercel-labs/emulate` fixture server on `0.0.0.0` for connector e2e. Each run's transcript is an artifact.
- **Forge artifacts.** Kill/rejoin logs, containment probe logs, keys-scan output, replay determinism diff.
- **Replay stub.** The proxy's OpenAI-compatible endpoint serves recorded completions in CI. Goldens never hit a live provider.

## 9.4 Store and CLI

Store at `~/.opencode/orchestrate/freebot/` with one writer per file and append-only tables. The files are `preferences.md`, `overview.md`, `units.tsv`, `frontier.json`, `ledger.tsv`, `inbox/`, `gates.md`, `decisions.tsv` (show-me-your-work format), and `status.md` (regenerated).

Bookkeeping runs through `bun ~/.config/opencode/skills/poteto-mode/scripts/orch/orch.ts --store ~/.opencode/orchestrate/freebot <command>` with commands `init`, `unit`, `ledger`, `inbox`, `gate`, `frontier`, `status`, `standing`. The TSV and JSON files are the source of truth. The CLI is convenience over them.

## 9.5 Brief template (every spawn carries all of it)

```text
GOAL         one sentence, executable by a stranger with no chat access
SCOPE        paths this unit may write; paths it may not; exclusive worktree or branch
CONTEXT      file and PR pointers; upstream reports pasted in full when depended on
ACCEPTANCE   checkable criteria, one per line
VERIFY       exact commands, expected artifacts, known gotchas
TIMEBOX      runtime cap; on expiry return partial findings and stop
FORBIDDEN    no rebase, no force-push, no gt, no fixes outside scope
REPORT       status, branch, head SHA, PR, verdict, what actually ran, deviations, follow-ups
STANDING     preferences.md pasted verbatim
```

A one-command unit collapses this to a paragraph that still names goal, scope, verify, and report shape. Never resume-chain a brief. Respawn fresh with consolidated scope.

## 9.6 Standing orders (draft, versioned in preferences.md)

1. Stack is TypeScript. Bun, Hono, oRPC, Postgres plus pgvector, Redis, S3 per §2.5. No new framework without a gate entry.
2. Repo layout per §2.7. `SandboxProvider` frozen per §2.6.
3. One writer per branch or worktree. The coordinator never writes code. It authors briefs, drains, lands verified units, and decides.
4. No rebase, no force-push, no history rewrites. Scaffold units may land on main directly with their verify. From the first feature PR on, everything goes through PRs against main.
5. A unit is done only when its proof artifact is committed at landing, never batched.
6. CI green is an input to a verdict, not a verdict. Behavioral units need `live-ui-verified`.
7. Verifiers run on a different model family from their worker.
8. BYOK keys and connector tokens live only in the vault path. Never in the repo, never in the sandbox filesystem, env, mounts, or process table. The one real-key smoke test is gated, and its key enters via `request_secret`.
9. Goldens run against the replay stub in the pinned image, never live providers.
10. MVP hosts nothing. Local mode works with zero hosted components (§5.2 finding 41).
11. A human gate parks in `gates.md` while work continues around it. Never idle, never wait.
12. Every user-visible surface change gets a recording, not just a screenshot.
13. The trail gets a row at every fork, pivot, revert, and landed unit.
14. Mid-run discoveries fix only what blocks the frontier. Everything else becomes a follow-up row in `overview.md`.

## 9.7 Model roles

Resolved at spawn time from the live catalog. Defaults, overridden via `/setup-pstack`.

| Role | Default family | Candidates seen at session start |
|---|---|---|
| Code worker, easy | fast code class | grok 4.6, Kimi K2.7 Code |
| Code worker, hard | judgment class | Claude Opus 5.x, Claude Fable 5.1 |
| Verifier | different family from worker | DeepSeek V4, GLM 5.x, MiMo, Gemini |
| Prose and docs | judgment class | Fable or Opus class |

The catalog confirmed cross-provider child tasks are available at session start (Claude provider, `canRunChildTask` true, no constraints). Exact pins land in `preferences.md` at kickoff.

## 9.8 Human gates (parked now)

| Gate | Need | Default without it |
|---|---|---|
| G1 | One BYOK OpenAI-compatible API key for the real Pi tool-call smoke test (Gate 3) | replay fixtures and all non-model units proceed; the smoke-test unit parks |
| G2 | Docker daemon running on this Mac. Observed down 2026-10-16 | start at kickoff; if it cannot start, T1 parks and T0 and T5 proceed |
| G3 | E2B or boat.dev account, Phase 2 | adapters land as code; real runs park |
| G4 | macOS notarization identity, Windows signing cert, Phase 6 | packaging lands unsigned; park |
| G5 | Real OAuth test accounts and paid-service keys, Tier 3 | emulator tiers proceed |

Keys enter through T3 `request_secret` into the vault path. They never appear in chat, in files, or in the sandbox.

## 9.9 Liveness and resume

- **Heartbeat.** A T3 interval task (default 45 minutes, reversible) wakes this thread to advance the program or log a no-op. Armed via `schedule_task` at kickoff. Cadence and next run time reported to the operator.
- **Human check-ins** can land at any time. The coordinator drains, reports counts, and refills the wave.
- **Restart.** Re-read preferences and `units.tsv`, recompute the frontier, reattach by PR and branch SHA (never by agent id), drain, resume. The store is the resume point.
- **Landing.** Continuous from the first verified unit, never a terminal phase. By roughly 70% of any budget window, stop spawning and land what is verified.

## 9.10 Report contract

Checkpoint and close reports use numbers from the tables, never narrative. Report the predicate count from `units.tsv` and `ledger.tsv`, tracks and what each landed, the frontier (PR list plus SHAs), verdicts, what parked and why, gates awaiting the human, the store path, and the trail path. PR links included. The operator is asked exactly twice across this protocol. First the kickoff go, second G1 with G2 when their units arrive. Everything else proceeds or parks.

## 9.11 Run risks

| Risk | Mitigation |
|---|---|
| macOS may not run kernel-level containment (netns/nftables, UDP/QUIC/DoH drops) the way a Linux host does | the pilot lane proves it in Docker first, with a Linux CI runner as fallback for containment lanes. Proven in U0.7, not assumed |
| Docker daemon down at kickoff | start it; otherwise T1 parks while T0 and T5 proceed |
| Context budget | workers return summaries and artifact pointers. Bulk stays in the store and the repo. The coordinator never reads the same raw payload twice |
| Model catalog drift between spawns | roles re-resolved live. Preferences pins families, not versions |
| Golden churn on font or OS drift | pinned image, one runner class, phash thresholds. Failures are blockers (§5.2 finding 25) |
| Scope drift toward polish before gates hold | standing order 14 parks everything that does not block the frontier |

---

# Part 10 — The design contract (the exported prototype)

Added 2026-10-18 at the user's direction. Source: `~/Downloads/FreeBot-UX-Prototype.zip`, extracted beside it and copied to the store at `design/`. The archive is an OpenDesign handoff (`DESIGN-HANDOFF.md`, `DESIGN-MANIFEST.json`) plus two exports of the same product.

## 10.1 What the export carries

Read from both files, not from the handoff's prose alone.

- **Two screens in one shell.** `freebot-prototype-v1.html` (72 KB, the handoff's entry file, one media query at 980px) and `freebot-prototype.html` (214 KB, two media queries at 1120px and 860px, and the fuller surface set). Both name the same two screens: `firstrun` and `app`.
- **First run** is three panes plus a provider welcome: "What should we call your first Bot?", "What is it for?", "Pick something to start with", with `Continue` / `Skip`, a provider pane whose copy is "Test a real tool call before we save it", and its failure and test-output regions.
- **The app shell's geometry.** Sidebar 264px (`--sb-w`), details aside 384px (`--aside-w`), a thread column between them, a drag resizer, an aside body with tabs, notices, and a reconnect banner.
- **Overlay primitives.** A command palette (`Search ⌘K`), a modal body, and a popover.
- **The item components.** An approval card, a tool call, and a turn marker, plus the Bot row with its status dot (running, needs an answer, failed), Bot groups, and a hidden group.
- **Frozen tokens.** `--bg #000000`, `--surface #0a0a0a`, `--surface-2`/`--accent-2 #0f172a` as a selection wash, `--fg #ffffff`, `--muted #737373`, `--border #242424`, `--accent #000000` spent only on inset wells, four `color-mix` derived states for hover and soft fills, Geist display and body with a mono stack, a type scale (`--fs-h1: clamp(30px, 4.4vw, 46px)`, h2 24, h3 17, body 15, meta 12.5), `--radius: 8px`, and motion timings.
- **The responsive contract.** A nine-viewport matrix, 360×800, 390×844, 430×932, 600×960, 820×1180, 1024×768, 1366×768, 1440×900, 1920×1080, and no horizontal overflow at any of them.

## 10.2 Precedence (order 32)

The export governs visuals, geometry, tokens, motion, and the responsive matrix. `UX.md` governs product behavior, copy semantics, and the deviation log. Where the two conflict on a visual question, the export wins; where they conflict on behavior, `UX.md` wins and the prototype's placeholder is replaced by the real thing. No OpenDesign chrome, preview label, or design annotation ships.

## 10.3 Scope boundary

The export is a visual contract, not a new feature list. Routines, the computer view, connectors, memory, and multi-surface work stay in their own phases. The one surface the export adds is a landing page, and it ships as its own route per the handoff's screen-file policy. The handoff also forbids flattening the export into generic cards, gradients, placeholder stats, or framework-default typography; a parity unit that cannot match a surface says so and records why rather than approximating.

## 10.4 Track T6 — design parity

| Unit | Delivers | Acceptance |
|---|---|---|
| **U6.1 tokens, shell geometry, viewport harness** | one frozen token source extracted from the export; the app shell's real geometry (264px sidebar, 384px aside, thread column, resizer); Geist loaded; the nine-viewport capture harness with a no-overflow assertion and a pixel comparison against the export at the same viewport; the export committed to the repo as a frozen artifact; `docs/DESIGN-CONTRACT.md` recording which export file governs which surface | tokens are one source, not literals at call sites; the shell renders at all nine viewports with no horizontal overflow; the harness compares against the export and reports a per-viewport delta rather than a pass/fail it cannot justify |
| **U6.2 first run** | the three-pane wizard plus the provider welcome, wired to the real BotStore and the provider route U4.3 landed; `Continue` / `Skip`; the pane that tests a real tool call before saving | a fresh install reaches its first Bot through the wizard; each pane's state is asserted from the DOM; `Skip` is honoured; the provider pane runs the real test and shows its four outcomes |
| **U6.3 the aside** | the details panel (thread, Bot, files, audit tabs), the drag resizer with a persisted width, notices, and the reconnect banner driven by real stream state | the panel's tabs read real data; the resizer persists across a reload; a dropped stream shows the banner and a recovered one clears it |
| **U6.4 overlays** | the command palette (⌘K, fuzzy over Bots, threads and commands), the modal and sheet, and the popover, each with default, hover, focus, active, disabled and loading states | keyboard-only operation end to end, focus trapped and restored, Escape closes, and the palette's actions do the same thing the buttons do |
| **U6.5 item components and Bot status** | the approval card, tool call and turn marker matched to the export, the Bot row with its status dot, Bot groups, and the hidden group | each state the prototype shows is reachable with real data, and the status dot is derived from the run's real state rather than a label |
| **U6.6 the landing route** | the hero and its sections as their own route, kept out of the app shell | it is a separate route, its product evidence is real screenshots rather than mock frames, and it is honest about what runs today |
| **U6.7 the fidelity pass** | every product screen pixel-diffed against the export, app and export rendered in the same browser instance at the nine-viewport matrix, near-zero tolerance on the shell chrome and named variance only in real-data content regions (order 36) | the matrix is committed as evidence with a literal diff statistic per viewport; no viewport scrolls horizontally; every remaining delta is either fixed or listed in `docs/DESIGN-CONTRACT.md` with the pixels that differ and its reason |

## 10.5 Sequencing and evidence

U6.1 comes first because every later unit layers on its tokens and its harness, and because it is what makes a parity claim checkable rather than asserted. U6.2 follows because it is also `UX.md` page 2 and it closes the moment U4.2 had to fake. U6.3 to U6.5 bring the shell to the export's shape. U6.6 is the only new surface. U6.7 runs last and can reopen any earlier unit.

A parity unit's evidence follows the standing convention: `packages/verify/artifacts/<surface>/<sha>/` with one PNG per asserted viewport-state, an `assert.txt` carrying the literal checks, a verdict of `live-ui-verified` where the surface is real, and a `docs/VERIFICATION.md` row whose Commit cell is an ancestor of head. Order 24 applies: the PR body embeds the shots at pinned raw URLs.

---

# Part 11 — Connectors: emulator-first, and the user's credentials are the user's

Added 2026-10-18 at the user's direction. Two rules, and the work that follows from them.

## 11.1 The rules

1. **The developer ships no credentials and owns no account.** A person who installs FreeBot connects their own model provider, their own connector accounts, and their own cloud, if they use one. Nothing in this repo may require a key, an account, or a subscription that belongs to the author.
2. **Build and test against emulators.** Connector behaviour is developed and asserted against `vercel-labs/emulate` running as a fixture server, seeded, asserted, and reset per test. A real third-party service is a manual, best-effort check that a person runs with their own account, never a CI dependency and never a merge gate.

This generalises what the model provider already does. `~/.freebot/provider.env` holds the person's own key; the app runs the labelled replay when that file is empty. Connectors follow the same shape.

## 11.2 What a connector is, and where its token lives

The connector seam stays as Part 4 defines it: MCP is the wire, Composio is one adapter behind a vendor-neutral interface, and no `@composio/*` type appears above the adapter. Two things Part 4 left implicit and this part fixes.

- **The token belongs to the person, and it lives in their vault.** A connector is added, tested, and removed from the app against the person's own account. Its credential goes to the same per-machine vault the provider key uses, at mode 600, and never into the repo, an artifact, a log line, or a response body. The vault probe that exists for the provider key applies unchanged.
- **The token never enters the sandbox.** Gate 4 already says keys and connector tokens are injected at the egress proxy and never reach the VM. A connector whose credential the model can read is a connector that leaks on the first prompt injection.

## 11.3 The emulator harness is the test surface

`vercel-labs/emulate` runs on `0.0.0.0` so a container reaches it. Its built-in services cover GitHub, Google, Slack, Okta, Stripe, Resend, AWS and others, and `defineEmulator` covers what it does not. The harness follows the plan's existing shape:

- one fixture per connector test, seeded before the run and reset after it;
- the run's own transcript committed as the artifact;
- the connector's tool calls asserted against the emulator's state, not against a mock's return value;
- the Composio-out contract test from gate 8 kept: a build with the Composio adapter removed passes.

Anything the emulator cannot represent, and any arbitrary third-party MCP server, stays outside the "absolute" bar and is labelled so in `docs/VERIFICATION.md`.

## 11.4 Track T8 — connectors

| Unit | Delivers | Acceptance |
|---|---|---|
| **U8.1 the seam and the emulator harness** | a `Connector` interface above the wire, an MCP client, and the fixture server with one emulated service driven end to end by a real model turn | the model calls a tool through the seam and the emulator's own state changes; the fixture starts on `0.0.0.0`, is seeded and reset per test; no account, no key |
| **U8.2 the person's own sign-in** | add, test, and remove a connector from the app against the person's account; the credential goes to their vault at mode 600 and is provably unreadable from the API | the same three probes the provider key has: not returnable over the wire, not in the record file, not in any artifact; the developer's environment contains no connector credential at any point |
| **U8.3 the Composio adapter** | Composio behind the seam, plus its MCP endpoint path and the Composio-out CI contract test | the emulator path stays the default test; the contract test proves the build works with the adapter deleted |
| **U8.4 the Connect apps surface** | the export's own "Connect apps" entry and its states, in the design contract's shape | every state reachable with real data, including a connector that fails its test |

## 11.5 Sequencing

U8.1 is the next connector work and it needs no account, so it is unblocked today. U8.2 and U8.4 depend on U8.1. U8.3 is last because it is one adapter behind a seam the emulator already exercises.

---

# Part 12 — Sandboxes for the MVP: no paid dependency

Added 2026-10-18 at the user's direction. The MVP must not require a payment from the person who runs it. A paid service may exist as an optional adapter behind the same seam, never as a requirement.

## 12.1 What the plan said, and what changes

Part 6's phase 2 named E2B and boat.dev as the adapters to add. That reads as a requirement, and it is not one. Phase 2 changes to: Docker first (already shipped), then one no-account backend for local use, then one for a Linux host or CI. Paid or account-gated services move to a parked list with their cost named, and each becomes another conformance pass rather than a milestone.

## 12.2 The options, on the evidence

| Option | Licence and cost | Host | Verdict |
|---|---|---|---|
| **Docker** (shipped) | open, already on the machine | macOS arm64, Linux, Windows | the reference implementation and the default |
| **microsandbox** (`superradcompany/microsandbox`) | Apache-2.0, no account, no server | macOS Apple Silicon, Linux with KVM, Windows with WHP | the local no-payment backend to try first. Its README calls it beta software with breaking changes expected, so the adapter carries that label |
| **E2B Embed** (`e2b-dev/runtime`, `embed/`) | Apache-2.0, no account or licence key; the cloud plans are paid | Linux x86-64 with KVM only | the free path for a Linux host or CI. It does not run on this Mac, which is a fact to record rather than work around |
| **E2B Cloud** | $0 plan fee, one-time usage credits, then metered | their cloud | parked. A person may bring their own account; the MVP never requires it |
| **boat.dev** | paid, with a seven-day trial | their cloud | parked by the user's direction. Not part of the MVP |
| **Daytona cloud** | `daytonaio/daytona` was archived in June 2026 and core development moved private; the last open release was v0.190.0 under AGPL-3.0, continued by a community fork | their cloud | parked, and its history is the reason 12.1's rule exists |

Sources read on 2026-10-18: `e2b.dev/open-source` and its `llms-full.txt` (Embed needs no account, requires Linux with KVM), the E2B pricing page (Hobby is $0 plus usage metered per CPU-second and GiB-second), `github.com/superradcompany/microsandbox` (Apache-2.0, local microVMs, Apple Silicon and KVM hosts, CLI `msb`), and the archived `daytonaio/daytona` README.

## 12.3 Track T9 — sandbox backends

| Unit | Delivers | Acceptance |
|---|---|---|
| **U9.1 the conformance suite** | one suite every `SandboxProvider` runs: create from a pinned image, exec, upload, download, the tunnel echo, snapshot and resume, idle-kill, and the label-scoped sweep. Docker is the reference and passes it | the suite names the operations and their assertions once, so a new backend is a pass or a failure rather than a rewrite |
| **U9.2 the microsandbox adapter** | the local, account-free backend on Apple Silicon, passing U9.1 | the adapter runs a real model turn that writes a file the host reads back through the tunnel; the beta label is carried in the docs and in the UI's own words |
| **U9.3 the E2B Embed adapter** | the free Linux backend for a host or CI that has KVM, passing U9.1 | the same assertions as Docker pass on a Linux host, the macOS limitation is stated, and no account or key is needed |
| **U9.4 parked paid adapters** | Docker-driver-compatible adapters for account-gated services, each behind the same seam | not scheduled. A person's own account is the only way any of them runs |

## 12.4 Sequencing

U9.1 comes first because it is what makes the rest cheap. U9.2 follows because it is the one that runs on this machine without payment, which makes it the useful default for a person who installs FreeBot on a Mac. U9.3 needs a Linux host, so it parks behind that fact rather than behind a decision.

The gap U6.1 named is closed by U9.2 or U9.3: without a no-account backend, a person without Docker cannot run this at all.
