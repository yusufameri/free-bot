# Page 1: connect a provider

Status: `live-ui-verified` at commit `7e63e57`, driven by
`bun packages/verify/scripts/provider-setup.ts`, with the transcript under
`packages/verify/artifacts/provider-setup/7e63e57/assert.txt`. Six states are committed beside it:
no provider yet, testing, capable saved, a reply with no tool call, a refused key, and a run driven by
the connection the page saved.

This is `UX.md` page 1 and flow A: the first page a new person sees, and the surface that makes
setting up a model a form rather than a file edit.

## What a person does

The app opens on the page when `~/.freebot/provider.env` holds no key. The page takes a base URL, a
model, and a key. `Save and test` writes the key to the vault, then makes one real request that
carries a tool definition and reads the reply. Four outcomes, and the page shows which one happened:

| Outcome | What the page stores | What it says |
| --- | --- | --- |
| A tool call in the reply | `capable`, with the flags the turn produced | `This connection is capable` plus the model's own answer from the test turn |
| A reply with no tool call | `limited`, with the structured-output observation | `This connection answers, without a tool call`, and that runs will use the fallback |
| A refusal from the provider | `untested`, with the status code and the message | `The connection did not pass its test` |
| Nothing saved yet | nothing | The three fields, `Save and test`, and the quiet `Run in replay mode` |

`Run in replay mode` writes nothing and needs no key: it moves to the conversation with the vault
still absent, which is what makes every run in it replay the committed transcript. It exists so a
person can see the product work before holding a key.

The sidebar footer carries the active connection (`deepseek/deepseek-v4.1-flash · capable`) and is the
way back to this page. The page says what a further save would replace, naming the connection in the
vault, before the button is pressed.

## Where the key goes

Two files, both mode 600, and the split is the design.

| File | Holds | Never holds |
| --- | --- | --- |
| `~/.freebot/provider.env` | `FREEBOT_BYOK_KEY`, the base URL, the model | anything else |
| `~/.freebot/provider.json` | the endpoint, the model, the status, the flags, the refusal, the model's answer | the key |

`apps/server/src/vault.ts` owns both sides of the vault file: `readVault` is the run path's only
reader and `writeVault` is the app's only writer, which chmods to 600 after every write rather than
trusting `writeFileSync`'s mode, because that mode applies to a create only. `readVault` reads the
file itself and never the process environment (order 8), so a key is visible to exactly one
`Authorization` header and not to a child process or `ps`.

`apps/server/src/provider-setup.ts` writes the record and answers `get_provider` from the two files
together. It parses the record at that boundary rather than trusting a file's shape, and it refuses
to believe a record measured on another endpoint: a vault a person edits by hand moves the connection
underneath the flags, so a mismatch reads as `untested`. That is what keeps a stale `capable` from
outliving the connection it was measured on.

Nothing returns a key to a client. `providerConnectionSchema` has no field for one, and the router's
own output validation strips an unknown key rather than passing it through, which
`packages/protocol/src/dto.test.ts` asserts.

## The test

`packages/providers/src/capability.ts` runs it, over the same `OpenAiCompatibleClient` the run path
uses. One streaming request carrying the `freebot_smoke_echo` tool, then the tool's own result back
so the closing reply is observable, then the structured-output fallback when no call arrived. The
flags come from `deriveFlags` over the observed turn, the same derivation `packages/providers`' Pi
smoke uses, and never from the model's name.

Two shapes it handles that a caller would otherwise lose:

- An endpoint that answers whole bodies ignores `stream: true` and returns a body with no SSE
  records, which the client reads as an empty reply. That empty reply is caught and the request is
  made again without streaming, so the reply's text and tool calls are read rather than dropped, and
  the turn reports `streaming` unknown instead of the `false` the connection never earned.
- A credential refusal is never retried by that path. `ProviderAuthError` and `ProviderRateLimitError`
  carry the provider's status code straight to the page.

## Limits

- `contextWindow` is always unknown from this test: it reads one reply, and only Pi's model list
  reports a window. The flag says so in its own note rather than guessing.
- A key with a newline is refused at the contract boundary, because the vault is one `KEY=value` per
  line and a value that spans lines would rewrite the file.
- The page is page 1 only. `UX.md` page 2's first-run moment is not built: after a passing test the
  page offers `Continue to your Bots` and the existing shell creates the first Bot.
- A refused connection is saved, on purpose. The next run then fails with the provider's own words
  instead of quietly replaying a recording, which is the one failure this surface exists to prevent.

## Follow-ups

1. `UX.md` page 2, the first run. The passing state hands off with a Bot to create and a suggested
   first task, and none of that copy exists yet.
2. The settings page's provider pane (`UX.md` page 14) wants one row per connection with `Test again`,
   `Set as active`, and `Remove`. This unit owns the active connection only, and it is one slot.
3. `Test again` re-runs `connectProvider` with the key already in the vault, so the route needs a keyless
   variant that reads the vault and re-derives the flags. The probe and the record are ready for it.
4. The capability test could observe `contextWindow` by asking Pi for its model list, which is what
   `packages/providers/scripts/smoke.ts` does. That would make the flag useful and would put a Pi
   process in the save path, which is why it is not here.

## A related fix this unit had to make

`apps/web/scripts/one-run-path.ts` asserts that the first run it starts is `run-1`. It boots
`apps/server/src/index.ts`, which resolved its bots root from the freebot home and ignored
`FREEBOT_WORKSPACE`, so that driver ran over the machine's own `~/.freebot/bots`. The assertion
passed only while that directory was empty: at this commit it read `run-3` on this branch and `run-5`
on `main`, the id being whatever the accumulated journals pushed the serial to. `resolveBotsRoot` now
reads `FREEBOT_WORKSPACE` the way `bun run up` already did by passing the option through, so a driver
that points the variable at a scratch directory gets a scratch directory. The driver passes 54/54
with that in place.
