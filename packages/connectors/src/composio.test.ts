/**
 * The Composio adapter against an emulated vendor, over real sockets rather than over a mock.
 *
 * Two services stand here, and the split is the vendor's own: the API base answers the session route
 * that mints an MCP endpoint, and the MCP endpoint is a real MCP server this file builds from the
 * package's own transport. The session route refuses a request with no project key, the MCP endpoint
 * refuses a request that does not carry the session's own header, and the note the tool writes lands
 * in the API base's own store, which these tests read back over its REST surface.
 *
 * What that makes provable rather than asserted in prose: the endpoint path is a path
 * (`POST /api/v3.1/tool_router/session`), the tool call changes the emulated service's state, a reset
 * returns it to empty so a second call works from nothing, and the person's project key reaches the
 * session route and nothing else. No Composio account and no network to Composio is involved, and
 * none is reachable from here: every address in this file is 127.0.0.1 on a port the OS picked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  COMPOSIO_API_BASE,
  COMPOSIO_KEY_HEADER,
  COMPOSIO_SESSION_PATH,
  ComposioConnector,
} from "./composio.ts";
import {
  type Connector,
  type CredentialSource,
  createMcpServer,
  type McpServer,
  offeredTools,
  tokenRef,
} from "./index.ts";

/** The value standing in for a person's own project key. It reaches the session route and no other. */
const PROJECT_KEY = "fixture-project-key-7a1c";
const CONNECTOR_ID = "fixture-composio";

interface Note {
  readonly number: number;
  readonly text: string;
}

interface SessionRequest {
  readonly key: string | null;
  readonly body: Record<string, unknown>;
}

interface Fixture {
  /** The API base: the address the session route answers on. */
  readonly apiBase: string;
  /** The MCP endpoint the session route names. */
  readonly mcpUrl: string;
  /** Every request the session route served, with the key it arrived carrying. */
  readonly sessionRequests: SessionRequest[];
  /** Every `authorization` header the MCP endpoint's gate saw, in order. */
  readonly endpointAuthorizations: Array<string | null>;
  /** The notes the API base holds right now, read over its own REST surface. */
  notes(): Promise<Note[]>;
  /** Empty the store, the way a fresh service would look. */
  reset(): void;
  close(): Promise<void>;
}

interface FixtureOptions {
  /** What the session route answers. Defaults to a session whose MCP endpoint is real. */
  readonly answer?: (input: { readonly mcpUrl: string; readonly sessionToken: string }) => unknown;
  /** The status a session request with the wrong key is refused with. Defaults to 401. */
  readonly refusalStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The emulated vendor: a session route over an in-memory store, and a real MCP server whose tools act
 * on that store over HTTP. Its two credentials are separate on purpose, because the custody claim is
 * about which one reaches where.
 */
async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const sessionToken = `session-${crypto.randomUUID()}`;
  const notes: Note[] = [];
  const sessionRequests: SessionRequest[] = [];
  const endpointAuthorizations: Array<string | null> = [];

