# Pi RPC spike (U0.2): the harness exists, and every tool call funnels through one hook

Status: spike complete, keyless. No model key was used or needed. Proportionality note: every claim
below cites either the committed transcript, the committed `--help` capture, the pinned package's
own docs, or a line of its shipped code. Transcript line citations look like `L52` and refer to the
committed run in `packages/pi-bridge/fixtures/rpc-handshake.jsonl` described below.

## Provenance

- Package resolved from npm: `@earendil-works/pi-coding-agent`, dist-tag `latest` = `1.3.0`,
  published 2026-10-15. Pinned without a caret in `packages/pi-bridge/package.json`.
  `integrity: sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==`
  (registry metadata, `curl registry.npmjs.org/@earendil-works%2Fpi-coding-agent/1.3.0`).
  A second dist-tag `legacy-node20` = `0.74.2` exists for Node 20 users; `latest` requires
  `engines.node >= 22.19.0`.
- CLI binary: `bin.pi` -> `dist/bundle/cli.js` (shebang `#!/usr/bin/env node`). This machine ran it
  under node `v24.21.0`; the drive harness itself ran under bun 1.2.5, header line `L1`.
- Transcript: 248 JSONL lines, one object per line, first line a header with pi version and
  platform (`L1`: `piVersion 1.3.0`, `platform darwin-arm64`, `node v24.21.0`, `bun 1.2.5`).
  Every line carries `dir`: `bridge->pi`, `pi->bridge`, `stub` (HTTP requests the stub model
  received), `check` (39 assertions, all true in the committed run), `pi-stderr`, or `note`.
- Help capture: `packages/pi-bridge/fixtures/help.txt` (`pi --version`, `pi --help`, and
  `pi --mode rpc --help`, which is the same option surface).
- Reproduce: `bun install && bun spikes/pi-rpc/drive.ts` from the repo root. The driver exits
  non-zero if any assertion fails; it writes both fixtures itself.
