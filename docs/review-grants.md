# Review grants (U0.8): canonical action hashes, an append-only ledger, a fail-closed gate

Status: implementation complete, unit-test-verified. This package is the consent layer that forge
test A leans on: a gated tool call cannot authorize unless a matching grant exists in this ledger,
so killing or forging the in-VM agent changes nothing (plan finding 11).

Provenance, per plan findings 11, 17, 37, and 38:

- Finding 11. Approvals are a control-plane invariant. The in-VM agent is an untrusted reporter;
  the gate consults a control-plane ledger, and the sandbox cannot mint consent.
- Finding 17. Grants bind to a canonical action hash of (tool, normalized args), so an approval
  for one action never authorizes a different one after the args change.
- Finding 37. Rewind tombstones grants past the rewind point. Rewound history never authorizes.
- Finding 38. The ledger holds grants only. Idempotency keys are a separate concern with their own
  table, out of scope here.

## Shape

```
src/grants.ts    grant record, canonical JSON, canonical action hash, boundary parser
src/store.ts     append-only GrantStore with replay, rewind, JSONL persistence
src/policy.ts    createGrantPolicy(store, opts) -> pi-bridge ToolGate
src/scenario.ts  hand-driven walkthrough; prints a transcript and a RESULT line
```

The package depends on `@freebot/pi-bridge` for gate types only (a type-only import). The bridge
owns the transport and the dialog protocol; this package owns the decision.

## Grant record

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Grant identity, unique. `grant-<seq>` unless the caller overrides it. |
| `seq` | `number` | Ledger sequence assigned at issue. Consume and tombstone versions repeat it. Rewind compares against it. |
| `issuedAt` | `number` | Epoch milliseconds. |
| `expiresAt` | `number` | Epoch milliseconds. The grant is live while `now < expiresAt`. |
| `actionHash` | `string` | `v1:sha256:<hex>` of (toolName, normalizedArgs). |
| `toolName` | `string` | The tool the grant is for. |
| `normalizedArgs` | `JsonValue` | The canonical argument tree: recursive key sort, array order kept. |
| `consumedBy` | `string \| null` | The `toolCallId` of the call that consumed the grant. |
| `tombstoned` | `string \| null` | Tombstone reason, for example `rewind:12`. |

The log is append-only. `issue`, `consume`, and tombstoning each append a full version of the
record; records are frozen, never edited. Current state is derived by replay: the last version per
id wins. `packages/verify/artifacts/review-grants/` captures a run where a reloaded log reproduces
the exact state.

## Canonical action hash

The hash is `v1:sha256:` plus the SHA-256 (via `Bun.CryptoHasher`) of the canonical JSON of
`{ args, tool }`. The `v1:` prefix versions the normalization rules: any change to them must change
the prefix, since persisted hashes would otherwise silently change meaning.

`canonicalizeJson` normalizes, and refuses, this much:

| Input | Behavior |
| --- | --- |
| Object key order | Normalized: keys sort ascending by UTF-16 code unit at every nesting level. |
| Array order | Not normalized. Tool arguments are positional; `["a","b"]` and `["b","a"]` are different actions and hash differently. |
| Number text form | Collapses through JS number semantics (`1e2` and `100` are one number by the time the hash sees them). |
| `-0` | Refused. JSON stringifies it as `0`, which would collide with a different value. |
| `NaN`, `Infinity` | Refused. JSON.stringify would coerce them to `null`. |
| `undefined` | Refused, including array holes and object values. |
| `bigint`, functions, symbols | Refused. Not JSON. |
| `Date`, `Map`, class instances | Refused. Only plain objects and arrays; a `toJSON` would change meaning under the hash. |
| String content | Not normalized: no Unicode normalization, no case folding, no trimming. NFC and NFD spellings of the same word hash differently, and the unapproved spelling denies. |
| `__proto__` as a key | Kept as data. The canonical tree is built with a null prototype, so the key cannot reach a prototype setter. |