  /** The API base's store, over its own REST surface. This is what the note tool calls. */
  const answer = (request: Request, path: string): Response => {
    const authorization = request.headers.get("authorization");
    if (authorization !== `Bearer ${sessionToken}`) {
      return new Response("no session credential", { status: 401 });
    }
    if (path === "/api/v3.1/notes") {
      return Response.json(notes);
    }
    return new Response("no such route", { status: 404 });
  };

  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === COMPOSIO_SESSION_PATH) {
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = await request.json();
          if (isRecord(parsed)) body = parsed;
        } catch {
          return new Response("the body is not JSON", { status: 400 });
        }
        const key = request.headers.get(COMPOSIO_KEY_HEADER);
        sessionRequests.push({ key, body });
        if (key !== PROJECT_KEY) {
          return new Response("invalid api key", { status: options.refusalStatus ?? 401 });
        }
        const shaped = options.answer?.({ mcpUrl: mcpUrl(), sessionToken }) ?? {
          session_id: `session-${sessionRequests.length}`,
          mcp: {
            type: "http",
            url: mcpUrl(),
            headers: { authorization: `Bearer ${sessionToken}` },
          },
          tool_router_tools: ["create_note", "list_notes"],
          config_version: 1,
        };
        return Response.json(shaped, { status: 201 });
      }
      if (url.pathname === "/api/v3.1/notes" && request.method === "POST") {
        const authorization = request.headers.get("authorization");
        if (authorization !== `Bearer ${sessionToken}`) {
          return new Response("no session credential", { status: 401 });
        }
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = await request.json();
          if (isRecord(parsed)) body = parsed;
        } catch {
          return new Response("the body is not JSON", { status: 400 });
        }
        const note = { number: notes.length + 1, text: String(body.text ?? "") };
        notes.push(note);
        return Response.json(note, { status: 201 });
      }
      return answer(request, url.pathname);
    },
  });
  const apiBase = `http://127.0.0.1:${api.port}`;

  const mcp: McpServer = createMcpServer({
    name: "composio-fixture",
    version: "1.0.0",
    tools: [
      {
        name: "create_note",
        description: "Store a note in the person's own account.",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        run: async (args) => {
          const text = isRecord(args) && typeof args.text === "string" ? args.text : null;
          if (text === null) return { text: "create_note needs text", isError: true };
          const response = await fetch(`${apiBase}/api/v3.1/notes`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${sessionToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ text }),
          });
          if (response.status !== 201) {
            return { text: `the account refused: ${response.status}`, isError: true };
          }
          return { text: await response.text() };
        },
      },
      {
        name: "list_notes",
        description: "List the notes in the person's own account.",
        parameters: { type: "object", properties: {} },
        run: async () => {
          const response = await fetch(`${apiBase}/api/v3.1/notes`, {
            headers: { authorization: `Bearer ${sessionToken}` },
          });
          return { text: await response.text() };
        },
      },
    ],
    // The endpoint's gate, exact match on the header the session answered with. A call carrying the
    // project key instead would be refused here, which is half of the custody proof.
    authorize: (request) => {
      const authorization = request.headers.get("authorization");
      endpointAuthorizations.push(authorization);
      return authorization === `Bearer ${sessionToken}` ? null : "no session credential";
    },
  });

  /** The MCP endpoint the session route names, defined after the server that answers it. */
  function mcpUrl(): string {
    return `${mcp.url}/mcp`;
  }

  return {
    apiBase,
    get mcpUrl() {
      return mcpUrl();
    },
    sessionRequests,
    endpointAuthorizations,
    async notes(): Promise<Note[]> {
      const response = await fetch(`${apiBase}/api/v3.1/notes`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      const parsed: unknown = await response.json();
      return Array.isArray(parsed) ? (parsed as Note[]) : [];
    },
    reset(): void {
      notes.length = 0;
    },
    async close(): Promise<void> {
      await mcp.close();
      await api.stop(true);
    },
  };
}

function credentialFor(token: string | null): CredentialSource {
  return {
    ref: tokenRef(`connector:${CONNECTOR_ID}`),
    headers: (): Record<string, string> => (token === null ? {} : { [COMPOSIO_KEY_HEADER]: token }),
  };
}

