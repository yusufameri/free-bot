/**
 * The API over its three real transports: `POST /rpc` on an ephemeral port, a real WebSocket
 * subscribe on `/rpc-ws`, and the page's own stream on `/events`. Nothing here is a stub: the
 * server binds a loopback socket, oRPC validates both ends of every call against
 * `packages/protocol`'s contract, and the stream assertions read the bytes a client actually
 * received.
 *
 * The run service is injected with a provider that never returns, so a run sits at the three frames
 * the loop appends before its first turn and the assertions below are about the transport, not
 * about a race with the run. The run's own execution is `router.test.ts`'s subject.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import { type apiContract, type EventMessage, safeParseMessage } from "@freebot/protocol";
import { createORPCClient } from "@orpc/client";
import { RPCLink as FetchLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { type ApiServer, startApiServer } from "./api-server.ts";
import { createRunService } from "./run-service.ts";

type ApiClient = ContractRouterClient<typeof apiContract>;

const TOKEN = "api-server-test-token";

const running: ApiServer[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of running.splice(0)) server.stop();
});

/** Never answers, so the run parks at the three frames every run appends before its first turn. */
const heldProvider: ProviderPort = {
  next: () => new Promise(() => {}),
};

const unusedSandbox: SandboxPort = {
  async create() {},
  async execute() {
    throw new Error("this test starts no tool call");
  },
  async destroy() {},
};

function serve(): ApiServer {
  const service = createRunService({ sandbox: unusedSandbox, provider: () => heldProvider });
  const server = startApiServer({ port: 0, token: TOKEN, service });
  running.push(server);
  return server;
}

