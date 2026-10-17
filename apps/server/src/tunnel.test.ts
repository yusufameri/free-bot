import { afterEach, describe, expect, test } from "bun:test";
import type { StreamMessage } from "@freebot/core";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import { startTunnelServer, type TunnelServer } from "./tunnel.ts";

/** A real frame kind from pi-bridge's unions, carrying a marker a test can assert on. */
function marker(n: number): PiInboundFrame {
  return { type: "unknown_frame", raw: { type: "marker", n } };
}

const running: TunnelServer[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const server of running.splice(0)) server.stop();
});

function serve(): TunnelServer {
  const server = startTunnelServer({ port: 0 });
  running.push(server);
  return server;
}

interface StreamClient {
  ws: WebSocket;
  messages: StreamMessage<PiInboundFrame>[];
  seqs(): number[];
}

async function connectStream(port: number, lastSeenSeq: number): Promise<StreamClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?last_seen_seq=${lastSeenSeq}`);
  sockets.push(ws);
  const messages: StreamMessage<PiInboundFrame>[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as StreamMessage<PiInboundFrame>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("stream connection failed")));
  });
  return {
    ws,
    messages,
    seqs: () => messages.filter((m) => m.kind === "frame").map((m) => m.seq),
  };
}

interface AgentClient {
  ws: WebSocket;
  acks: number[];
  nacks: number[];
  errors: string[];
  send(seq: number, frame?: PiInboundFrame): void;
  sendRaw(text: string): void;
}

async function connectAgent(port: number, lastSeenSeq = 0): Promise<AgentClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel?last_seen_seq=${lastSeenSeq}`);
  sockets.push(ws);
  const acks: number[] = [];
  const nacks: number[] = [];
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      kind: string;
      seq?: number;
      lastSeq?: number;
      message?: string;
    };
    if (message.kind === "ack" && typeof message.seq === "number") acks.push(message.seq);
    if (message.kind === "nack" && typeof message.lastSeq === "number") nacks.push(message.lastSeq);
    if (message.kind === "error") errors.push(message.message ?? "");
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("tunnel connection failed")));
  });
  return {
    ws,
    acks,
    nacks,
    errors,
    send: (seq, frame = marker(seq)) => ws.send(JSON.stringify({ kind: "frame", seq, frame })),
    sendRaw: (text) => ws.send(text),
  };
}

async function until(condition: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(5);
  }
}

async function unary(port: number, lastSeenSeq: number) {
  const response = await fetch(`http://127.0.0.1:${port}/events?last_seen_seq=${lastSeenSeq}`);
  return (await response.json()) as {
    last_seq: number;
    count: number;
    reply_is_exact: boolean;
    frames: Array<{ seq: number; frame: PiInboundFrame }>;
  };
}

