/**
 * The run service's own contract: one log and one run store serve every run it starts.
 *
 * The surface tests live in `router.test.ts` (over oRPC) and `api-server.test.ts` (over the
 * transports). What is left here is the property those two cannot show: two runs that start in the
 * same tick share one seq space, which is what one log for the whole service means.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import type { SandboxSpec } from "@freebot/sandbox";
import { createRunService } from "./run-service.ts";

const unusedSandbox: SandboxPort = {
  async create() {},
  async execute() {
    throw new Error("this test starts no tool call");
  },
  async destroy() {},
};

/** One turn of text and no call, so a run finishes in the fewest frames it can. */
const immediateProvider: ProviderPort = {
  async next() {
    return { text: ["ok"], toolCalls: [] };
  },
};

const idleSandbox: SandboxPort = {
  async create() {},
  async execute() {
    throw new Error("this test starts no tool call");
  },
  async destroy() {},
};

describe("one log for every run the service starts", () => {
  test("two runs started in the same tick share one seq space and both finish", async () => {
    const service = createRunService({ sandbox: idleSandbox, provider: () => immediateProvider });

    const first = service.start("one");
    const second = service.start("two");
    await service.idle();

    expect(service.store.get(first.runId)?.status).toBe("done");
    expect(service.store.get(second.runId)?.status).toBe("done");

    const frames = service.log.since(0).map((entry) => entry.frame);
    expect(frames.every((frame, index) => frame.seq === index + 1)).toBe(true);
    expect([...new Set(frames.map((frame) => frame.runId))].sort()).toEqual([
      first.runId,
      second.runId,
    ]);
    expect(service.log.audit()).toMatchObject({
      firstSeq: 1,
      count: frames.length,
      gaps: [],
      duplicates: [],
      rejected: 0,
    });
  });

  test("two subscribers both see every frame, in seq order", async () => {
    const service = createRunService({ sandbox: unusedSandbox, provider: () => immediateProvider });
    const controller = new AbortController();
    const seen: number[][] = [[], []];
    const pumps = seen.map(async (list) => {
      for await (const message of service.stream(0, controller.signal)) list.push(message.seq);
    });

    const { runId } = service.start("one");
    await service.idle();

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !seen.every((list) => list.length === service.log.lastSeq)) {
      await Bun.sleep(10);
    }
    controller.abort();
    await Promise.all(pumps);

    expect(service.store.get(runId)?.status).toBe("done");
    expect(seen[0]?.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.every((seq, index) => seq === index + 1)).toBe(true);
  });
});

describe("the Bot's workspace", () => {
  test("every run mounts the service's workspace directory at /workspace", async () => {
    const specs: SandboxSpec[] = [];
    const service = createRunService({
      workspace: join(tmpdir(), "freebot-run-service-ws"),
      sandbox: {
        async create(spec) {
          specs.push(spec);
        },
        async execute() {
          throw new Error("this test starts no tool call");
        },
        async destroy() {},
      },
      provider: () => immediateProvider,
    });

    service.start("one");
    await service.idle();

    expect(specs.map((spec) => spec.mounts)).toEqual([
      [{ host: service.workspace.root, container: "/workspace" }],
    ]);
  });
});
