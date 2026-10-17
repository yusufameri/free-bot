# Providers (U1.6): the BYOK OpenAI-compatible client, the capability probe, and the save-time smoke test

Status: implementation complete, unit-test-verified over an injectable transport and the committed
replay transcript. The live half of the probe is built and parked on gate G1 while this unit ran; G1
has since opened, so the live path below is documented, run against the real endpoint, and kept out
of the gate on purpose.

Plan citations. §2.5 puts the model layer at `@earendil-works/pi-ai` plus a custom
OpenAI-compatible provider. §2.9 item 1 asks for a save-time smoke test that drives a real Pi
tool-call turn, per-connection+model capability flags learned from it, and a structured-output
fallback for weak tool callers. §2.8 carries `provider_config.capabilities`. Part 6 Phase 1 lists
the BYOK provider with a real-Pi smoke test. Part 8 gate 3 is the requirement this unit implements:
the provider smoke test is a real Pi tool-call turn, and the capability flags are learned from it.
Gate G1 (plan 9.8) supplies the one BYOK key the live half needs; without it, the replay half runs.

## Shape

```
src/client.ts      the OpenAI-compatible client, wire parsing, typed-error mapping
src/errors.ts      ProviderAuthError, ProviderRateLimitError, ProviderRefusalError,
                   ProviderMalformedToolCallError, ProviderTimeoutError, ProviderHttpError,
                   ProviderTransportError
src/transport.ts   the transport seam plus fake-response helpers
src/flags.ts       flag semantics and the pure derivation from one observed turn
src/fallback.ts    the structured-output prompt, its parser, and the recorded failure mode
src/probe.ts       the replay plan, the observed-turn probe, and the flag table
src/index.ts       the package surface
scripts/smoke.ts   the save-time smoke test, one command
scripts/cases.ts   the literal cases the artifact carries
scripts/evidence.ts  the evidence run that writes the artifact
```

`package.json` declares the two workspace packages this code imports, `@freebot/pi-bridge` and
`@freebot/verify`, and the source imports them by name. The two paths that stay relative are files
outside a package's `exports` map: `pi-bridge/extension/smoke-tool.ts` and the replay fixture.

## Client contract

`new OpenAiCompatibleClient({ baseUrl, apiKey }, { transport?, timeoutMs? })` posts to
`{baseUrl}/chat/completions` (a trailing slash on `baseUrl` is tolerated). Two calls:

- `chat(options)` returns `{ text, toolCalls, finishReason, usage }`. Each `ToolCall` carries the
  raw `arguments` string, the parsed `args`, and the `repairs` the parser applied.
- `streamChat(options)` yields `text_delta` and `tool_call_delta` events as they arrive, then one
  `completed` event carrying the same `ChatResult`. Tool-call arguments are joined across deltas by
  index before they are parsed.

`options` carries `model`, `messages`, optional `tools`, `toolChoice`, `responseFormat`
(`"json_object"`), `maxTokens`, `timeoutMs`, and `signal`. `timeoutMs` bounds each network step of
one call, not the whole call.

Typed failures, mapped at the boundary:

| Wire | Error |
| --- | --- |
| 401, 403 | `ProviderAuthError` with the status and the provider's message |
| 429 | `ProviderRateLimitError` with `retryAfterMs` from the `retry-after` header or a body `retry_after` |
| other non-2xx | `ProviderHttpError` with the status and the body |
| `refusal` on the message, or `finish_reason: content_filter` | `ProviderRefusalError` with the raw refusal |
| tool-call arguments that are not a JSON object | `ProviderMalformedToolCallError` with `toolName` and `rawArguments` |
| a step past its deadline | `ProviderTimeoutError` |
| a body that is not JSON, a dead socket | `ProviderTransportError` |

### Malformed tool-call shapes

The parser is read against a table in the artifact, one line per shape. It reads a missing or blank
`arguments` as `{}`, reads arguments that arrive as an object rather than a string, strips a
markdown fence, keeps the first balanced JSON object when prose or a second object surrounds it,
and respects escaped quotes. A trailing comma, a bare array, a truncated object, a non-object, and
text with no object at all are typed failures that carry the text that arrived. A trailing comma
stays a failure on purpose: repairing it silently would hide a caller that cannot emit JSON.

## The capability probe

Flags come from one observed turn. Nothing is inferred from the model name, and an unobserved fact
is recorded as unknown.

The probe's steps:

1. Resolve the connection. Live, the caller supplies `baseUrl` and `model`; keyless, the recorded
   transcript supplies both.
2. Ask Pi for the model list (`get_available_models`) and read the entry with this provider and
   model. That is where `contextWindow` comes from, when Pi lists one.
3. Drive one tool-call turn through the bridge. Live, that means `pi --mode rpc` with the Gate 1
   intercept and the echo tool, asked to call the echo tool once. Keyless, it means replaying the
   recorded turn out of `packages/pi-bridge/fixtures/rpc-handshake.jsonl` through
   `createReplayTransport`, writing the two recorded commands and draining the recorded frames.
4. Observe the turn's frames. `toolcall_end` counts the native calls the model emitted,
   `text_delta` and `toolcall_delta` count the incremental evidence, `tool_execution_end` records
   whether each call ran, and `agent_settled` marks the turn's end.
