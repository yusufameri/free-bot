/**
 * The API over its two real transports: `POST /rpc` on an ephemeral port, and a real WebSocket
 * subscribe. Nothing here is a stub: the server binds a loopback socket, oRPC validates both ends
 * of every call against `packages/protocol`'s contract, and the stream assertions read the bytes a
 * client actually received.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type apiContract, type EventMessage, safeParseMessage } from "@freebot/protocol";
import { createORPCClient } from "@orpc/client";
import { RPCLink as FetchLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { type ApiServer, startApiServer } from "./api-server.ts";

type ApiClient = ContractRouterClient<typeof apiContract>;

const running: ApiServer[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of running.splice(0)) server.stop();
});

function serve(): ApiServer {
  const server = startApiServer({ port: 0 });
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

function websocket(server: ApiServer, options: { token?: string; origin?: string } = {}) {
  const query = new URLSearchParams({ token: options.token ?? server.token });
  const socket =
    options.origin === undefined
      ? new WebSocket(`ws://127.0.0.1:${server.port}/rpc-ws?${query}`)
      : new WebSocket(`ws://127.0.0.1:${server.port}/rpc-ws?${query}`, {
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

describe("the oRPC surface over HTTP", () => {
  test("start_run, get_run and cancel_run round trip through the contract", async () => {
    const server = serve();
    const client = http(server);

    const started = await client.start_run({ prompt: "list the workspace" });
    expect(started.runId).toStartWith("run_");

    expect(await client.get_run({ runId: started.runId })).toEqual({
      runId: started.runId,
      status: "running",
      prompt: "list the workspace",
      startedAt: expect.any(Number),
      endedAt: null,
      lastSeq: 1,
    });

    expect(await client.cancel_run({ runId: started.runId })).toEqual({ runId: started.runId });

    const ended = await client.get_run({ runId: started.runId });
    expect(ended.status).toBe("failed");
    expect(ended.endedAt).toBeNumber();
    expect(ended.lastSeq).toBe(2);
  });

  test("a second cancel converges instead of failing", async () => {
    const server = serve();
    const client = http(server);

    const started = await client.start_run({ prompt: "twice" });
    await client.cancel_run({ runId: started.runId });
    await client.cancel_run({ runId: started.runId });

    const run = await client.get_run({ runId: started.runId });
    expect(run.status).toBe("failed");
    expect(run.lastSeq).toBe(2);
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
    const first = await client.start_run({ prompt: "replayed" });

    const { socket, client: streamed } = websocket(server);
    expect(await handshake(socket)).toBe("open");

    const received: EventMessage[] = [];
    const iterator = await streamed.subscribe_events({ lastSeq: 0 });
    const pump = drain(iterator, received);

    await until(() => received.length === 1, "the replayed run.started");
    expect(received[0]).toEqual({
      v: 1,
      seq: 1,
      ts: expect.any(Number),
      runId: first.runId,
      type: "run.started",
      payload: { prompt: "replayed" },
    });
    expect(safeParseMessage(received[0]).success).toBe(true);

    const second = await client.start_run({ prompt: "live" });
    await until(() => received.length === 2, "the live run.started");
    expect(received[1]).toEqual({
      v: 1,
      seq: 2,
      ts: expect.any(Number),
      runId: second.runId,
      type: "run.started",
      payload: { prompt: "live" },
    });

    await client.cancel_run({ runId: second.runId });
    await until(() => received.length === 3, "the live run.failed");
    expect(received[2]).toMatchObject({
      seq: 3,
      runId: second.runId,
      type: "run.failed",
      payload: { reason: "cancelled by operator" },
    });

    socket.close();
    await pump;
  });

  test("a resume from lastSeq 1 continues at seq 2 with no duplicate", async () => {
    const server = serve();
    const client = http(server);
    await client.start_run({ prompt: "one" });
    const second = await client.start_run({ prompt: "two" });

    const { socket, client: streamed } = websocket(server);
    expect(await handshake(socket)).toBe("open");

    const received: EventMessage[] = [];
    const iterator = await streamed.subscribe_events({ lastSeq: 1 });
    const pump = drain(iterator, received);

    await until(() => received.length === 1, "the resumed event");
    expect(received.map((message) => message.seq)).toEqual([2]);
    expect(received[0]?.runId).toBe(second.runId);
    expect(received[0]?.payload).toEqual({ prompt: "two" });

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
    await until(() => server.control.subscriberCount === 1, "the subscription to register");

    socket.close();
    await until(() => server.control.subscriberCount === 0, "the subscription to be released");
    await pump;
    expect(received).toEqual([]);
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
    expect(await allowed.json()).toMatchObject({ json: { runId: expect.stringMatching(/^run_/) } });

    expect(server.control.log.lastSeq).toBe(1);
  });

  test("a refused call never reaches a handler", async () => {
    const server = serve();

    await fetch(`http://127.0.0.1:${server.port}/rpc/start_run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });

    expect(server.control.log.lastSeq).toBe(0);
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