describe("tunnel ingest", () => {
  test("frames land in one log; the unary endpoint serves exactly the frames after last_seen_seq", async () => {
    const server = serve();
    const agent = await connectAgent(server.port);

    for (let seq = 1; seq <= 5; seq += 1) agent.send(seq);
    await until(() => agent.acks.at(-1) === 5, "ack through seq 5");

    const all = await unary(server.port, 0);
    expect(all.frames.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.frames.map((entry) => entry.frame)).toEqual([
      marker(1),
      marker(2),
      marker(3),
      marker(4),
      marker(5),
    ]);
    expect(all.last_seq).toBe(5);
    expect(all.count).toBe(5);
    expect(all.reply_is_exact).toBe(true);

    const tail = await unary(server.port, 2);
    expect(tail.frames.map((entry) => entry.seq)).toEqual([3, 4, 5]);

    expect(server.log.audit()).toEqual({
      firstSeq: 1,
      lastSeq: 5,
      count: 5,
      gaps: [],
      duplicates: [],
      suppressedAtIngest: [],
      gapEvents: [],
      rejected: 0,
    });
  });

  test("a rejoining stream client receives exactly the frames after its last_seen_seq", async () => {
    const server = serve();
    const agent = await connectAgent(server.port);

    for (let seq = 1; seq <= 3; seq += 1) agent.send(seq);
    const first = await connectStream(server.port, 0);
    await until(() => first.seqs().length === 3, "first client replay");
    expect(first.seqs()).toEqual([1, 2, 3]);
    first.ws.close();

    for (let seq = 4; seq <= 6; seq += 1) agent.send(seq);
    await until(() => server.log.lastSeq === 6, "six frames logged");

    const rejoin = await connectStream(server.port, 3);
    await until(() => rejoin.seqs().length === 3, "rejoin replay");
    expect(rejoin.seqs()).toEqual([4, 5, 6]);
    expect(rejoin.messages[0]).toEqual({ kind: "hello", lastSeq: 6 });

    const replayAll = await connectStream(server.port, 0);
    await until(() => replayAll.seqs().length === 6, "full replay");
    expect(replayAll.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a live stream client keeps receiving after its replay", async () => {
    const server = serve();
    const agent = await connectAgent(server.port);
    agent.send(1);
    agent.send(2);

    const client = await connectStream(server.port, 0);
    await until(() => client.seqs().length === 2, "replay");

    agent.send(3);
    await until(() => client.seqs().length === 3, "live frame");
    expect(client.seqs()).toEqual([1, 2, 3]);
  });
});

describe("tunnel reconnect and repair", () => {
  test("a replayed frame is suppressed, not duplicated, and the log stays gap-free", async () => {
    const server = serve();
    const first = await connectAgent(server.port);
    for (let seq = 1; seq <= 4; seq += 1) first.send(seq);
    await until(() => first.acks.at(-1) === 4, "ack through seq 4");
    first.ws.close();

    // The lost-ack window: the agent believes the log stops at 2 and resends 3 and 4.
    const second = await connectAgent(server.port, 2);
    second.send(3);
    second.send(4);
    second.send(5);
    await until(() => server.log.lastSeq === 5, "five frames logged");

    const audit = server.log.audit();
    expect(audit.count).toBe(5);
    expect(audit.suppressedAtIngest).toEqual([3, 4]);
    expect(audit.gaps).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(server.log.since(0).map((entry) => entry.frame)).toEqual([
      marker(1),
      marker(2),
      marker(3),
      marker(4),
      marker(5),
    ]);
  });

  test("a frame that skips ahead is nacked, and the resend heals it", async () => {
    const server = serve();
    const agent = await connectAgent(server.port);
    agent.send(1);
    agent.send(2);
    agent.send(4);
    await until(() => agent.nacks.length === 1, "one nack");

    expect(agent.nacks).toEqual([2]);
    expect(server.log.lastSeq).toBe(2);

    agent.send(3);
    agent.send(4);
    await until(() => server.log.lastSeq === 4, "healed");
    expect(server.log.since(0).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(server.log.audit().gapEvents).toEqual([{ expected: 3, got: 4 }]);
    expect(server.log.audit().gaps).toEqual([]);
  });

  test("truncated and malformed tunnel payloads never touch the log", async () => {
    const server = serve();
    const agent = await connectAgent(server.port);
    agent.send(1);
    agent.send(2);
    await until(() => server.log.lastSeq === 2, "two frames logged");

    agent.sendRaw('{"kind":"frame","seq":3,"fra'); // the truncated tail of a killed write
    agent.sendRaw("not json at all");
    agent.sendRaw('{"kind":"frame","seq":0,"frame":{}}');
    agent.sendRaw('{"kind":"frame"}');
    await until(() => agent.errors.length === 4, "four refusals");

    const audit = server.log.audit();
    expect(audit.count).toBe(2);
    expect(audit.lastSeq).toBe(2);
    expect(audit.rejected).toBe(4);
    expect(audit.gaps).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(audit.firstSeq).toBe(1);
  });
});

describe("cross-origin upgrades", () => {
  async function upgrade(port: number, origin: string | undefined): Promise<string> {
    const url = `ws://127.0.0.1:${port}/stream?last_seen_seq=0`;
    const ws =
      origin === undefined ? new WebSocket(url) : new WebSocket(url, { headers: { origin } });
    sockets.push(ws);
    return new Promise((resolve) => {
      ws.addEventListener("open", () => resolve("open"));
      ws.addEventListener("error", () => resolve("refused"));
      ws.addEventListener("close", () => resolve("refused"));
    });
  }

  test("a foreign Origin is refused before the socket opens", async () => {
    const server = serve();
    expect(await upgrade(server.port, "http://evil.example")).toBe("refused");
    expect(await upgrade(server.port, "null")).toBe("refused");
  });

  test("a loopback Origin and a client with no Origin still upgrade", async () => {
    const server = serve();
    expect(await upgrade(server.port, "http://localhost:5173")).toBe("open");
    expect(await upgrade(server.port, undefined)).toBe("open");
  });
});