5. Derive the flags from that observation, plus the structured-output observation when the path was
   exercised. A Pi prompt request carries no `response_format` (`packages/pi-bridge/src/frames.ts`),
   so the turn never supplies that observation: only a direct `response_format: json_object`
   request does, which the live smoke makes when the key is in the environment.

The replay half adds one bound to be honest about. `planReplayTurn` selects the first recorded
prompt block that ran a tool successfully, plus the recorded model-list exchange, and hands only
those frames to the transport. Later turns in the transcript are not replayed. The artifact prints
the two commands the probe wrote.

### Flag semantics

| Flag | Meaning |
| --- | --- |
| `toolCalling` | `strong` when the turn carried a native tool call, `weak` when a structured reply the fallback converts was the only tool call, `none` when neither happened. The gate's later verdict does not change this: a native call the gate denies is still a native call. |
| `streaming` | `true` when the turn delivered incremental deltas, `false` when the turn delivered whole messages and no deltas, `null` when the turn carried no assistant message. |
| `structuredOutput` | `true` when the connection answered a `response_format: json_object` request with parsable JSON, `false` when it answered and the reply did not parse, `null` when the path was not exercised. |
| `contextWindow` | The `contextWindow` of the model entry Pi listed for this connection, or `null`. |
| `notes` | The literal evidence: which tool call was observed, how its execution ended, which flag is unknown and why. |

The turn never sets `structuredOutput`: a Pi prompt request carries no `response_format`, so only a
direct request exercises the path. The live probe makes one when the key is in the environment. A
vault-only key leaves the flag unknown: this probe does not read key values out of the vault file.

## Structured-output fallback for weak tool callers

`structuredToolMessages(tools, task)` sends one system instruction and one user message carrying
the tool specs and the task. The instruction asks for exactly one JSON object, `{"tool": "<name>",
"arguments": {…}}` to call a tool, `{"tool": null, "text": "…"}` for prose.

`parseStructuredReply(raw)` returns one of three things. `tool_call` carries the name, the argument
text, the parsed args, and any repairs (a fenced reply, prose around the object, or the
`{name, arguments}` spelling a weak caller invents). `text` is the model saying no tool is needed.
`invalid` carries the reason and the raw reply: no JSON object, an incomplete object, no tool key,
or arguments that did not parse.

`runStructuredToolTurn(client, options)` runs one turn and returns `{ reply, failure }`.
`failure` is non-null whenever the reply was `invalid`, including when the client itself failed, so
the caller records the failure mode instead of retrying blind. The artifact carries one literal per
shape, successes and failures side by side.

The control plane consumes this module when a connection's flags say `weak`. Wiring the fallback
into the run loop belongs to the run unit, not here.

## Key handling

Keys live in the vault path and nowhere else (order 8).

- The smoke and the probe never print a key and never put one in a file. Their reports carry
  `keyPresent` as a boolean.
- Live key resolution follows gate G1 the same way the pi-bridge smoke does it: `FREEBOT_BYOK_KEY`
  in the environment, or a `FREEBOT_BYOK_KEY=` line in `~/.freebot/provider.env`. The vault value
  stays in the file and is interpolated by Pi's own `$…` and `!command` support in `models.json`.
- The direct structured-output step needs the value in memory, so it runs only when the key is in
  the environment. With a vault-only key the probe reports `structuredOutput: null` and names why.
- Tests make no live calls. The client takes an injectable transport, and the one test that drives
  the real transport points it at a loopback `Bun.serve` fake provider.
- The evidence run scans the artifact and `packages/providers` for key-shaped literals and fails on
  a hit. It reports 0.

## The one command

Deterministic, and the step the evidence gate runs. Green with or without a key, against the
committed replay transcript:

```
bun packages/providers/scripts/smoke.ts --replay
```

Live. Gate G1 is open, so the vault key is there and this path runs. It is a deliberate step and never
the gate: with a key present, the same command without `--replay` selects live mode, which needs a
base URL and a model, so a key on the machine would decide whether the gate passes.

```
bun packages/providers/scripts/smoke.ts <baseUrl> <model>
```

`<baseUrl>` and `<model>` come from `FREEBOT_BYOK_BASE_URL` and `FREEBOT_BYOK_MODEL`. Leave the key in
`~/.freebot/provider.env`: the smoke hands Pi the `!command` that reads it, so no key value enters the
smoke's environment, its `models.json`, or its report. One consequence of that choice: the direct
`response_format: json_object` step runs only when the key is in the environment, so a vault-only run
reports `structuredOutput: unknown` and names why.

`--replay` forces the replay path on a keyed machine. `--fixture <path>` points the replay at
another recorded transcript. Exit codes: 0 when the observed turn can drive Pi (`strong` or
`weak`), 1 when it cannot (`none`), 2 on a usage error.

## Evidence

- `bun test packages/providers` covers the client, the error mapping, the argument parser, the
  fallback, the flag derivation, and the replay probe.
- The artifact at `packages/verify/artifacts/providers/<short-sha>/assert.txt` carries the
  capability table, the malformed shapes, the error shapes, the fallback literals, and the key
  scan, with every observation line labelled `[replay]` or `[live]`.
- Every row in the artifact is asserted against an expected literal, so a regression in the status
  mapping, the `retryAfterMs` arithmetic, or the fallback's reading of a reply fails the run
  instead of printing PASS.
- The VERIFICATION.md row names the injectable transport and the replay-mode probe as the live
  surface, and states that the live-provider run is gate-bound on G1.