A refusal is the fail-closed direction: the gate answers `malformed_action` and denies.

## State machine

```
            issue
              |
              v
           [ live ] --consume(toolCallId)--> [ consumed ]   (never authorizes again)
              |
              |--expiresAt <= now -----------> [ expired ]   (derived from the clock; no record)
              |
              `--rewind(seq < grant.seq)-----> [ tombstoned ] (never authorizes again)
[ consumed ] --rewind(seq < grant.seq)-------> [ tombstoned ] (consumption history kept)
```

Only a live grant authorizes. Expiry appends nothing: the clock derives it, so the ledger stays a
record of facts, not of wall time. Rewind and consume append versions; nothing is edited or
deleted. A rewind is idempotent.

## Pi bridge integration point

`createGrantPolicy(store, { tools?, now? })` returns a `ToolGate` from `@freebot/pi-bridge`, the
same contract the Pi extension consults over the dialog protocol (`input` request with the call as
JSON, decision as JSON back, mandatory timeout, every failure a denial). The later live-path unit
passes this policy where the bridge expects a gate; nothing in the bridge changes.

- `tools` lists the tool names the gate governs (the bot's allowlist). Anything else denies
  `unknown_tool` even if a grant exists for it. Omit the option to govern every tool name.
- `now` overrides the clock for tests.
- `store` can be shared: the allow path consumes synchronously, so two gates over one store cannot
  consume the same grant twice.
- The policy never throws. If a handler does throw somewhere else, the bridge already converts it
  to a denial (`decideToolCall` in `packages/pi-bridge/src/gate.ts`); that is the second net, not
  the primary one.

## Fail-closed table

Each row is asserted against literal expected values in `packages/review/src/policy.test.ts` and
replayed in the scenario transcript.

| Path | Decision | Where tested |
| --- | --- | --- |
| Tool outside the governed list | `unknown_tool: <name> is not a governed tool` | `unknown tool: outside the governed list, even with a grant` |
| No grant for the tool at all | `no_grant: no grant for action <hash>` | `no grant: the tool has never been granted` |
| Grant for the tool, not for these args | `grant_mismatch: args differ from grant <id> for tool <name>` | `grant mismatch: a grant for the tool exists, none for these args` |
| Matching grant expired | `grant_expired: grant <id> expired at <iso>` | `expired: valid strictly before expiresAt, denied at it` |
| Matching grant consumed | `grant_consumed: grant <id> consumed by <call>` | `allows the granted action once and consumes its grant` |
| Matching grant tombstoned | `grant_tombstoned: grant <id> tombstoned by <reason>` | `tombstoned: a rewind past the grant removes its authority` |
| Record hash disagrees with its content | `grant_forged: grant <id> hash does not match its content` | `forged: a record whose hash disagrees with its content never authorizes` |
| Args that are not canonical JSON | `malformed_action: <canonicalization error>` | `malformed action: args that are not canonical JSON` |
| Any store failure | `grant_store_error: <message>` | `store failure denies instead of propagating` |

The six core codes are asserted distinct in `the six fail-closed flows carry six distinct codes`.
The shared-store double-spend case is `two policy instances over one store cannot double-spend a
grant`.

## Not in this unit

- Production persistence. `GrantStore` is in-memory plus JSONL reload; the Postgres table and the
  live-path wiring land in later units.
- Idempotency keys, per finding 38. They get their own table keyed by (actor, key).
- TTL policy decisions (who picks `ttlMs`) and the approval UI that mints grants.
- Taint and batching, findings 11-adjacent: this gate answers per call.

## Evidence

- `bun test packages/review` — 57 tests, 100 assertions, all green.
- `bun packages/review/src/scenario.ts` — hand-driven transcript, RESULT: PASS (11/11).
- Artifact `packages/verify/artifacts/review-grants/<short-sha>/assert.txt`.
