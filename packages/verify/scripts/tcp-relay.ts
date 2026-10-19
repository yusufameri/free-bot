#!/usr/bin/env bun
/**
 * A raw TCP relay for the evidence drivers: the page's own origin, so a driver can hold one request
 * or sever the transport for real.
 *
 * `Bun.Socket.write` is unbuffered and returns the bytes it accepted. A write it cannot take whole
 * must keep the remainder and send it on `drain`, or the tail is dropped; a 900 KB module script is
 * enough to hit that, and a truncated script fails to parse with no console line. Both drivers use
 * this file so that fix exists once.
 */

export interface Relay {
  readonly port: number;
  readonly url: string;
  /** Hold the next client request whose bytes carry `pattern` for `ms` before forwarding it. */
  hold(pattern: string, ms: number): void;
  /** Destroy every relayed pair and refuse new connections. */
  sever(): void;
  /** Accept connections again. */
  restore(): void;
  stop(): void;
}

interface Pair {
  readonly client: Bun.Socket;
  upstream: Bun.Socket | null;
  readonly toUpstream: Uint8Array[];
  readonly toClient: Uint8Array[];
  sent: string;
  held: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  readonly closed: { client: boolean; upstream: boolean };
}

function write(socket: Bun.Socket, chunk: Uint8Array, queue: Uint8Array[]): void {
  if (queue.length > 0) {
    queue.push(chunk);
    return;
  }
  const written = socket.write(chunk);
  if (written < 0) return;
  if (written < chunk.length) queue.push(chunk.subarray(written));
}

function flush(socket: Bun.Socket, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const chunk = queue[0];
    if (chunk === undefined) return;
    const written = socket.write(chunk);
    if (written < 0) return;
    if (written < chunk.length) {
      queue[0] = chunk.subarray(written);
      return;
    }
    queue.shift();
  }
}

/**
 * One relay in front of `upstreamPort`.
 *
 * HTTP and the WebSocket upgrade are bytes, so one splice carries both. `hold` arms exactly one
 * match, which is how a driver makes one request slow; `sever` is a transport that really went away
 * rather than a class toggled by hand.
 */
export function openRelay(upstreamPort: number): Relay {
  const pairs = new Map<unknown, Pair>();
  let severed = false;
  let pattern: string | null = null;
  let holdMs = 0;

  function endWhenDrained(pair: Pair): void {
    if (pair.closed.upstream && pair.toClient.length === 0) pair.client.end();
    if (pair.closed.client && pair.toUpstream.length === 0) pair.upstream?.end();
  }

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        const pair: Pair = {
          client,
          upstream: null,
          toUpstream: [],
          toClient: [],
          sent: "",
          held: false,
          timer: null,
          closed: { client: false, upstream: false },
        };
        pairs.set(client, pair);
        if (severed) {
          pair.closed.client = true;
          client.end();
          return;
        }
        const remote = await Bun.connect({
          hostname: "127.0.0.1",
          port: upstreamPort,
          socket: {
            data(_socket, chunk) {
              if (!pair.closed.client) write(client, chunk, pair.toClient);
            },
            drain() {
              flush(remote, pair.toUpstream);
              endWhenDrained(pair);
            },
            close() {
              pair.closed.upstream = true;
              endWhenDrained(pair);
            },
          },
        });
        if (severed || pair.closed.client) {
          pair.closed.upstream = true;
          remote.end();
          pairs.delete(client);
          return;
        }
        pair.upstream = remote;
        // A held request waits for its timer, which may have already fired while the connection
        // was still opening. Only flush here when nothing is holding the queue.
        if (pair.timer === null) flush(remote, pair.toUpstream);
      },
      data(client, chunk) {
        const pair = pairs.get(client);
        if (pair === undefined || pair.closed.upstream) return;
        if (!pair.held && pattern !== null) {
          pair.sent = `${pair.sent}${new TextDecoder().decode(chunk)}`.slice(-8192);
          if (pair.sent.includes(pattern)) {
            pair.held = true;
            pattern = null;
            const ms = holdMs;
            pair.timer = setTimeout(() => {
              pair.timer = null;
              if (pair.upstream !== null) flush(pair.upstream, pair.toUpstream);
            }, ms);
          }
        }
        if (pair.held) pair.toUpstream.push(chunk);
        else if (pair.upstream === null) pair.toUpstream.push(chunk);
        else write(pair.upstream, chunk, pair.toUpstream);
      },
      drain(client) {
        const pair = pairs.get(client);
        if (pair === undefined) return;
        flush(client, pair.toClient);
        endWhenDrained(pair);
      },
      close(client) {
        const pair = pairs.get(client);
        pairs.delete(client);
        if (pair === undefined) return;
        pair.closed.client = true;
        if (pair.timer !== null) clearTimeout(pair.timer);
        endWhenDrained(pair);
      },
    },
  });

  function stop(): void {
    severed = true;
    for (const [, pair] of pairs) {
      pair.closed.client = true;
      pair.closed.upstream = true;
      if (pair.timer !== null) clearTimeout(pair.timer);
      pair.upstream?.terminate();
      pair.client.terminate();
    }
    pairs.clear();
    server.stop(true);
  }

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    hold(nextPattern: string, ms: number) {
      pattern = nextPattern;
      holdMs = ms;
    },
    sever() {
      severed = true;
      for (const [, pair] of pairs) {
        pair.closed.client = true;
        pair.closed.upstream = true;
        if (pair.timer !== null) clearTimeout(pair.timer);
        pair.upstream?.terminate();
        pair.client.terminate();
      }
      pairs.clear();
    },
    restore() {
      severed = false;
    },
    stop,
  };
}