function connectorFor(fixture: Fixture, key: string | null = PROJECT_KEY): ComposioConnector {
  return new ComposioConnector({
    id: CONNECTOR_ID,
    userId: "fixture-person",
    apiBase: fixture.apiBase,
    credential: credentialFor(key),
  });
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function start(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = await startFixture(options);
  fixtures.push(fixture);
  return fixture;
}

describe("the Composio adapter over an emulated vendor", () => {
  test("the session route is the MCP endpoint's path, and the tools come from the endpoint it names", async () => {
    const fixture = await start();
    const connector = connectorFor(fixture);

    const offered = await offeredTools(connector);

    expect(offered.map((entry) => entry.name)).toEqual([
      `${CONNECTOR_ID}__create_note`,
      `${CONNECTOR_ID}__list_notes`,
    ]);
    expect(offered[0]?.tool).toBe("create_note");
    expect(offered[0]?.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    // One connector object, one session: the describe, the call and the probe below share it.
    expect(fixture.sessionRequests.map((request) => request.key)).toEqual([PROJECT_KEY]);
    expect(fixture.sessionRequests[0]?.body).toEqual({ user_id: "fixture-person" });
    expect(await connector.authenticate()).toBe(tokenRef(`connector:${CONNECTOR_ID}`));
    expect(await connector.health()).toEqual({
      ok: true,
      detail: "composio-fixture 1.0.0, protocol 2025-06-18, 2 tools",
    });
    expect(fixture.sessionRequests.length).toBe(1);
  });

  test("a tool call changes the emulated account's own state, and reset returns it to empty", async () => {
    const fixture = await start();
    const connector = connectorFor(fixture);

    expect(await fixture.notes()).toEqual([]);

    const first = await connector.call("create_note", { text: "first-note" });

    expect(first.ok).toBe(true);
    expect(first.output).toBe('{"number":1,"text":"first-note"}');
    expect(await fixture.notes()).toEqual([{ number: 1, text: "first-note" }]);

    fixture.reset();

    expect(await fixture.notes()).toEqual([]);
    const second = await connector.call("create_note", { text: "second-note" });
    expect(second.ok).toBe(true);
    expect(await fixture.notes()).toEqual([{ number: 1, text: "second-note" }]);
    // The reset session is the same one: the endpoint is unchanged, so the connector is too.
    expect(fixture.sessionRequests.length).toBe(1);
  });

  test("the project key reaches the session route and no other request anywhere", async () => {
    const fixture = await start();
    const connector = connectorFor(fixture);

    await connector.call("create_note", { text: "custody" });
    await connector.call("list_notes", {});
    await connector.describe();
    await connector.health();

    expect(fixture.sessionRequests.map((request) => request.key)).toEqual([PROJECT_KEY]);
    // The endpoint's gate saw the session's own header, never the key, and the call above would have
    // been refused 401 had the key been what travelled.
    expect(fixture.endpointAuthorizations.length).toBeGreaterThan(0);
    expect(
      fixture.endpointAuthorizations.every((value) => !String(value).includes(PROJECT_KEY)),
    ).toBe(true);
  });

  test("a session the vendor refuses is a health state, and no message carries the key", async () => {
    const fixture = await start();
    const connector = connectorFor(fixture, "not-the-project-key");

    const health = await connector.health();

    expect(health.ok).toBe(false);
    expect(health.detail).toContain("the session was refused with 401: invalid api key");
    expect(health.detail).not.toContain("not-the-project-key");

    const failure = await connector
      .call("create_note", { text: "refused" })
      .then(() => null)
      .catch((error: Error) => error.message);
    expect(failure).toContain(`connector ${CONNECTOR_ID}: the session was refused with 401`);
    expect(failure).not.toContain("not-the-project-key");
    expect(await fixture.notes()).toEqual([]);
    // A refusal is not cached, so a second attempt is a second session request rather than a stale no.
    expect(fixture.sessionRequests.length).toBe(2);
  });

  test("a session that answers a shape this seam cannot speak to is refused by name", async () => {
    const shapes: Array<{
      name: string;
      answer: (input: { mcpUrl: string; sessionToken: string }) => unknown;
      detail: string;
    }> = [
      {
        name: "no mcp object",
        answer: () => ({ session_id: "s" }),
        detail: "the session answered no mcp object",
      },
      {
        name: "a stdio endpoint",
        answer: ({ mcpUrl }: { mcpUrl: string }) => ({
          session_id: "s",
          mcp: { type: "stdio", url: mcpUrl },
        }),
        detail: "the session's MCP endpoint is type stdio, and this seam speaks http",
      },
      {
        name: "no url",
        answer: () => ({ session_id: "s", mcp: { type: "http" } }),
        detail: "the session's MCP endpoint has no URL",
      },
      {
        name: "a url that is not one",
        answer: () => ({ session_id: "s", mcp: { type: "http", url: "not a url" } }),
        detail: "the session's MCP endpoint is not a URL",
      },
      {
        name: "a protocol this seam cannot carry",
        answer: () => ({ session_id: "s", mcp: { type: "http", url: "file:///tmp/mcp" } }),
        detail: "the session's MCP endpoint is file:, and this seam speaks http",
      },
    ];

    for (const shape of shapes) {
      const fixture = await start({ answer: shape.answer });
      const health = await connectorFor(fixture).health();
      expect({ shape: shape.name, detail: health.detail }).toEqual({
        shape: shape.name,
        detail: `connector ${CONNECTOR_ID}: ${shape.detail}`,
      });
    }
  });

  test("a session that names no headers reaches the endpoint with none, and is refused by its gate", async () => {
    // The public schema documents no headers object, so this is the ordinary shape rather than a
    // malformed one. The endpoint's own gate is what says a call without them cannot proceed.
    const fixture = await start({
      answer: ({ mcpUrl }) => ({ session_id: "s", mcp: { type: "http", url: mcpUrl } }),
    });
    const connector = connectorFor(fixture);

    const health = await connector.health();

    expect(health.ok).toBe(false);
    expect(health.detail).toContain("401");
    expect(health.detail).not.toContain(PROJECT_KEY);
    expect(fixture.endpointAuthorizations).toContain(null);
  });

  test("the adapter is the same Connector the seam's consumer drives, as the MCP adapter is", async () => {
    const fixture = await start();
    const connector: Connector = connectorFor(fixture);

    const offered = await offeredTools(connector);
    const result = await connector.call("create_note", { text: "through the seam" });

    expect(offered.map((entry) => [entry.connectorId, entry.tool])).toEqual([
      [CONNECTOR_ID, "create_note"],
      [CONNECTOR_ID, "list_notes"],
    ]);
    expect(result).toEqual({ ok: true, output: '{"number":1,"text":"through the seam"}' });
    expect(connector.ref).toBe(tokenRef(`connector:${CONNECTOR_ID}`));
  });

  test("the hosted base is the vendor's own documented address, and the route is its documented path", () => {
    expect(COMPOSIO_API_BASE).toBe("https://backend.composio.dev");
    expect(COMPOSIO_SESSION_PATH).toBe("/api/v3.1/tool_router/session");
    expect(COMPOSIO_KEY_HEADER).toBe("x-api-key");
  });
});
