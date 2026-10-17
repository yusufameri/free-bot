import { describe, expect, test } from "bun:test";
import { PiProtocolError } from "./errors.ts";
import {
  type FixtureRecord,
  type PiResponse,
  parseFixture,
  parseFixtureLine,
  parseFrame,
  serializeFrame,
} from "./frames.ts";

const fixture = new URL("../fixtures/rpc-handshake.jsonl", import.meta.url);
const text = await Bun.file(fixture).text();
const lines = text.split("\n").filter((line) => line.trim().length > 0);

type CheckRecord = Extract<FixtureRecord, { dir: "check" }>;
type InboundRecord = Extract<FixtureRecord, { dir: "pi->bridge" }>;
const isCheck = (record: FixtureRecord): record is CheckRecord => record.dir === "check";
const isInbound = (record: FixtureRecord): record is InboundRecord => record.dir === "pi->bridge";

/** Every inbound kind the fixture captured, from the U0.2 spike transcript. */
const FIXTURE_FRAME_KINDS: string[] = [
  "agent_end",
  "agent_settled",
  "agent_start",
  "bash_execution_update",
  "extension_ui_request",
  "message_end",
  "message_start",
  "message_update",
  "response",
  "tool_execution_end",
  "tool_execution_start",
  "turn_end",
  "turn_start",
];

describe("fixture transcript", () => {
  test("every line parses with zero failures", () => {
    let failures = 0;
    for (const line of lines) {
      try {
        parseFixtureLine(line);
      } catch {
        failures += 1;
      }
    }
    expect(failures).toBe(0);
    expect(lines.length).toBe(248);
  });

  test("248 lines: 165 pi->bridge frames, 39 ok:true checks, 0 ok:false", () => {
    const records = parseFixture(text);
    expect(records.length).toBe(248);
    expect(records.filter(isInbound).length).toBe(165);
    expect(records.filter((record) => isCheck(record) && record.ok).length).toBe(39);
    expect(records.filter((record) => isCheck(record) && !record.ok).length).toBe(0);
  });

  test("the fixture exercises every modeled inbound frame kind", () => {
    const kinds = parseFixture(text)
      .filter(isInbound)
      .map((record) => `${record.frame.type}`);
    expect([...new Set(kinds)].sort()).toEqual(FIXTURE_FRAME_KINDS);
  });

  test("the one non-command bridge->pi line is the malformed-JSON probe", () => {
    const raw = parseFixture(text).filter(
      (record) => record.dir === "bridge->pi" && "raw" in record.sent,
    );
    expect(raw.length).toBe(1);
    expect(raw[0]).toMatchObject({
      dir: "bridge->pi",
      sent: { raw: '{"id":"malformed-1","type":' },
    });
  });
});

describe("parseFrame", () => {
  test("strips a trailing CR and returns a typed response", () => {
    const frame = parseFrame(
      '{"id":"state-1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"stub-1"}}}\r',
    );
    expect(frame.type).toBe("response");
    const response = frame as PiResponse;
    expect(response.command).toBe("get_state");
    expect((response.data as { model: { id: string } }).model.id).toBe("stub-1");
  });

  test("rejects a response frame missing command/success with the offending line", () => {
    let caught: unknown;
    try {
      parseFrame('{"id":"x","type":"response"}');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PiProtocolError);
    expect((caught as PiProtocolError).message).toBe("response frame lacks command/success");
  });

  test("rejects a non-JSON line", () => {
    expect(() => parseFrame("not json")).toThrow(PiProtocolError);
  });

  test("keeps unknown frame kinds instead of failing", () => {
    const frame = parseFrame('{"type":"future_event","payload":7}');
    expect(frame.type).toBe("unknown_frame");
    expect((frame as unknown as { raw: { payload: number } }).raw.payload).toBe(7);
  });
});

describe("serializeFrame", () => {
  test("writes exactly one LF-terminated record", () => {
    expect(serializeFrame({ id: "p1", type: "prompt", message: "hi" })).toBe(
      '{"id":"p1","type":"prompt","message":"hi"}\n',
    );
    expect(serializeFrame({ type: "extension_ui_response", id: "ui-1", confirmed: false })).toBe(
      '{"type":"extension_ui_response","id":"ui-1","confirmed":false}\n',
    );
  });
});
