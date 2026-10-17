import { describe, expect, test } from "bun:test";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import { Outbox } from "./outbox.ts";

function frame(n: number): PiInboundFrame {
  return { type: "unknown_frame", raw: { type: "marker", n } };
}

describe("Outbox", () => {
  test("pending holds every frame until the server acks it", () => {
    const outbox = new Outbox<PiInboundFrame>();
    outbox.push({ seq: 1, frame: frame(1) });
    outbox.push({ seq: 2, frame: frame(2) });
    outbox.push({ seq: 3, frame: frame(3) });

    expect(outbox.acked).toBe(0);
    expect(outbox.size).toBe(3);
    expect(outbox.pending().map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  test("an ack trims everything at or below it, and never moves backwards", () => {
    const outbox = new Outbox<PiInboundFrame>();
    outbox.push({ seq: 1, frame: frame(1) });
    outbox.push({ seq: 2, frame: frame(2) });
    outbox.push({ seq: 3, frame: frame(3) });

    outbox.ack(2);
    expect(outbox.acked).toBe(2);
    expect(outbox.pending().map((entry) => entry.seq)).toEqual([3]);

    outbox.ack(1);
    expect(outbox.acked).toBe(2);
    expect(outbox.pending().map((entry) => entry.seq)).toEqual([3]);

    outbox.ack(3);
    expect(outbox.pending()).toEqual([]);
    expect(outbox.size).toBe(0);
  });

  test("since returns the unconfirmed frames after a seq, in emission order", () => {
    const outbox = new Outbox<PiInboundFrame>();
    for (let seq = 1; seq <= 5; seq += 1) outbox.push({ seq, frame: frame(seq) });

    expect(outbox.since(3).map((entry) => entry.seq)).toEqual([4, 5]);

    outbox.ack(4);
    expect(outbox.since(0).map((entry) => entry.seq)).toEqual([5]);
    expect(outbox.since(4).map((entry) => entry.seq)).toEqual([5]);
    expect(outbox.since(5)).toEqual([]);
  });
});
