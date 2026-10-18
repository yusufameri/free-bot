/**
 * The connector's far side in the evidence run: a real MCP server whose two tools act on the
 * emulated GitHub service.
 *
 * The server is `packages/connectors`' own streamable-HTTP implementation, so the run drives the
 * wire the seam's client implements rather than a stand-in for it. What this module adds is the
 * difference between the wire and a service: the tools, and the credential gate in front of them.
 *
 * Two credentials exist in this fixture, and separating them is the point:
 *
 * - the *connector's* credential is this server's bearer token, minted per run. The launcher holds
 *   it in `connectors.json` and the seam puts it on one request header;
 * - the *service's* credential is the emulator's token, held only by this module's closures. The
 *   seam's client never sees it, so a leak of the connector's credential is not a leak of the
 *   service's.
 *
 * The gate compares the header exactly, so a call with no credential and a call with a wrong one
 * both refuse with 401 — unlike the emulated service, which is a fixture and accepts any bearer
 * write. A driver that asserts a refusal through the connector is asserting this gate.
 */

import { createMcpServer, type McpServer } from "@freebot/connectors";
import type { GithubFixture } from "./emulator.ts";

export interface GithubConnectorOptions {
  /** The service the tools act on. Its token stays inside this module's handlers. */
  readonly fixture: GithubFixture;
  /** The MCP server's own name, which the handshake reports and the health row shows. */
  readonly name: string;
  readonly version: string;
}

export interface GithubConnector {
  /** The endpoint a connector points at, with the tool path the transport needs. */
  readonly url: string;
  readonly port: number;
  /** The connector's credential: this server's bearer token, minted per run. */
  readonly token: string;
  /** Every tool call this server served, as the name and args it was given. */
  readonly calls: readonly string[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(args: unknown, name: string): string | null {
  if (!isRecord(args)) return null;
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createGithubConnector(options: GithubConnectorOptions): GithubConnector {
  const { fixture } = options;
  const token = `mcp-fixture-${crypto.randomUUID()}`;
  const issuesPath = `/repos/${fixture.owner}/${fixture.repo}/issues`;

  const service = async (
    path: string,
    init: { readonly method?: "POST"; readonly body?: string } = {},
  ): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${fixture.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${fixture.token}`,
        accept: "application/vnd.github+json",
        ...(init.method === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    return { status: response.status, body: await response.text() };
  };

  const server: McpServer = createMcpServer({
    name: options.name,
    version: options.version,
    tools: [
      {
        name: "create_issue",
        description: `Open an issue on ${fixture.owner}/${fixture.repo}.`,
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "The issue's title." },
            body: { type: "string", description: "The issue's body." },
          },
          required: ["title"],
        },
        run: async (args) => {
          const title = stringField(args, "title");
          if (title === null) return { text: "create_issue needs a title", isError: true };
          const body = stringField(args, "body");
          const answer = await service(issuesPath, {
            method: "POST",
            body: JSON.stringify(body === null ? { title } : { title, body }),
          });
          if (answer.status !== 201) {
            return { text: `the service refused: ${answer.status} ${answer.body}`, isError: true };
          }
          const parsed: unknown = JSON.parse(answer.body);
          const issue = isRecord(parsed) ? parsed : {};
          return {
            text: JSON.stringify({
              number: issue.number ?? null,
              title: issue.title ?? null,
              state: issue.state ?? null,
              url: issue.html_url ?? null,
            }),
          };
        },
      },
      {
        name: "list_issues",
        description: `List the open issues on ${fixture.owner}/${fixture.repo}.`,
        parameters: { type: "object", properties: {} },
        run: async () => {
          const answer = await service(`${issuesPath}?state=all`);
          if (answer.status !== 200) {
            return { text: `the service refused: ${answer.status} ${answer.body}`, isError: true };
          }
          const parsed: unknown = JSON.parse(answer.body);
          const rows = Array.isArray(parsed) ? parsed : [];
          return {
            text: JSON.stringify(
              rows.map((row) =>
                isRecord(row) ? { number: row.number, title: row.title, state: row.state } : null,
              ),
            ),
          };
        },
      },
    ],
    // The gate a connector authenticates against. Exact match, so a missing credential and a
    // wrong one are the same refusal, and the refusal never repeats what arrived.
    authorize: (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? null : "no credential",
  });

  return {
    url: server.url,
    port: server.port,
    token,
    calls: server.calls,
    close: () => server.close(),
  };
}