function http(server: ApiServer, headers: Record<string, string> = {}): ApiClient {
  return createORPCClient<ApiClient>(
    new FetchLink({
      url: `http://127.0.0.1:${server.port}/rpc`,
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${server.port}`,
        ...headers,
      },
    }),
  );
}

function websocket(
  server: ApiServer,
  options: { token?: string; origin?: string; path?: string } = {},
) {
  const query = new URLSearchParams({ token: options.token ?? server.token });
  const path = options.path ?? "/rpc-ws";
  const socket =
    options.origin === undefined
      ? new WebSocket(`ws://127.0.0.1:${server.port}${path}?${query}`)
      : new WebSocket(`ws://127.0.0.1:${server.port}${path}?${query}`, {
          headers: { origin: options.origin },
        });
  sockets.push(socket);
  return { socket, client: createORPCClient<ApiClient>(new WebSocketLink({ websocket: socket })) };
}

/** Resolves with the first thing the handshake does: open, or a refusal before it opens. */
function handshake(socket: WebSocket): Promise<"open" | "refused"> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve("open");
  return new Promise((resolve) => {
    socket.addEventListener("open", () => resolve("open"));
    socket.addEventListener("error", () => resolve("refused"));
    socket.addEventListener("close", () => resolve("refused"));
  });
}

/** Drains what a live iterator yields until its socket closes. */
async function drain(
  iterator: AsyncIterable<EventMessage>,
  received: EventMessage[],
): Promise<void> {
  try {
    for await (const message of iterator) received.push(message);
  } catch {
    // The client's iterator aborts when its socket closes; that is the drain's end.
  }
}

/** Waits for a live assertion to become true, or fails with the state it saw. */
async function until(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** The code out of a refusal body. */
function refusal(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

/** One `start_run`, awaited to the frames it appends before its first turn. */
async function beginRun(server: ApiServer, client: ApiClient, prompt: string): Promise<string> {
  const before = server.service.log.lastSeq;
  const started = await client.start_run({ prompt });
  await until(() => server.service.log.lastSeq >= before + 3, "the run's opening frames");
  return started.runId;
}

describe("the oRPC surface over HTTP", () => {
  test("start_run, get_run and cancel_run round trip through the contract", async () => {
    const server = serve();
    const client = http(server);

    const started = await beginRun(server, client, "list the workspace");
    expect(started).toMatch(/^run-\d+$/);

    expect(await client.get_run({ runId: started })).toEqual({
      runId: started,
      status: "running",
      prompt: "list the workspace",
      startedAt: expect.any(Number),
      endedAt: null,
      lastSeq: 3,
    });

    expect(await client.cancel_run({ runId: started })).toEqual({ runId: started });
  });

  test("a second cancel converges instead of failing", async () => {
    const server = serve();
    const client = http(server);

    const started = await beginRun(server, client, "twice");
    await client.cancel_run({ runId: started });
    await client.cancel_run({ runId: started });

    expect((await client.get_run({ runId: started })).status).toBe("running");
  });

  test("an unknown run is NOT_FOUND on both read and cancel", async () => {
    const client = http(serve());

    await expect(client.get_run({ runId: "run_missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "no such run: run_missing",
    });
    await expect(client.cancel_run({ runId: "run_missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("a strict input refuses an unknown key before the handler runs", async () => {
    const client = http(serve());

    await expect(
      client.start_run({ prompt: "hi", model: "gpt-5" } as unknown as { prompt: string }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await http(serve())
        .get_run({ runId: "run_never" })
        .catch(() => "refused"),
    ).toBe("refused");
  });

  test("unknown procedures are 404 behind the gate", async () => {
    const server = serve();

    const refused = await fetch(`http://127.0.0.1:${server.port}/rpc/nope`, { method: "POST" });
    expect(refused.status).toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${server.port}/rpc/nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(allowed.status).toBe(404);
  });
});

describe("the event stream over a real socket", () => {
  test("replays from lastSeq, then yields a live event, in seq order", async () => {
    const server = serve();
    const client = http(server);
    const first = await beginRun(server, client, "replayed");

    const { socket, client: streamed } = websocket(server);
    expect(await handshake(socket)).toBe("open");

    const received: EventMessage[] = [];
    const iterator = await streamed.subscribe_events({ lastSeq: 0 });
    const pump = drain(iterator, received);

    await until(() => received.length === 3, "the replayed run opening");
    expect(received.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(received[0]).toEqual({
      v: 1,
      seq: 1,
      ts: expect.any(Number),
      runId: first,
      type: "run.started",
      payload: { prompt: "replayed" },
    });
    expect(received.every((message) => safeParseMessage(message).success)).toBe(true);

    const second = await beginRun(server, client, "live");
    await until(() => received.length === 6, "the live run opening");
    expect(received[3]).toMatchObject({ seq: 4, runId: second, type: "run.started" });

    socket.close();
    await pump;
  });

  test("a resume from lastSeq 3 continues at seq 4 with no duplicate", async () => {
    const server = serve();
    const client = http(server);
    const first = await beginRun(server, client, "one");
    const second = await beginRun(server, client, "two");

    const { socket, client: streamed } = websocket(server);
    expect(await handshake(socket)).toBe("open");

    const received: EventMessage[] = [];
    const iterator = await streamed.subscribe_events({ lastSeq: 3 });
    const pump = drain(iterator, received);

    await until(() => received.length === 3, "the resumed events");
    expect(received.map((message) => message.seq)).toEqual([4, 5, 6]);
    expect(received[0]?.runId).toBe(second);
    expect(received.every((message) => message.runId === second)).toBe(true);
    expect(first).not.toBe(second);

    socket.close();
    await pump;
  });

  test("a closed socket releases its subscription", async () => {
    const server = serve();
    const { socket, client } = websocket(server);
    expect(await handshake(socket)).toBe("open");

    const iterator = await client.subscribe_events({ lastSeq: 0 });
    const received: EventMessage[] = [];
    const pump = drain(iterator, received);
    await until(() => server.service.subscribers === 1, "the subscription to register");

    socket.close();
    await until(() => server.service.subscribers === 0, "the subscription to be released");
    await pump;
    expect(received).toEqual([]);
  });
});

describe("the page's stream over the real server", () => {
  /** The page's own messages: `stream.hello`, the log, then live. */
  function pageStream(server: ApiServer, options: { token?: string; lastSeenSeq?: number } = {}) {
    const query = new URLSearchParams();
    if (options.token !== undefined) query.set("token", options.token);
    if ((options.lastSeenSeq ?? 0) > 0) query.set("last_seen_seq", String(options.lastSeenSeq));
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events?${query}`);
    sockets.push(socket);
    const messages: unknown[] = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    return { socket, messages };
  }

  test("a missing or wrong token is refused, and the printed token is accepted", async () => {
    const server = serve();

    const missing = pageStream(server);
    expect(await handshake(missing.socket)).toBe("refused");

    const wrong = pageStream(server, { token: "0000" });
    expect(await handshake(wrong.socket)).toBe("refused");

    const allowed = pageStream(server);
    allowed.socket.close();
    const correct = pageStream(server, { token: server.token });
    expect(await handshake(correct.socket)).toBe("open");
    await until(() => correct.messages.length === 1, "the hello marker");
    expect(correct.messages[0]).toEqual({
      v: 1,
      type: "stream.hello",
      payload: { firstSeq: null, lastSeq: 0 },
    });
  });

  test("the page sees the run it starts, in the shape it renders", async () => {
    const server = serve();
    const stream = pageStream(server, { token: server.token });
    expect(await handshake(stream.socket)).toBe("open");

    stream.socket.send(JSON.stringify({ type: "start", prompt: "from the page" }));
    await until(() => stream.messages.length === 4, "the hello and the run's opening frames");

    expect(stream.messages[1]).toMatchObject({
      seq: 1,
      v: 1,
      type: "run.started",
      payload: { prompt: "from the page" },
    });
    expect(stream.messages[3]).toMatchObject({
      seq: 3,
      type: "turn.started",
      payload: { turn: 1 },
    });
    expect(server.service.store.get("run-1")?.prompt).toBe("from the page");
  });

  test("the page serves its own host page and bundle", async () => {
    const server = serve();

    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script type="module" src="/main.js"></script>');

    const bundle = await fetch(`http://127.0.0.1:${server.port}/main.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect((await bundle.text()).length).toBeGreaterThan(1000);
  });
});

describe("the gate over the real server", () => {
  test("the 401/403/200 matrix, with each refusal's own code", async () => {
    const server = serve();
    const origin = `http://127.0.0.1:${server.port}`;
    const call = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${server.port}/rpc/start_run`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ json: { prompt: "hi" } }),
      });

    const missing = await call({ origin });
    expect(missing.status).toBe(401);
    expect(refusal(await missing.json())).toBe("token_missing");

    const wrong = await call({ origin, authorization: "Bearer 0000" });
    expect(wrong.status).toBe(401);
    expect(refusal(await wrong.json())).toBe("token_mismatch");

    const crossOrigin = await call({
      origin: "http://evil.example",
      authorization: `Bearer ${server.token}`,
    });
    expect(crossOrigin.status).toBe(403);
    expect(refusal(await crossOrigin.json())).toBe("origin_not_allowed");

    const rebound = await call({
      origin,
      authorization: `Bearer ${server.token}`,
      host: "evil.example",
    });
    expect(rebound.status).toBe(403);
    expect(refusal(await rebound.json())).toBe("host_not_allowed");

    const allowed = await call({ origin, authorization: `Bearer ${server.token}` });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      json: { runId: expect.stringMatching(/^run-\d+$/) },
    });

    expect(server.service.log.lastSeq).toBeGreaterThanOrEqual(1);
  });

  test("a refused call never reaches a handler", async () => {
    const server = serve();

    await fetch(`http://127.0.0.1:${server.port}/rpc/start_run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });

    expect(server.service.log.lastSeq).toBe(0);
  });

  test("the WebSocket upgrade is refused without the token, and accepted with it", async () => {
    const server = serve();

    const noToken = websocket(server, { token: "" });
    expect(await handshake(noToken.socket)).toBe("refused");

    const wrongToken = websocket(server, { token: "0000" });
    expect(await handshake(wrongToken.socket)).toBe("refused");

    const crossOrigin = websocket(server, { origin: "http://evil.example" });
    expect(await handshake(crossOrigin.socket)).toBe("refused");

    const allowed = websocket(server);
    expect(await handshake(allowed.socket)).toBe("open");
  });

  test("healthz stays a liveness probe behind the Host check", async () => {
    const server = serve();

    const live = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok", service: "freebot-server" });

    const rebound = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
      headers: { host: "evil.example" },
    });
    expect(rebound.status).toBe(403);
    expect(refusal(await rebound.json())).toBe("host_not_allowed");
  });

  test("the tunnel leg's allowance stays off the API leg", async () => {
    const server = serve();

    const reply = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
      headers: { host: `host.docker.internal:${server.port}` },
    });
    expect(reply.status).toBe(403);
    expect(refusal(await reply.json())).toBe("host_not_allowed");
  });

  test("the server answers on loopback only", async () => {
    const server = serve();
    const listening = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], {
      stdout: "pipe",
    }).stdout.toString();

    const ours = listening.split("\n").filter((line) => line.includes(`:${server.port} `));
    expect(ours.length).toBe(1);
    expect(ours[0]).toContain(`127.0.0.1:${server.port}`);
    expect(ours[0]).toContain("(LISTEN)");
  });
});
