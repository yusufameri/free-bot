// THROWAWAY SPIKE MEASUREMENT. Not the production budget.
//
// Method: a 2-byte origin served by Bun.serve on 127.0.0.1, then 50 sequential
// GETs measured over raw sockets with `connection: close` on both arms, so the
// only difference between the arms is the proxy hop:
//   direct  GET /tiny HTTP/1.1            -> origin
//   proxied GET http://127.0.0.1:P/tiny   -> proxy -> origin
// Both arms run on the host over loopback, which is the cheapest possible case
// and therefore a floor, not a budget.
//
// Usage: bun spikes/containment/overhead.ts

import { Socket } from "node:net";

const REQUESTS = 50;

type Sampled = { p50: number; p95: number; samples: number };

function percentile(sorted: Array<number>, p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? Number.NaN;
}

function sample(values: Array<number>): Sampled {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    samples: sorted.length,
  };
}

function timedGet(requestLine: string, port: number): Promise<number> {
  const started = performance.now();
  return new Promise<number>((resolve, reject) => {
    const socket = new Socket().connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    let response = "";
    socket.on("connect", () => {
      socket.write(`${requestLine}\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.on("end", () => {
      const elapsed = performance.now() - started;
      if (response.startsWith("HTTP/1.1 200")) {
        resolve(elapsed);
        return;
      }
      reject(new Error(`unexpected response: ${response.slice(0, 80)}`));
    });
    socket.on("error", reject);
  });
}

async function proxyPort(): Promise<{ port: number; stop: () => void }> {
  const child = Bun.spawn(["bun", "spikes/containment/proxy.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PROXY_PORT: "0", PROXY_BIND: "127.0.0.1" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`proxy exited before binding: ${buffer}`);
    }
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/proxy listening on 127\.0\.0\.1:(\d+)/);
    if (match?.[1] !== undefined) {
      return { port: Number(match[1]), stop: () => child.kill() };
    }
  }
  child.kill();
  throw new Error(`proxy did not report a port: ${buffer}`);
}

const origin = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("ok"),
});
const originPort = origin.port;
if (originPort === undefined) {
  throw new Error("Bun.serve did not report the origin port");
}
const proxy = await proxyPort();

const direct: Array<number> = [];
const proxied: Array<number> = [];
for (let i = 0; i < REQUESTS; i += 1) {
  direct.push(await timedGet("GET /tiny HTTP/1.1", originPort));
  proxied.push(await timedGet(`GET http://127.0.0.1:${originPort}/tiny HTTP/1.1`, proxy.port));
}

const directStats = sample(direct);
const proxiedStats = sample(proxied);

function line(label: string, stats: Sampled): string {
  return `${label} n=${stats.samples} p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms`;
}

console.log("== overhead (throwaway spike measurement, not the production budget) ==");
console.log(
  `origin: Bun.serve on 127.0.0.1:${originPort}, 2-byte body, connection: close per request`,
);
console.log(`proxy: bun spikes/containment/proxy.ts on 127.0.0.1:${proxy.port}`);
console.log(line("direct  ", directStats));
console.log(line("proxied ", proxiedStats));
console.log(
  `overhead p50=+${(proxiedStats.p50 - directStats.p50).toFixed(2)}ms p95=+${(
    proxiedStats.p95 - directStats.p95
  ).toFixed(2)}ms`,
);

proxy.stop();
origin.stop();
process.exit(0);
