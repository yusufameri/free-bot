/**
 * Page 1's server side: the save, the test's outcome, and the proof that the key cannot come back.
 *
 * Every case drives `connectProvider` over a scripted test, so no case touches a network and no case
 * needs a provider. The key travels one way only: the vault file gets it, and the record, the
 * `describeProvider` answer, and the test's own parameters are asserted not to carry it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityTurn } from "@freebot/providers";
import { ProviderAuthError } from "@freebot/providers";
import {
  connectProvider,
  describeProvider,
  type ProviderPaths,
  providerPaths,
  readProviderRecord,
} from "./provider-setup.ts";
import { readVault, writeVault } from "./vault.ts";

const dirs: string[] = [];

/** A placeholder, not a credential: this test never leaves the machine. */
const FIXTURE_KEY = "placeholder-for-the-provider-setup-test";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "freebot-provider-setup-"));
  dirs.push(dir);
  return dir;
}

function pathsUnder(dir: string): ProviderPaths {
  return { vault: join(dir, "provider.env"), record: join(dir, "provider.json") };
}

function turn(flags: Partial<CapabilityTurn["flags"]>, answer: string): CapabilityTurn {
  return {
    flags: {
      toolCalling: "strong",
      streaming: true,
      structuredOutput: null,
      contextWindow: null,
      notes: [],
      ...flags,
    },
    observation: {
      toolCallsCompleted: 1,
      toolNames: ["freebot_smoke_echo"],
      textDeltas: 3,
      toolCallDeltas: 1,
      assistantMessages: 0,
      assistantText: answer,
      executions: [],
      settled: true,
    },
    structured: null,
    answer,
    toolNames: ["freebot_smoke_echo"],
    offered: ["freebot_smoke_echo"],
    requests: 2,
  };
}