- Spawned command, recorded at `L2`:
  `pi --mode rpc --no-session --offline --no-approve --no-builtin-tools --provider stub --model stub-1 -e spikes/pi-rpc/gate-ext.ts`
  with `HOME` pointed at `spikes/pi-rpc/scratch/home` and `PI_CODING_AGENT_DIR` at
  `spikes/pi-rpc/scratch/agent` (hermetic; the user's `~/.pi` is untouched).
- The "model" is `spikes/pi-rpc/stub-model.ts`, a keyless local OpenAI-compatible SSE server
  written for this spike. It plays a scripted tool call per prompt and echoes back the tool result
  it received. This is the plan's replay-stub shape (finding 13), exercised on a real Pi process.

## The npm package exists as the plan appendix claims

The appendix says Pi is `@earendil-works/pi-coding-agent`, MIT, TypeScript, with RPC mode
(`pi --mode rpc`, JSONL). All confirmed against the published 1.3.0 tarball:

- MIT license, `bin.pi`, `engines.node >= 22.19.0`, homepage `github.com/earendil-works/pi`.
  (`0.74.0` metadata pointed at `pi-mono`; the repo was renamed. Not load-bearing.)
- The tarball ships the protocol documentation under `docs/`: `rpc.md`, `rpc-commands.md`,
  `json.md`, `rpc-extension-ui.md`, `extensions.md`, `models.md`, `providers.md`, `sdk.md`, plus
  `examples/rpc-client.ts` and `examples/extensions/` (including `permission-gate.ts` and
  `tool-override.ts`). The plan appendix's "four modes: TUI, print/JSON, RPC, SDK" matches
  `help.txt` (`--mode text|json|rpc`, `--print`, SDK in `docs/sdk.md`).

## RPC mode works as documented, keyless

`pi --mode rpc` is a long-lived subprocess speaking strict JSONL on stdin/stdout. Verified live:

- **Framing.** One JSON object per LF-terminated line, no framing metadata. `rpc.md` warns to split
  on LF only (not `readline`, which also splits on U+2028/U+2029). The driver reads stdout as a byte
  stream and splits on `\n`. Stderr is diagnostics only; this run produced zero stderr lines
  (`L246: "stderrLines":0`).
- **Commands are client-issued, responses are correlated by `id`.** `{"id":"state-1","type":"get_state"}`
  (`L3`) answers `{"id":"state-1","type":"response","command":"get_state","success":true,...}` (`L4`).
- **Malformed JSON produces a `parse` response with no id** (`L9`:
  `Failed to parse command: Unexpected end of JSON input`). The bridge must treat id-less parse
  responses as a protocol error signal.
- **Command failures are `success:false` with an `error` string**, e.g. `set_model` for an unknown
  model (`L17` -> `L18`: `Model not found: not-a-provider/nope`).
- **Discovery works without a model.** `get_commands` lists extension commands (`L11` -> `L12`,
  `gate-info`, `source:"extension"`); `get_available_models` lists the `models.json` provider
  (`L14` -> `L15`, `stub-1`/`stub`).
- **Prompt acceptance is not completion.** The prompt response carries
  `data.disposition` (`L35`: `"started"`; extension commands return `"handled"` with no run,
  `L27`). One run emits `agent_start`, `turn_start`, message and tool events, `turn_end`,
  `agent_end`, and finally `agent_settled` (`L37` .. `L66`). `rpc.md` is explicit that retries,
  compaction, steering, or follow-up work can continue after `agent_end`; `agent_settled` is the
  only "Pi will not continue automatically" signal. The bridge should treat `agent_end` as
  turn-budget accounting and `agent_settled` as the run boundary.
- **RPC also accepts client-issued commands beyond prompting**, notably
  `bash` (`L20`): `{"id":"bash-1","type":"bash","command":"echo native-bash-no-model"}` streams
  `bash_execution_update` frames (`L21`) and a final response with `output`/`exitCode` (`L22`).
  This is the control plane asking Pi to run shell directly. It is not a model tool call: it
  produces no `tool_execution_*` frames (`L20-L24`). Since the bridge is the only RPC client, this
  surface is mediated by construction (the bridge decides to send it), but it is a second native
  execution surface to gate in the bridge, alongside the model-issued path.
- **Shutdown is stdin close.** `stdin.end()` produced orderly exit code 0 (`L246`). No hang.

## How tool calls look on the wire

A model-issued tool call appears in three shapes, in order:

1. **Streaming.** `message_update` frames with `assistantMessageEvent` `toolcall_start` /
   `toolcall_delta` / `toolcall_end` (the blocked turn, `L46`-`L49`). This is where the bridge can
   surface "the model is calling X with args Y" to the UI before anything runs.
2. **The assistant message.** `message_end` with `content:[{type:"toolCall",id,name,arguments}]`,
   `stopReason:"toolUse"` (`L50`).
3. **Execution.** `tool_execution_start` (`L51`), optionally `tool_execution_update`, then
   `tool_execution_end` with `result`, `isError`, and `durationMs` (present only when `execute()`
   actually ran). Then the tool result message (`message_start`/`message_end` with
   `role:"toolResult"`), `turn_end`, and the next model request.

A gate decision does not change this shape. A blocked call still emits
`tool_execution_start`/`tool_execution_end`, but with the block reason as the content,
`isError:true`, and **no `durationMs`** (`L52`: `gated_blocked` blocked). The blocked reason is what
the model sees as the tool result (`L57`: stub request 2 received
`blocked by gate-spike: always deny`). For the bridge, `isError:true` plus no `durationMs` plus a
block-reason sentinel identifies "gated open loop closed" versus "tool ran and failed".

## Interception: the single choke point is real (Gate 1 evidence)

Pi installs `beforeToolCall` and `afterToolCall` hooks on its agent loop
(`dist/core/agent-session.js`, `_installAgentToolHooks`) and dispatches every tool call through the
extension `tool_call` handlers before execution (`dist/core/agent-loop.js` `prepareToolCall`: tool
lookup, argument validation, then the hook; a `block: true` result becomes an error tool result
with the reason). One extension registering one `tool_call` handler is therefore the single
intercept for every tool invocation that reaches Pi's tool pipeline. Measured in this spike:

- **Deterministic deny works end to end.** `gate-ext.ts` returns
  `{block: true, reason: "blocked by gate-spike: always deny"}` for `gated_blocked`. The wire shows
  tool result `L52`, the model read the reason `L57`, and the tool's own `execute()` never ran
  (its output string, `"gated_blocked executed; the gate failed"`, appears nowhere in the
  transcript).
- **Operator approval works end to end, over RPC.** For `gated_confirm` the handler awaits
  `ctx.ui.confirm`, which leaves Pi as an `extension_ui_request` frame and blocks until the client
  answers with `extension_ui_response`. Deny: request `L119`, response
  `{"confirmed":false}` `L120`, tool result `"denied by operator"` `L121`, model informed `L127`.
  Allow: request `L156`, response `{"confirmed":true}` `L157`, tool result
  `"gated_confirm executed (mode=allow)"` `L158`. This is the control-plane approval gate the plan
  needs: the decision is made by the RPC client, and Pi cannot proceed without it. Dialog requests
  support a `timeout` field for auto-resolution (`docs/rpc-extension-ui.md`), which the bridge
  should set so a dead control plane fails closed.
- **Nested calls hit the same hook.** `gate_demo_runner` calls `ctx.executeTool("gated_echo", ...)`.
  The wire shows the nested start `L191` (`toolCallId "call_stub_9/1"`, `parentToolCallId
  "call_stub_9"`), its end `L192`, and the outer end `L193`. `docs/extensions.md` states nested
  calls go through argument validation and the `tool_call`/`tool_result` handlers like
  model-issued calls, and `ctx.executeTool()` never rejects for blocked calls, it returns
  `isError:true`. So the gate cannot be bypassed by a tool that runs other tools.
- **Fail-safe direction.** A `tool_call` handler that throws blocks the call rather than letting it
  proceed (`docs/extensions.md`, and the agent-loop catch path in `prepareToolCall`). Handler
  exceptions also surface as an `extension_error` RPC event (`docs/json.md`). The bridge's gate
  extension should therefore treat "cannot ask the control plane" as block, not allow. (Asserted
  from shipped code and docs; not exercised in this run.)
- **Tool results are also interceptable.** `tool_result` handlers compose and can replace content,
  in order (`docs/extensions.md`). That is the seam for taint-marking tool output as untrusted
  (plan findings 18/35) before it enters the transcript.

## Disabling or redirecting the native execution surfaces

Three independent levers exist; the spike used the first two:

- **`--no-builtin-tools`** disables `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`,
  `ls` while keeping extension tools. Measured: the `/gate-info` notify reports
  `activeTools:[gated_echo,gated_blocked,gated_confirm,gate_demo_runner]` with `bash` absent
  (`L26`), and a model attempt to call `bash` produced `Tool bash not found` with no execution
  (`L227`, no `durationMs`). Also available: `--tools` (allowlist), `--exclude-tools` (denylist),
  `--no-mcp`, `--no-extensions` (explicit `-e` still loads), all in `help.txt`.
- **Override built-ins by name.** An extension can re-register `bash`/`read`/`write`/`edit` with
  the same name and its own `execute()` (`examples/extensions/tool-override.ts` in the tarball;
  the docstring says overrides are for "implementing access control or sandboxing" and "routing
  tool calls to remote systems"). This is the mechanism for the plan's "Pi emits execution intents,
  the sandbox-agent performs after grant": keep the tools model-visible, but have them emit an
  intent over a side channel and refuse local execution.
- The RPC `bash` command (`L20`) remains as a deliberately client-issued surface; the bridge gates
  it, since only the bridge can send it.

With `--no-builtin-tools` plus registered intent tools only, Pi has no unmediated native execution
surface left: every path that can touch the filesystem or shell is a tool call through the
`tool_call` hook, and the hook runs before execution for every call including nested ones.

## Provider config shape, and where a live model is required

- Cloud keys are optional at the harness level. `models.json` (at `PI_CODING_AGENT_DIR` or
  `~/.pi/agent`) declares compatible endpoints, e.g. this buttoned-down stub
  (`spikes/pi-rpc/drive.ts`):
  `{ "providers": { "stub": { "baseUrl": "http://127.0.0.1:PORT/v1", "api": "openai-completions",
  "apiKey": "keyless-stub-literal", "models": [{ "id": "stub-1", "name": ..., "input": ["text"],
  "contextWindow": 128000, "maxTokens": 4096, "reasoning": false, "cost": {...} }] } } }`.
  `apiKey` accepts a literal, `$ENV`/`${ENV}` interpolation, or `!command` output
  (`docs/models.md`, `docs/custom-provider.md`). The FreeBot egress-proxy replay stub slots in
  here: the control plane points `baseUrl` at the proxy's OpenAI-compatible endpoint and the
  provider layer needs no other change.
- Model selection is per invocation (`--provider`/`--model`), or live via the `set_model` /
  `cycle_model` RPC commands; `get_state` returns the full selected model object (`L4`).
- **Where a live model is required:** anywhere the fidelity of real provider streaming and
  tool-calling matters. This spike proves the protocol, the gate, and the containment config
  against a stub; it does not prove that a given real model emits well-formed tool calls on the
  first try (plan finding 2, the smoke-test unit), nor OAuth `/login` flows, nor prompt-cache
  warming behavior. Nothing else observed here needs a key.

## Gate 1 verdict

**Can a single intercept observe and gate every tool invocation? Yes on the evidence captured, with
one named unknown.** Pi dispatches every tool call through the extension `tool_call` hook before
execution: model-issued calls (deny `L52`, allow `L85`), operator-confirmed calls across the RPC
boundary (`L119`-`L121`, `L156`-`L158`), and nested `ctx.executeTool` calls (`L191`-`L192`). A
block is enforced by Pi itself, before `execute()`, with `isError:true` and no `durationMs`, and a
throwing handler blocks by design, so the failure mode is fail-closed. The native surfaces that
made the plan's finding 31 scary are removable by configuration: with `--no-builtin-tools` the model
cannot even name `bash` (`L227`), and by-name tool overrides can turn built-ins into intent
emitters. What remains unproven here is only the real-provider link: this run's model was a keyless
local stub, so "a real provider's first-turn tool call arrives intact and fires the same hook" is
expected but not yet measured. That is exactly the keyed smoke-test unit (Gate 3 per plan 9.8). No
evidence here contradicts Gate 1; the control-plane approval requirement from finding 11 maps
cleanly onto `extension_ui_request` / `extension_ui_response`, with the in-VM side unable to
self-approve.

## Unknowns and follow-ups for the bridge unit

- Real-provider tool-call fidelity (needs the parked key). The stub proves wiring, not providers.
- `user_bash` (the `!` prefix path) has a handler (`docs/extensions.md`) but was not exercised in
  RPC mode. Decide whether the bridge disables it via `--no-extensions` plus its own extension, or
  handles it.
- MCP servers were not enabled in this run; `docs/extensions.md` says MCP tools carry annotations
  and flow through the same tool commands, but the bridge should re-run this harness once one MCP
  server is connected, because plan finding 19 routes stdio MCP to the control plane.
- A throwing `tool_call` handler blocking is doc/code-verified, not measured; add a one-line
  assertion to `drive.ts` when convenient.
- `get_state.data.model` is a full model object; the bridge can use it to record
  `{provider, model}` per run for finding 22/27 replay pinning.
- The control plane must answer approval dialogs with a `timeout` set, so a dead bridge blocks
  rather than parks forever (`docs/rpc-extension-ui.md`).
