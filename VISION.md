# FreeBot vision

FreeBot is an open-source agent that works inside a real computer instead of answering from a chat box. Each Bot is a named agent with its own sandbox container, its own filesystem, and its own shell. You reach it from a web page. When the agent wants to do something that changes the world, it stops and asks, and the run continues from your answer.

The shape comes from Grok Bot, and two parts of that shape are opened up. Grok Bot fixes which model runs and which machine the work happens on. FreeBot keeps the product shape and makes both pluggable. Any OpenAI-compatible `/v1/chat/completions` endpoint can drive a Bot, including a key you already pay for or a model running on your laptop. One `SandboxProvider` interface runs the container on Docker today and on E2B, boat.dev, or Firecracker later. Local single-user mode needs no hosted component at all.

## What a person can do with it

- Start it with one command. `bun run up` boots the server and the page, prints a single URL with the operator token in its fragment, and opens it.
- Type a prompt and watch it work. The model's words stream into the page, and every tool call appears as a card carrying the exact command it wants to run.
- Answer the gate. Allow once executes the call in the sandbox and shows the container's own output. Deny records `user_denied`, runs nothing, and the run still finishes.
- Bring a model or bring none. A key in `~/.freebot/provider.env` makes every run a real model turn. A keyless machine replays a committed transcript, so tests and demos cost nothing and repeat exactly.

## The rules that settle arguments

1. Bring your own model. FreeBot targets the OpenAI-compatible contract and assumes no vendor.
2. Do not rebuild the agent loop. Pi is the agent, and it runs inside the sandbox where its tools operate on real files.
3. The sandbox is an interface. Docker locally and a hosted provider at scale are the same contract to the rest of the system.
4. The server is optional. Local mode must work when nothing outside this machine is running.
5. Guardrails ship with the feature they guard. Approvals, review policy, and egress rules are never a later pass.
6. Evidence beats a claim. A feature is done when a script drives the real product and writes down what it saw.

## What counts as done

A feature does not become done when its code merges. It becomes done when a script anyone can run drives the real product and commits what it observed to `packages/verify/artifacts/<feature>/<short-sha>/`. Those artifacts hold the assertions, the output, and screenshots captured during the run. `docs/VERIFICATION.md` carries one row per verified feature with the commit the artifact came from and a verdict of `live-ui-verified`, `unit-test-verified`, or `type-check-only`. CI green is an input to that verdict and never the verdict itself.

The long-term bar runs in three tiers. Every commit gets deterministic replay and screenshot comparison through Playwright, plus emulator-backed connector tests. Every night, real test accounts get driven for the services that allow it, and a judge model scores agent behavior. Arbitrary third-party MCP servers and arbitrary models cannot be held to that bar, so the documentation labels them as outside it rather than implying otherwise.

## What FreeBot refuses

- Training or serving base models.
- Requiring anything hosted for the local product. The MVP ships with no hosted component to run.
- Vendor types above an adapter. MCP is the connector wire, and Composio is one adapter behind that interface.
- Keys in the repository, in the sandbox, or in a log. Credentials live in one file outside the repo at mode 600, and a scan for key material runs over the committed artifacts.
- Enterprise identity work in version one. SSO, SCIM, DLP, and private networking get designed interfaces now and implementations later.

## The road there

Phase 0 proved the risky parts. Pi runs inside a container and survives a killed tunnel without losing or repeating an event. A call the model asks for cannot produce a side effect in the container without a matching grant. A sandboxed process or browser cannot reach an arbitrary host, and only proxy egress works.

Phase 1 is the local MVP. One Bot, one browser page, chat, terminal and filesystem tools, allow-once and deny approvals, the ordered event protocol, spend caps, and a doctor command. Phase 1.5 proves the desktop and mobile shells and the golden-screenshot tooling. Later phases add browser and computer use with a human takeover path, skills and routines, memory, multi-Bot coordination, connectors, more client apps, and a self-hosting story.

## Where it stands

As of 2026-10-17, 23 units are merged and every one carries a ledger row naming its artifact and its commit. `bun run up` on `main` boots the app, and a prompt typed into the page gets a real answer from a real model, with the tool call it asks for parked at the gate until you answer. The container's own output and the model's closing turn both appear on the page. Still open: a file view for `/workspace`, a refactor of the verification record, and one line of page copy that still claims no model is attached.

## Read next

- [README.md](README.md) for the layout and the quickstart.
- [docs/RUNNING.md](docs/RUNNING.md) to run the app and switch between the live model and the replay.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) for what is proven and at which commit.