const CAPABLE = { baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini", key: FIXTURE_KEY };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writing the vault", () => {
  test("a save puts the key in the vault at mode 600 and replaces what was there", () => {
    const dir = home();
    const target = join(dir, "provider.env");
    writeFileSync(target, `FREEBOT_BYOK_KEY=the-key-that-was-there\n`);
    chmodSync(target, 0o644);

    writeVault({ key: FIXTURE_KEY, baseUrl: CAPABLE.baseUrl, model: CAPABLE.model }, target);

    expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
    expect(readVault(target)).toEqual({
      key: FIXTURE_KEY,
      baseUrl: CAPABLE.baseUrl,
      model: CAPABLE.model,
    });
    expect(readFileSync(target, "utf8")).not.toContain("the-key-that-was-there");
  });

  test("a save makes the directory it needs, at mode 700", () => {
    const dir = home();
    const nested = join(dir, "freebot");
    writeVault({ key: FIXTURE_KEY, baseUrl: CAPABLE.baseUrl, model: CAPABLE.model }, join(nested, "provider.env"));

    expect((statSync(nested).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(join(nested, "provider.env")).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("connecting a provider", () => {
  test("a capable test saves the flags and answers with them", async () => {
    const paths = pathsUnder(home());
    const connection = await connectProvider(CAPABLE, {
      paths,
      now: () => 1_792_221_550_000,
      test: async () => turn({}, "save-time-smoke"),
    });

    expect(connection).toEqual({
      baseUrl: CAPABLE.baseUrl,
      model: CAPABLE.model,
      status: "capable",
      testedAt: 1_792_221_550_000,
      flags: {
        toolCalling: "strong",
        streaming: true,
        structuredOutput: null,
        contextWindow: null,
        notes: [],
      },
      refusal: null,
      answer: "save-time-smoke",
    });
    expect(describeProvider(paths)).toEqual({
      vault: { path: paths.vault, present: true, mode: "600" },
      connection,
    });
    expect((statSync(paths.record).mode & 0o777).toString(8)).toBe("600");
  });

  test("a reply with no tool call stores the weaker capability", async () => {
    const paths = pathsUnder(home());
    const connection = await connectProvider(CAPABLE, {
      paths,
      test: async () =>
        turn({ toolCalling: "weak", structuredOutput: true }, "I cannot call tools."),
    });

    expect(connection.status).toBe("limited");
    expect(connection.flags?.toolCalling).toBe("weak");
    expect(connection.refusal).toBeNull();
    expect(connection.answer).toBe("I cannot call tools.");
  });

  test("a refusal saves the connection marked untested, with the provider's status code", async () => {
    const paths = pathsUnder(home());
    const connection = await connectProvider(CAPABLE, {
      paths,
      test: async () => {
        throw new ProviderAuthError(401, "invalid api key");
      },
    });

    expect(connection.status).toBe("untested");
    expect(connection.flags).toBeNull();
    expect(connection.refusal).toEqual({
      status: 401,
      message: "auth rejected (401): invalid api key",
    });
    expect(readVault(paths.vault)).toEqual({
      key: FIXTURE_KEY,
      baseUrl: CAPABLE.baseUrl,
      model: CAPABLE.model,
    });
  });

  test("the key reaches the vault file and nothing else the save produces", async () => {
    const paths = pathsUnder(home());
    const asked: Array<Record<string, string>> = [];
    const connection = await connectProvider(CAPABLE, {
      paths,
      test: async (options) => {
        asked.push({ baseUrl: options.baseUrl, model: options.model, apiKey: options.apiKey });
        return turn({}, "save-time-smoke");
      },
    });

    expect(asked).toEqual([{ baseUrl: CAPABLE.baseUrl, model: CAPABLE.model, apiKey: FIXTURE_KEY }]);
    expect(JSON.stringify(connection)).not.toContain(FIXTURE_KEY);
    expect(readFileSync(paths.record, "utf8")).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(describeProvider(paths))).not.toContain(FIXTURE_KEY);
    expect(readFileSync(paths.vault, "utf8")).toContain(FIXTURE_KEY);
  });
});

describe("reading page 1's state", () => {
  test("no vault is the keyless machine, and the connection is null", () => {
    const paths = pathsUnder(home());

    expect(describeProvider(paths)).toEqual({
      vault: { path: paths.vault, present: false, mode: null },
      connection: null,
    });
  });

  test("a hand-written vault is a connection nobody has tested", () => {
    const paths = pathsUnder(home());
    writeVault({ key: FIXTURE_KEY, baseUrl: CAPABLE.baseUrl, model: CAPABLE.model }, paths.vault);

    const state = describeProvider(paths);

    expect(state.connection?.status).toBe("untested");
    expect(state.connection?.flags).toBeNull();
    expect(state.connection?.testedAt).toBeNull();
  });

  test("a record measured on another endpoint reads untested, so a stale capable cannot survive", async () => {
    const paths = pathsUnder(home());
    await connectProvider(CAPABLE, { paths, test: async () => turn({}, "save-time-smoke") });
    writeVault({ key: FIXTURE_KEY, baseUrl: "https://other.example.com/v1", model: "another-model" }, paths.vault);

    const state = describeProvider(paths);

    expect(state.connection?.baseUrl).toBe("https://other.example.com/v1");
    expect(state.connection?.model).toBe("another-model");
    expect(state.connection?.status).toBe("untested");
    expect(state.connection?.flags).toBeNull();
    expect(readProviderRecord(paths)?.status).toBe("capable");
  });

  test("a record file that is not the shape this contract ships is ignored, not trusted", () => {
    const paths = pathsUnder(home());
    writeVault({ key: FIXTURE_KEY, baseUrl: CAPABLE.baseUrl, model: CAPABLE.model }, paths.vault);
    writeFileSync(paths.record, JSON.stringify({ status: "capable", key: FIXTURE_KEY }));

    expect(readProviderRecord(paths)).toBeNull();
    expect(describeProvider(paths).connection?.status).toBe("untested");
  });

  test("the two default paths are FREEBOT_HOME's, and the record never holds a key", () => {
    expect(providerPaths({ FREEBOT_HOME: "/tmp/freebot-home" })).toEqual({
      vault: "/tmp/freebot-home/provider.env",
      record: "/tmp/freebot-home/provider.json",
    });
  });
});
