#!/usr/bin/env bun
/**
 * The relay the aside and overlays drivers open in front of the app.
 *
 * The large-payload case is the one that matters: `Bun.Socket.write` is unbuffered and can accept
 * only part of a chunk. A 900 KB module script over a relay that drops the remainder fails to parse
 * with no console line, which is how both drivers intermittently lost their page hooks.
 */

import { describe, expect, test } from "bun:test";
import { openRelay } from "./tcp-relay.ts";

const PAYLOAD = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, index) => index % 251);

function serveOnce(onBytes: (socket: Bun.Socket) => void) {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        onBytes(socket);
      },
      drain(socket) {
        (socket as Bun.Socket & { pump?: () => void }).pump?.();
      },
    },
  });
}

/** Write every byte, keeping what the socket refuses for its `drain` callback. */
function writeAll(socket: Bun.Socket, payload: Uint8Array): void {
  let offset = 0;
  const pump = (): void => {
    while (offset < payload.length) {
      const remaining = payload.length - offset;
      const written = socket.write(payload.subarray(offset));
      if (written < 0) return;
      offset += written;
      if (written < remaining) return;
    }
    socket.end();
  };
  (socket as Bun.Socket & { pump?: () => void }).pump = pump;
  pump();
}

describe("the driver relay", () => {
  test("carries a payload larger than the socket buffers without losing a byte", async () => {
    const server = serveOnce((socket) => writeAll(socket, PAYLOAD));
    const relay = openRelay(server.port);
    const received: number[] = [];
    const done = new Promise<void>((resolve, reject) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: relay.port,
        socket: {
          open(socket) {
            socket.write("send\n");
          },
          data(_socket, chunk) {
            for (const byte of chunk) received.push(byte);
            if (received.length > PAYLOAD.length) reject(new Error("the relay sent extra bytes"));
            if (received.length === PAYLOAD.length) resolve();
          },
          close() {
            resolve();
          },
        },
      }).catch(reject);
    });
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`truncated at ${received.length} of ${PAYLOAD.length}`)),
          10_000,
        ),
      ),
    ]);
    expect(received.length).toBe(PAYLOAD.length);
    const mismatch = received.findIndex((byte, index) => byte !== PAYLOAD[index]);
    expect(mismatch).toBe(-1);
    relay.stop();
    server.stop(true);
  });

  test("holds the first request carrying the pattern, then forwards it", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.write(`echo:${new TextDecoder().decode(chunk)}`);
        },
      },
    });
    const relay = openRelay(server.port);
    const answer = await new Promise<string>((resolve, reject) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: relay.port,
        socket: {
          open(socket) {
            socket.write("GET /slow HTTP/1.1\r\n\r\n");
          },
          data(_socket, chunk) {
            resolve(new TextDecoder().decode(chunk));
          },
        },
      }).catch(reject);
    });
    relay.hold("GET /slow", 250);
    // The first connection above was opened before the hold was armed, so it is the control: the
    // armed request is the next one.
    const startedHeld = Date.now();
    const held = await new Promise<string>((resolve, reject) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: relay.port,
        socket: {
          open(socket) {
            socket.write("GET /slow HTTP/1.1\r\n\r\n");
          },
          data(_socket, chunk) {
            resolve(new TextDecoder().decode(chunk));
          },
        },
      }).catch(reject);
    });
    expect(answer).toBe("echo:GET /slow HTTP/1.1\r\n\r\n");
    expect(held).toBe("echo:GET /slow HTTP/1.1\r\n\r\n");
    expect(Date.now() - startedHeld).toBeGreaterThanOrEqual(200);
    relay.stop();
    server.stop(true);
  });
});
