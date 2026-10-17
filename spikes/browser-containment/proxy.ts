// THROWAWAY SPIKE PROXY. Not production. The production egress proxy is a
// later unit with an allowlist, auth, and policy hooks.
//
// What it does: absolute-form GET and CONNECT. It resolves DNS itself on the
// host and streams bytes unbuffered in both directions, which is the point of
// the spike: the container needs no DNS and no route of its own.
//
// What it deliberately does not do: no allowlist, no auth, no caching, no TLS
// interception, no keep-alive reuse (one request per connection, `connection:
// close` is forced upstream). Bind is 127.0.0.1 by default.
//
// Usage: PROXY_PORT=8788 bun spikes/containment/proxy.ts
// Prints "proxy listening on <host>:<port>" on stdout once bound.

import { lookup } from "node:dns/promises";
import { createServer, Socket } from "node:net";

const bind = process.env.PROXY_BIND ?? "127.0.0.1";
const port = Number(process.env.PROXY_PORT ?? 8788);
const HEADER_LIMIT = 16 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function log(line: string): void {
  console.log(`proxy ${line}`);
}

async function dial(host: string, port: number): Promise<Socket> {
  // IPv4 first: the container's netns is IPv4-only, so the spike keeps the
  // proxy's own resolution path identical to what the container can use.
  const resolved = await lookup(host, { family: 4 }).catch(() => lookup(host));
  log(`dial ${host}:${port} -> ${resolved.address}:${port} (family ${resolved.family})`);
  return new Promise((resolve, reject) => {
    const socket = new Socket().connect({ host: resolved.address, port });
    socket.setNoDelay(true);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function refuse(client: Socket, code: number, reason: string): void {
  client.end(`HTTP/1.1 ${code} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
}

function bridge(left: Socket, right: Socket): void {
  left.pipe(right);
  right.pipe(left);
  const shutdown = () => {
    left.destroy();
    right.destroy();
  };
  left.on("error", shutdown);
  right.on("error", shutdown);
  left.on("close", () => right.destroy());
  right.on("close", () => left.destroy());
}

function rewriteHeaders(lines: Array<string>, authority: string): Array<string> {
  const kept: Array<string> = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === "host" || HOP_BY_HOP.has(name)) {
      continue;
    }
    kept.push(line);
  }
  kept.push(`host: ${authority}`);
  kept.push("connection: close");
  return kept;
}

async function handleAbsoluteForm(
  client: Socket,
  method: string,
  target: string,
  headerLines: Array<string>,
  leftover: Buffer,
): Promise<void> {
  const url = new URL(target);
  if (url.protocol !== "http:") {
    refuse(client, 400, "Bad Request");
    return;
  }
  const upstream = await dial(url.hostname, Number(url.port === "" ? 80 : url.port));
  const path = `${url.pathname}${url.search}`;
  const head = [
    `${method} ${path} HTTP/1.1`,
    ...rewriteHeaders(headerLines, url.host),
    "",
    "",
  ].join("\r\n");
  upstream.write(Buffer.concat([Buffer.from(head, "latin1"), leftover]));
  upstream.pipe(client);
  client.pipe(upstream);
}

async function handleConnect(client: Socket, target: string, leftover: Buffer): Promise<void> {
  const split = target.lastIndexOf(":");
  if (split <= 0) {
    refuse(client, 400, "Bad Request");
    return;
  }
  const host = target.slice(0, split);
  const upstreamPort = Number(target.slice(split + 1));
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    refuse(client, 400, "Bad Request");
    return;
  }
  const upstream = await dial(host.replace(/^\[|\]$/g, ""), upstreamPort);
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (leftover.length > 0) {
    upstream.write(leftover);
  }
  bridge(client, upstream);
}

async function handleHead(client: Socket, head: Buffer, leftover: Buffer): Promise<void> {
  const lines = head.toString("latin1").split("\r\n");
  const requestLine = lines[0] ?? "";
  const match = /^([A-Za-z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (match === null) {
    refuse(client, 400, "Bad Request");
    return;
  }
  const method = match[1] ?? "";
  const target = match[2] ?? "";
  if (method === "CONNECT") {
    await handleConnect(client, target, leftover);
    return;
  }
  if (target.startsWith("/")) {
    if (target === "/__health") {
      client.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
      return;
    }
    refuse(client, 400, "Bad Request");
    return;
  }
  await handleAbsoluteForm(client, method, target, lines.slice(1, -1), leftover);
}

const server = createServer((client) => {
  client.setNoDelay(true);
  let buffered = Buffer.alloc(0);
  let claimed = false;

  const onData = (chunk: Buffer): void => {
    if (claimed) {
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > HEADER_LIMIT) {
      claimed = true;
      client.removeListener("data", onData);
      refuse(client, 431, "Request Header Fields Too Large");
      return;
    }
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      return;
    }
    claimed = true;
    client.pause();
    client.removeListener("data", onData);
    const head = buffered.subarray(0, end + 4);
    const leftover = buffered.subarray(end + 4);
    handleHead(client, head, leftover).then(
      () => {
        if (client.readableFlowing === false) {
          client.resume();
        }
      },
      (error: unknown) => {
        log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
        client.destroy();
      },
    );
  };

  client.on("data", onData);
  client.on("error", () => {});
});

server.listen(port, bind, () => {
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  console.log(`proxy listening on ${bind}:${bound}`);
});

server.on("error", (error) => {
  console.error(`proxy listen failed: ${error.message}`);
  process.exitCode = 1;
});
