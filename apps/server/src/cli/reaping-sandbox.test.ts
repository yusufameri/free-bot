/**
 * The reaper's own contract, pinned where the CLI cannot be driven cheaply: an engine that cannot
 * be asked throws from `holds`, and a throw is never read as an absent sandbox (a survey that
 * conflates the two once let the launcher report a live sandbox as removed).
 */

import { describe, expect, test } from "bun:test";
import type { SandboxProvider, SandboxSpec } from "@freebot/sandbox";
import { LaunchSandboxes } from "./reaping-sandbox.ts";
import type { SandboxBackend } from "./sandbox-backend.ts";

const SPEC = { name: "u95-reap-one", image: "freebot-sandbox:test" } as SandboxSpec;

function backendWith(
  holds: (name: string) => Promise<boolean>,
  onDelete: (name: string) => void = () => {},
): SandboxBackend {
  return {
    id: "docker",
    provider: {
      create: async (spec: SandboxSpec) => ({ provider: "docker", id: spec.name }),
      delete: async (handle: { id: string }) => {
        onDelete(handle.id);
      },
    } as unknown as SandboxProvider,
    holds,
    engineName: (name) => `freebot-sbx-${name}`,
  };
}

async function tracked(backend: SandboxBackend): Promise<LaunchSandboxes> {
  const sandboxes = new LaunchSandboxes(backend);
  await sandboxes.port().create(SPEC);
  return sandboxes;
}

describe("LaunchSandboxes.reap", () => {
  test("an inspection failure is not absence: it survives and is never forgotten", async () => {
    const sandboxes = await tracked(
      backendWith(async () => {
        throw new Error("the engine could not be asked");
      }),
    );
    const first = await sandboxes.reap();
    expect(first.removed).toEqual([]);
    expect(first.surviving).toEqual(["freebot-sbx-u95-reap-one"]);
    const second = await sandboxes.reap();
    expect(second.surviving).toEqual(["freebot-sbx-u95-reap-one"]);
  });

  test("a sandbox the engine answers gone for is removed without a delete attempt", async () => {
    const deleted: string[] = [];
    const sandboxes = await tracked(
      backendWith(
        async () => false,
        (name) => deleted.push(name),
      ),
    );
    const first = await sandboxes.reap();
    expect(first.removed).toEqual(["freebot-sbx-u95-reap-one"]);
    expect(first.surviving).toEqual([]);
    expect(deleted).toEqual([]);
    const second = await sandboxes.reap();
    expect(second.removed).toEqual([]);
    expect(second.surviving).toEqual([]);
  });

  test("a held sandbox counts as removed only once the engine answers it is gone", async () => {
    let alive = true;
    const deleted: string[] = [];
    const sandboxes = await tracked(
      backendWith(
        async () => alive,
        (name) => {
          deleted.push(name);
          alive = false;
        },
      ),
    );
    const result = await sandboxes.reap();
    expect(deleted).toEqual(["u95-reap-one"]);
    expect(result.removed).toEqual(["freebot-sbx-u95-reap-one"]);
    expect(result.surviving).toEqual([]);
  });
});
