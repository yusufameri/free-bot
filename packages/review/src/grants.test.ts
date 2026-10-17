import { describe, expect, test } from "bun:test";
import {
  CanonicalizationError,
  canonicalActionHash,
  canonicalizeJson,
  canonicalJsonText,
  GrantRecordError,
  parseGrantRecord,
  recomputeActionHash,
} from "./grants.ts";

const HASH_ECHO_HI = "v1:sha256:0b07de4a30385177b5d5b2de52ca057887ecb38d536e7d2094df21deb5f80d63";

const VALID_RECORD = {
  id: "grant-1",
  seq: 1,
  issuedAt: 1_760_000_000_000,
  expiresAt: 1_760_000_060_000,
  actionHash: HASH_ECHO_HI,
  toolName: "bash",
  normalizedArgs: { command: "echo hi" },
  consumedBy: null,
  tombstoned: null,
};

describe("canonical JSON", () => {
  test("sorts object keys at every level", () => {
    expect(canonicalJsonText({ b: 1, a: { d: [3, 2], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,2]},"b":1}',
    );
  });

  test("keeps array order", () => {
    expect(canonicalJsonText([2, 1])).toBe("[2,1]");
    expect(canonicalJsonText({ argv: ["a", "b"] })).not.toBe(
      canonicalJsonText({ argv: ["b", "a"] }),
    );
  });

  test("number text forms collapse through JS number semantics", () => {
    expect(canonicalJsonText({ n: 1e2 })).toBe('{"n":100}');
    expect(canonicalJsonText({ n: 1.5 })).toBe('{"n":1.5}');
  });

  test("treats a __proto__ key as data", () => {
    expect(canonicalJsonText(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(
      '{"__proto__":{"polluted":true}}',
    );
  });

  test("refuses undefined, naming its path", () => {
    expect(() => canonicalizeJson({ command: undefined })).toThrow(
      "$.command: refuses undefined (not a JSON value)",
    );
    expect(() => canonicalizeJson(undefined)).toThrow("$: refuses undefined");
  });

  test("refuses NaN and Infinity", () => {
    expect(() => canonicalizeJson({ n: Number.NaN })).toThrow("$.n: refuses NaN");
    expect(() => canonicalizeJson({ n: Number.POSITIVE_INFINITY })).toThrow(
      "$.n: refuses Infinity",
    );
  });

  test("refuses -0", () => {
    expect(() => canonicalizeJson({ n: -0 })).toThrow("$.n: refuses -0");
  });

  test("refuses non-JSON types", () => {
    expect(() => canonicalizeJson({ n: 1n })).toThrow("$.n: refuses bigint");
    expect(() => canonicalizeJson({ f: () => 1 })).toThrow("$.f: refuses function");
    expect(() => canonicalizeJson({ s: Symbol("x") })).toThrow("$.s: refuses symbol");
  });

  test("refuses non-plain objects", () => {
    expect(() => canonicalizeJson({ d: new Date(0) })).toThrow(
      "$.d: refuses non-plain object (Date)",
    );
    expect(() => canonicalizeJson({ m: new Map() })).toThrow("$.m: refuses non-plain object (Map)");
  });

  test("refuses array holes", () => {
    const holey: unknown[] = [1, 3];
    delete holey[1];
    expect(() => canonicalizeJson({ a: holey })).toThrow(
      "$.a[1]: refuses undefined (not a JSON value)",
    );
  });

  test("refuses an empty tool name", () => {
    expect(() => canonicalActionHash("", {})).toThrow(CanonicalizationError);
  });
});

describe("canonical action hash", () => {
  test("pins the digest of a known action", () => {
    expect(canonicalActionHash("bash", { command: "echo hi" })).toBe(HASH_ECHO_HI);
  });

  test("key-order variants of equal args hash identically, nested included", () => {
    expect(canonicalActionHash("bash", { command: "echo hi", flags: { n: true } })).toBe(
      canonicalActionHash("bash", { flags: { n: true }, command: "echo hi" }),
    );
  });

  test("array order is not normalized: reordered args hash differently", () => {
    expect(canonicalActionHash("bash", { argv: ["a", "b"] })).not.toBe(
      canonicalActionHash("bash", { argv: ["b", "a"] }),
    );
  });

  test("different args under one tool hash differently", () => {
    expect(canonicalActionHash("bash", { command: "echo hi" })).not.toBe(
      canonicalActionHash("bash", { command: "echo bye" }),
    );
  });

  test("the same args under different tools hash differently", () => {
    expect(canonicalActionHash("bash", { text: "hi" })).not.toBe(
      canonicalActionHash("echo", { text: "hi" }),
    );
  });

  test("unicode is not normalized: NFC and NFD strings differ", () => {
    expect(canonicalActionHash("bash", { s: "caf\u00e9" })).not.toBe(
      canonicalActionHash("bash", { s: "cafe\u0301" }),
    );
  });
});

describe("grant record parsing", () => {
  test("accepts a valid record and canonicalizes its args", () => {
    const parsed = parseGrantRecord({ ...VALID_RECORD, normalizedArgs: { b: 1, a: 2 } });
    expect(canonicalJsonText(parsed.normalizedArgs)).toBe('{"a":2,"b":1}');
    expect(parsed.id).toBe("grant-1");
    expect(parsed.consumedBy).toBeNull();
    expect(parsed.tombstoned).toBeNull();
  });

  test("rejects a non-object", () => {
    expect(() => parseGrantRecord("grant-1")).toThrow("grant record must be a JSON object");
  });

  test("rejects unknown fields", () => {
    expect(() => parseGrantRecord({ ...VALID_RECORD, consumedAt: 1 })).toThrow(
      "grant record carries unknown field consumedAt",
    );
  });

  test("rejects a hash that does not match the scheme", () => {
    expect(() => parseGrantRecord({ ...VALID_RECORD, actionHash: "sha256:abc" })).toThrow(
      "actionHash must match v1:sha256:<64 lowercase hex>",
    );
  });

  test("rejects an expiry at or before issue time", () => {
    expect(() => parseGrantRecord({ ...VALID_RECORD, expiresAt: VALID_RECORD.issuedAt })).toThrow(
      "expiresAt must be a finite number greater than issuedAt",
    );
  });

  test("rejects non-JSON args", () => {
    expect(() => parseGrantRecord({ ...VALID_RECORD, normalizedArgs: { a: undefined } })).toThrow(
      GrantRecordError,
    );
  });
});

describe("recomputeActionHash", () => {
  test("reproduces the hash of a consistent record and exposes a forged one", () => {
    const genuine = parseGrantRecord(VALID_RECORD);
    expect(recomputeActionHash(genuine)).toBe(genuine.actionHash);
    const forged = { ...genuine, normalizedArgs: { command: "rm -rf /" } };
    expect(recomputeActionHash(forged)).not.toBe(forged.actionHash);
  });
});
