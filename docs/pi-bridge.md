# Pi bridge (U0.3): typed RPC client, replay transport, fail-closed Gate 1 seam

Status: implementation complete, unit-test-verified over the replay transport. The live keyed smoke
is built but parks on this machine (no BYOK key); no model key was read, used, or logged.

## Provenance

- Protocol authority: the U0.2 transcript `packages/pi-bridge/fixtures/rpc-handshake.jsonl`
  (248 lines, 165 `pi->bridge` frames, 13 inbound kinds, 39 `ok:true` checks) and the pinned
  package's own docs, `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` (+ `json.md`,
  `rpc-commands.md`, `rpc-extension-ui.md`).
- Rationale and line-level citations: `docs/pi-rpc-spike.md`. The package is pinned without a
  caret at `1.3.0` in `packages/pi-bridge/package.json`.
- The fixture is frozen spike evidence; nothing in this package writes to it.

## Shape

```
src/frames.ts    frame unions for every fixture kind + parseFrame / serializeFrame
src/errors.ts    PiProtocolError, PiCommandError, PiTransportError
src/transport.ts Transport seam: spawnPiTransport (live), createReplayTransport (tests)
src/session.ts   PiSession: request/response correlation, ordered events, gate handling
src/gate.ts      gate decision type, codecs for the dialog protocol, fail-closed defaults
extension/tool-gate.ts   the in-Pi `tool_call` intercept (Gate 1)
extension/smoke-echo.ts  the one tool the smoke asks a model to call
scripts/smoke.ts         live keyed smoke; parks without a key
```

## Transport seam

`Transport` is three members: `write(command: PiCommand)`, `subscribe(listener)` delivering
`TransportEvent = frame | error | closed`, and `close()`. Two implementations:

- `spawnPiTransport` runs `pi --mode rpc` via `Bun.spawn`, splits stdout on LF only (per `rpc.md`;
  `readline` would also split on U+2028/9), strips a trailing CR, and parses each line with
  `parseFrame`. Unparseable lines become stream `error` events, not crashes.
- `createReplayTransport(frames)` is deterministic: when the session writes a command carrying an
  id, it releases the recorded response with that id; `drain()` releases everything else in
  recorded order. A replay miss for a requested id throws `PiTransportError` (the test is wrong,
  not the protocol).

Unknown inbound kinds are preserved as `PiUnknownFrame = { type: "unknown_frame", raw }` so the
unions stay narrowable while forward compatibility is kept.

## Session contract

- `session.request(command)` returns the correlated `PiResponse`; `success:false` rejects with
  `PiCommandError` (the error string from Pi). Timeouts reject (`requestTimeoutMs`, default
  120 s).
- Responses without an id cannot be correlated (Pi's own parse-error shape, `L9` of the
  transcript): they land in `session.protocolErrors` as `PiProtocolError`.
- `session.events` is every non-response inbound frame in arrival order.
- `session.waitForSettled(ms)` resolves on `agent_settled`, the one frame that means the turn is
  over in every path (including blocked tool calls).
- `session.toolGates` is the approval trail: one entry per gate dialog seen, with outcome
  `allow | deny | cancelled`.

## Gate 1 seam and the dialog protocol

The intercept (`extension/tool-gate.ts`) installs one `tool_call` handler, so every tool call that
reaches Pi's tool pipeline — including nested `ctx.executeTool()` calls — passes through it. The
handler asks the bridge over the extension-UI sub-protocol:

- request: `extension_ui_request` with `title: "freebot.tool_gate"`, `method: "input"`, the tool
  call as JSON in `placeholder`, and a **mandatory** `timeout` of `GATE_DIALOG_TIMEOUT_MS`
  (2 min). Pi auto-resolves the dialog on timeout.
- response: `extension_ui_response` whose `value` is the decision as JSON, e.g.
  `{"allow":true}` or `{"allow":false,"reason":"policy says no"}`.
- on denial the handler returns `{ block: true, reason: "denied by freebot gate: <reason>" }`,
  which Pi records as `tool_execution_end` with `isError: true` and the reason as the result text.

Fail-closed rules, each asserted against literal values in `src/gate.test.ts`:

| Path | Outcome |
| --- | --- |
| default gate (`defaultDenyGate`), unknown tool | deny: `default deny: no rule for tool <name>` |
| handler throws | deny: `gate handler threw: <message>` (never propagates) |
| dialog cancelled / timed out (`value` absent) | deny: `no gate decision: dialog cancelled or timed out` |
| malformed response JSON | deny: `malformed gate decision: ...` |
| response well-formed but `allow !== true` | deny with its reason, or `denied without a reason` |
| request with no timeout, no gate, watchdog fire, late-allow after timeout, unattributed dialog | deny/cancel |

The session drops a late `allow` that arrives after it already cancelled the dialog, and cancels
gate dialogs it cannot attribute to a known tool call.

## Live smoke

`bun packages/pi-bridge/scripts/smoke.ts` spawns real Pi with the gate extension and asks a real
model to call `freebot_smoke_echo` once. Key resolution follows gate G1: `FREEBOT_BYOK_KEY` in the
environment, or a `FREEBOT_BYOK_KEY=` line in `~/.freebot/provider.env`. The script never reads the
key value itself — `models.json` either interpolates `$FREEBOT_BYOK_KEY` or runs a `!command`
against the vault. Optional: `FREEBOT_BYOK_BASE_URL`, `FREEBOT_BYOK_MODEL`. Without a key it prints
`parked: G1 BYOK key absent` and exits 0.

## Evidence

- `bun test packages/pi-bridge` — 28 pass / 0 fail / 76 assertions.
- VERIFICATION.md row `pi-bridge`, artifact `packages/verify/artifacts/pi-bridge/<short-sha>/`.
