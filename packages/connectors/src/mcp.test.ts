/**
 * The MCP adapter against a real MCP server, over the wire rather than over a mock.
 *
 * The server is this package's own streamable-HTTP implementation, so what these tests prove is that
 * the client and the server agree about the handshake, the session header, `tools/list` and
 * `tools/call`, including the two shapes a real server may answer a call in: a text result and a
 * result the tool itself calls a failure. The same consumer the boundary test drives over the stub
 * is driven here over the MCP adapter, which is what makes the two adapters interchangeable rather
 * than merely similar.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type Connector,
  type CredentialSource,
  createMcpServer,
  McpClient,
  McpConnector,
  type McpServer,
  offeredTools,
  tokenRef,
} from "./index.ts";

/** The per-test value standing in for a person's credential. It reaches one header and no output. */
const TOKEN = "fixture-credential-9f21";

function credentialFor(token: string | null): CredentialSource {
  return {
    ref: tokenRef("fixture:mcp-test"),
    headers: (): Record<string, string> =>
      token === null ? {} : { authorization: `Bearer ${token}` },
  };
}

function fixtureServer(port = 0): McpServer {
  return createMcpServer({
    name: "freebot-fixture",
    version: "1.2.3",
    port,
    tools: [
      {
        name: "create_issue",
        description: "Open an issue.",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        run: async (args) => ({
          text: JSON.stringify({ created: (args as { title?: unknown }).title ?? null, number: 1 }),
        }),
      },
      {
        name: "closed_issues",
        description: "List what is closed.",
        parameters: { type: "object", properties: {} },
        run: async () => ({ text: "this tool cannot answer", isError: true }),
      },
    ],
    authorize: (request) =>
      request.headers.get("authorization") === `Bearer ${TOKEN}` ? null : "no credential",
  });
}

const servers: McpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("the MCP adapter over a real server", () => {
  test("the handshake reports the server, and the tools come from the server's own list", async () => {
    const server = fixtureServer();
    servers.push(server);
    const connector = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor(TOKEN),
    });

    expect(await connector.authenticate()).toBe(tokenRef("fixture:mcp-test"));
    const offered = await offeredTools(connector);

    expect(offered.map((entry) => entry.name)).toEqual([
      "fixture-github__create_issue",
      "fixture-github__closed_issues",
    ]);
    expect(offered[0]?.description).toBe("Open an issue.");
    expect(offered[0]?.parameters).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    expect(await connector.health()).toEqual({
      ok: true,
      detail: "freebot-fixture 1.2.3, protocol 2025-06-18, 2 tools",
    });
  });

  test("a call reaches the tool and carries its result back as the text the model reads", async () => {
    const server = fixtureServer();
    servers.push(server);
    const connector = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor(TOKEN),
    });

    const result = await connector.call("create_issue", { title: "from the seam" });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('{"created":"from the seam","number":1}');
    expect(server.calls).toEqual(['create_issue {"title":"from the seam"}']);
  });

  test("a tool that reports a failure is a refusal the caller can see, not a thrown error", async () => {
    const server = fixtureServer();
    servers.push(server);
    const connector = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor(TOKEN),
    });

    const result = await connector.call("closed_issues", {});

    expect(result.ok).toBe(false);
    expect(result.output).toBe("this tool cannot answer");
  });

  test("a credential the server refuses fails the call, and no message carries the value", async () => {
    const server = fixtureServer();
    servers.push(server);
    const wrong = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor("not-the-credential"),
    });
    const none = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor(null),
    });

    const refused = await none.health();
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("initialize was refused with 401: no credential");
    expect(refused.detail).not.toContain(TOKEN);

    const failure = await wrong
      .call("create_issue", {})
      .then(() => null)
      .catch((error: Error) => error.message);
    expect(failure).toContain("connector fixture-github: initialize was refused with 401");
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain("not-the-credential");
  });

  test("an unknown tool is refused by the server and named in the seam's error", async () => {
    const server = fixtureServer();
    servers.push(server);
    const connector = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor(TOKEN),
    });

    const message = await connector
      .call("no_such_tool", {})
      .then(() => null)
      .catch((error: Error) => error.message);

    expect(message).toBe(
      "connector fixture-github: tools/call failed (-32602): no such tool: no_such_tool",
    );
  });

  test("a server that answers a request as an event stream is read the same way", async () => {
    const client = new McpClient({
      url: "http://fixture.invalid/mcp",
      clientName: "test",
      clientVersion: "0.0.0",
      fetch: async () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "one_tool", description: "One." }] },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });

    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["one_tool"]);
  });

  test("the session the handshake minted rides every later message, and a notification has no id", async () => {
    const seen: Array<{ header: string | null; body: Record<string, unknown> }> = [];
    const client = new McpClient({
      url: "http://fixture.invalid/mcp",
      clientName: "test",
      clientVersion: "0.0.0",
      fetch: async (_url, init) => {
        seen.push({
          header: new Headers(init?.headers).get("mcp-session-id"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const id = seen.length;
        return new Response(
          JSON.stringify(
            id === 1
              ? {
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    protocolVersion: "2025-06-18",
                    serverInfo: { name: "s", version: "1" },
                  },
                }
              : { jsonrpc: "2.0", id, result: { tools: [] } },
          ),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              ...(id === 1 ? { "mcp-session-id": "session-abc" } : {}),
            },
          },
        );
      },
    });

    await client.initialize();

    expect(seen.map((entry) => [entry.header, entry.body.method, entry.body.id])).toEqual([
      [null, "initialize", 1],
      ["session-abc", "notifications/initialized", undefined],
    ]);
  });

  test("a request without the session the server minted is refused", async () => {
    const server = fixtureServer();
    servers.push(server);

    const refused = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe("no session: initialize first");
  });

  test("a server that cannot be reached is a health state rather than a crash", async () => {
    const connector = new McpConnector({
      id: "fixture-github",
      url: "http://127.0.0.1:1/mcp",
      credential: credentialFor(TOKEN),
    });

    const health = await connector.health();

    expect(health.ok).toBe(false);
    expect(health.detail.length).toBeGreaterThan(0);
  });
});

describe("the MCP adapter's place in the seam", () => {
  test("the same consumer runs over the MCP adapter and reports the same shape as the stub", async () => {
    const server = fixtureServer();
    servers.push(server);
    const connector: Connector = new McpConnector({
      id: "fixture-github",
      url: server.url,
      credential: credentialFor(TOKEN),
    });

    const offered = await offeredTools(connector);
    const result = await connector.call("create_issue", { title: "seam" });

    expect(offered.map((entry) => [entry.connectorId, entry.tool])).toEqual([
      ["fixture-github", "create_issue"],
      ["fixture-github", "closed_issues"],
    ]);
    expect(result).toEqual({ ok: true, output: '{"created":"seam","number":1}' });
  });
});
