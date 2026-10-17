/**
 * The two workspace reads over the real HTTP surface: `POST /rpc/list_files` and `POST /rpc/read_file`
 * through oRPC, against the service the runs themselves use.
 *
 * Nothing here calls the service directly. Every assertion is about the bytes a client received over
 * a bound loopback socket, with the contract validating both ends, and the refusals are asserted as
 * the wire's own error codes rather than as strings a caller has to match.
 *
 * The bots root is a temporary directory, so the test writes the file it then reads and the escape
 * it then refuses, and the Bot it writes them into is one this test created.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import type { apiContract } from "@freebot/protocol";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { type ApiServer, startApiServer } from "./api-server.ts";
import { createRunService, type RunService } from "./run-service.ts";

type ApiClient = ContractRouterClient<typeof apiContract>;

const TOKEN = "files-routes-token";
const NOTE = "written by run-1\n";

const running: ApiServer[] = [];

afterEach(() => {
  for (const server of running.splice(0)) server.stop();
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const made: string[] = [];

/** A bots root of this test's own, and a directory outside it for the escape to point at. */
function botsRoot(): { bots: string; outside: string } {
  const bots = realpathSync(mkdtempSync(join(tmpdir(), "freebot-files-bots-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "freebot-files-out-")));
  made.push(bots, outside);
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  return { bots, outside };
}

/** One file and one symlink out of it, planted in a Bot's own workspace directory. */
function plant(root: string, outside: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "note.txt"), NOTE);
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
}

/** Never returns, so nothing this test does has to wait on a run. */
const heldProvider: ProviderPort = {
  next: () => new Promise(() => {}),
};

const unusedSandbox: SandboxPort = {
  async create() {},
  async execute() {
    throw new Error("this test starts no tool call");
  },
  async destroy() {},
};

function serve(bots: string): {
  server: ApiServer;
  service: RunService;
  client: ApiClient;
  botId: string;
} {
  const service = createRunService({
    botsRoot: bots,
    sandbox: unusedSandbox,
    provider: () => heldProvider,
  });
  const botId = service.createBot("Local Bot").id;
  const server = startApiServer({ port: 0, token: TOKEN, service });
  running.push(server);
  const client = createORPCClient<ApiClient>(
    new RPCLink({
      url: `http://127.0.0.1:${server.port}/rpc`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: `http://127.0.0.1:${server.port}`,
      },
    }),
  );
  return { server, service, client, botId };
}

/** The oRPC error a call rejected with, or the value it resolved with. */
async function outcome(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return { value: await call() };
  } catch (error) {
    const orpc = error as { code?: string; status?: number; message?: string };
    return { code: orpc.code, status: orpc.status, message: orpc.message };
  }
}

describe("list_files and read_file over the oRPC route surface", () => {
  test("the listing and the file's bytes come back over HTTP, from that Bot's workspace", async () => {
    const { bots, outside } = botsRoot();
    const { service, client, botId } = serve(bots);
    plant(service.workspaceFor(botId), outside);

    expect(service.workspaceFor(botId)).toBe(join(bots, botId, "workspace"));
    expect(await client.list_files({ botId })).toEqual({
      path: ".",
      entries: [
        {
          name: "escape.txt",
          path: "escape.txt",
          kind: "file",
          size: 0,
          mtimeMs: expect.any(Number),
        },
        {
          name: "note.txt",
          path: "note.txt",
          kind: "file",
          size: NOTE.length,
          mtimeMs: expect.any(Number),
        },
      ],
    });
    expect(await client.read_file({ botId, path: "note.txt" })).toEqual({
      path: "note.txt",
      text: NOTE,
      size: NOTE.length,
      truncated: false,
    });
  });

  test("a symlink out of the workspace is refused with its own code on the wire", async () => {
    const { bots, outside } = botsRoot();
    const { server, client, service, botId } = serve(bots);
    plant(service.workspaceFor(botId), outside);

    expect(await outcome(() => client.read_file({ botId, path: "escape.txt" }))).toEqual({
      code: "symlink_escape",
      status: 403,
      message: `symlink_escape: escape.txt resolves to ${join(outside, "secret.txt")}`,
    });

    const wire = await fetch(`http://127.0.0.1:${server.port}/rpc/read_file`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: JSON.stringify({ json: { botId, path: "escape.txt" } }),
    });
    expect(wire.status).toBe(403);
    expect(await wire.json()).toEqual({
      json: {
        defined: true,
        code: "symlink_escape",
        status: 403,
        message: `symlink_escape: escape.txt resolves to ${join(outside, "secret.txt")}`,
      },
    });
  });

  test("an absolute path and a .. segment are refused at the contract boundary", async () => {
    const { bots, outside } = botsRoot();
    const { client, service, botId } = serve(bots);
    plant(service.workspaceFor(botId), outside);

    expect(await outcome(() => client.read_file({ botId, path: "/etc/passwd" }))).toEqual({
      code: "BAD_REQUEST",
      status: 400,
      message: "Input validation failed",
    });
    expect(await outcome(() => client.list_files({ botId, path: "../.." }))).toEqual({
      code: "BAD_REQUEST",
      status: 400,
      message: "Input validation failed",
    });
    expect(await outcome(() => client.read_file({ botId, path: "nope.txt" }))).toEqual({
      code: "path_not_found",
      status: 404,
      message: "path_not_found: nope.txt",
    });
    expect(await outcome(() => client.list_files({ botId, path: "note.txt" }))).toEqual({
      code: "not_a_directory",
      status: 400,
      message: "not_a_directory: note.txt",
    });
  });

  test("one Bot's workspace is not another Bot's, and an unknown Bot is refused by name", async () => {
    const { bots, outside } = botsRoot();
    const { client, service, botId } = serve(bots);
    plant(service.workspaceFor(botId), outside);
    const other = service.createBot("Other");

    expect((await client.list_files({ botId })).entries.map((entry) => entry.name)).toEqual([
      "escape.txt",
      "note.txt",
    ]);
    expect(await client.list_files({ botId: other.id })).toEqual({ path: ".", entries: [] });
    expect(await outcome(() => client.read_file({ botId: other.id, path: "note.txt" }))).toEqual({
      code: "path_not_found",
      status: 404,
      message: "path_not_found: note.txt",
    });
    expect(
      await outcome(() => client.read_file({ botId: "bot-nowhere", path: "note.txt" })),
    ).toEqual({
      code: "bot_not_found",
      status: 404,
      message: "no such Bot: bot-nowhere",
    });
  });

  test("an unauthenticated read is refused before any handler runs", async () => {
    const { bots } = botsRoot();
    const { server } = serve(bots);

    const refusal = await fetch(`http://127.0.0.1:${server.port}/rpc/list_files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: JSON.stringify({ json: { botId: "bot-local", path: "." } }),
    });
    expect(refusal.status).toBe(401);
    expect(await refusal.json()).toEqual({
      error: { code: "token_missing", message: "missing bearer token" },
    });
  });
});
