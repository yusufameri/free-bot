/**
 * The in-sandbox link bridge both adapters share.
 *
 * A tunnel is a byte pipe to a TCP port inside the sandbox. The pipe is the image's own node: the
 * same script runs under `docker exec -i` and under `msb exec --stream`, so the supervisor sees
 * identical framing whichever engine hosts it, and there is one copy of the wire handling rather
 * than one per adapter.
 */

import { Duplex, type Readable, type Writable } from "node:stream";
import { type SupervisorToAgent, splitLines } from "@freebot/sandbox-agent";

/**
 * Byte-transparent stdio <-> TCP bridge, run inside the sandbox by the image's own node. Nothing
 * above it interprets bytes.
 */
export const BRIDGE_SCRIPT =
  'const net = require("node:net"); const socket = net.connect(Number(process.argv[1]), "127.0.0.1"); socket.on("error", (error) => { console.error(String(error)); process.exit(1); }); process.stdin.pipe(socket); socket.pipe(process.stdout); socket.on("close", () => process.exit(0));';

export function isAttached(
  value: unknown,
): value is Extract<SupervisorToAgent, { kind: "attached" }> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { kind?: unknown; acked?: unknown; lastSeq?: unknown };
  return (
    record.kind === "attached" &&
    typeof record.acked === "number" &&
    typeof record.lastSeq === "number"
  );
}

/**
 * `Duplex.from`'s documented object form: reads come from `readable`, writes go to `writable`.
 * @types/node lists only the web stream pair, so the cast covers the type gap; the object form is
 * Node's documented shape and is exercised by this package's Docker integration suite.
 */
export function duplexFromPair(readable: Readable, writable: Writable): Duplex {
  return Duplex.from({ readable, writable } as unknown as Parameters<typeof Duplex.from>[0]);
}

/** Resolve on the first complete JSONL line, keeping the remainder for the caller. */
export function firstLine(
  stream: Readable,
  timeoutMs: number,
): Promise<{ line: string; rest: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      stream.off("data", onData);
    };
    const onData = (chunk: Buffer) => {
      const split = splitLines(buffer, chunk.toString("utf8"));
      buffer = split.rest;
      const line = split.lines[0];
      if (line === undefined) return;
      const rest = [...split.lines.slice(1).map((kept) => `${kept}\n`), split.rest].join("");
      cleanup();
      resolve({ line, rest });
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no line within ${timeoutMs}ms`));
    }, timeoutMs);
    stream.on("data", onData);
  });
}
