/**
 * `ComposioConnector`: the second adapter behind the connector seam, over Composio's hosted MCP
 * endpoint.
 *
 * Composio's MCP endpoint is per session rather than per account. A session is minted from the
 * person's own project key, and the endpoint the session answers with is where the tools live. This
 * module owns that path: one REST call to the vendor's documented session route, the endpoint and the
 * endpoint's own headers read off the session's answer, and then `McpConnector` over that endpoint.
 * MCP is still the wire and everything above the seam is unchanged, which is what "Composio is one
 * adapter" has to mean in code.
 *
 * What the vendor's own documentation fixes, and what the fixture therefore models rather than this
 * file inventing:
 *
 * - the session route is `POST /api/v3.1/tool_router/session` on the API base, authenticated with the
 *   project's key in the `x-api-key` header;
 * - the request names the person's own `user_id`, and may name the toolkits to offer;
 * - the answer names the session and carries `mcp: { type: "http", url }`, and the vendor's SDK hands
 *   `session.mcp.headers` to the MCP client beside it.
 *
 * Two rules this file enforces that the documentation leaves to the caller:
 *
 * - the project key reaches the session route and nothing else. The endpoint the session answers with
 *   gets the session's own headers when the session names any, and no credential when it does not,
 *   because a session-minting key is not an endpoint credential and the endpoint may sit on another
 *   host to the API base;
 * - the endpoint has to be one this seam speaks: an `http` or `https` URL behind an `mcp` object
 *   whose `type` is `http`. Anything else is refused by name rather than guessed at.
 *
 * Two things stay declared rather than proven, and `docs/connectors.md` carries both. The public
 * schema for the session answer lists `mcp.type` and `mcp.url` and no headers object while the SDK
 * exposes `session.mcp.headers`, so a session without one is ordinary here. And no session endpoint
 * of a real Composio account is ever reached, because this project owns no account (order 33): what
 * the fixture asserts is the custody claim, that the key reaches one session request on the base the
 * person configured.
 *
 * No vendor SDK is imported, and nothing re-exports this module from the package's own index. The
 * session call is written here the way `mcp-client.ts` writes the MCP wire, so the package still
 * declares no dependency, the neutral surface still names no vendor, and gate 8's delete test can
 * remove this file and leave the build and the suite standing.
 */

import {
  type Connector,
  ConnectorError,
  type ConnectorHealth,
  type ConnectorResult,
  type ConnectorTool,
  type CredentialSource,
  type TokenRef,
} from "./connector.ts";
import { McpConnector } from "./mcp-connector.ts";

/** Composio's hosted API base. A person running their own deployment passes theirs instead. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev";

/** The session route of Composio's REST API, answered with the session's hosted MCP endpoint. */
export const COMPOSIO_SESSION_PATH = "/api/v3.1/tool_router/session";

/** The header the person's own project key travels in, as the vendor's reference names it. */
export const COMPOSIO_KEY_HEADER = "x-api-key";

export interface ComposioConnectorOptions {
  /** The app's own handle for this connector, as for every adapter. */
  readonly id: string;
  /** The person's own identifier inside their project, sent as the session's `user_id`. */
  readonly userId: string;
  /** Their own deployment, when they run one. Read like the seam's other options. */
  readonly apiBase?: string;
  /** The toolkits the session should offer. Omitted, the session's own configuration decides. */
  readonly toolkits?: readonly string[];
  /** The person's own project key, read at call time and never logged. */
  readonly credential: CredentialSource;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The session's endpoint, read at the boundary. The vendor constrains `mcp.type` to `http`, which is
 * also the transport `McpConnector` speaks, so a session that answers any other shape is refused by
 * name instead of being handed to the wire.
 */
function endpointOf(answer: unknown): string {
  const mcp = isRecord(answer) ? answer.mcp : undefined;
  if (!isRecord(mcp)) throw new Error("the session answered no mcp object");
  if (mcp.type !== "http") {
    const named = typeof mcp.type === "string" ? `type ${mcp.type}` : "no type";
    throw new Error(`the session's MCP endpoint is ${named}, and this seam speaks http`);
  }
  if (typeof mcp.url !== "string" || mcp.url.length === 0) {
    throw new Error("the session's MCP endpoint has no URL");
  }
  return mcp.url;
}

/**
 * The headers the session says its endpoint wants, when it says. The public schema for the session
 * answer documents no headers object and the vendor's SDK exposes `session.mcp.headers` anyway, so an
 * answer without one is ordinary rather than malformed. Only string values are kept, because a header
 * that is not a string is not a header.
 */
function endpointHeadersOf(answer: unknown): Record<string, string> | null {
  const mcp = isRecord(answer) ? answer.mcp : undefined;
  const headers = isRecord(mcp) ? mcp.headers : undefined;
  if (!isRecord(headers)) return null;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") kept[name] = value;
  }
  return Object.keys(kept).length === 0 ? null : kept;
}

/** A refusal's own words, bounded, so an error message stays an error message. */
async function refusalOf(response: Response): Promise<string> {
  const text = (await response.text()).trim().replaceAll("\n", " ");
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** One resolved session: where the tools live, and what that endpoint wants beside a request. */
interface Session {
  readonly endpoint: string;
  /** Null when the session named no headers, which the public schema documents as the default. */
  readonly headers: Record<string, string> | null;
}

export class ComposioConnector implements Connector {
  readonly id: string;
  readonly ref: TokenRef;
  readonly #userId: string;
  readonly #apiBase: string;
  readonly #toolkits: readonly string[] | null;
  readonly #credential: CredentialSource;
  readonly #clientName: string;
  readonly #clientVersion: string;
  /** The session this object resolved, if it has. One object, one session, one endpoint. */
  #session: Promise<Session> | null = null;

  constructor(options: ComposioConnectorOptions) {
    this.id = options.id;
    this.ref = options.credential.ref;
    this.#userId = options.userId;
    this.#apiBase = (options.apiBase ?? COMPOSIO_API_BASE).replace(/\/+$/, "");
    this.#toolkits = options.toolkits ?? null;
    this.#credential = options.credential;
    this.#clientName = options.clientName ?? "freebot-connectors";
    this.#clientVersion = options.clientVersion ?? "0.0.0";
  }

  /**
   * The one session this object mints, so a describe, a call and a health probe share it rather than
   * spending a second key request each. A refusal is not kept: a service that was down for one probe
   * is not a connector that is dead for the launch, and the next call tries again.
   */
  #sessionOf(): Promise<Session> {
    this.#session ??= this.#mintSession().catch((error: unknown) => {
      this.#session = null;
      throw error;
    });
    return this.#session;
  }

  /**
   * The vendor's session call, with the person's own key. The key is read here at call time and
   * reaches this one request's headers. Nothing this method throws carries it: every message is built
   * from a status code, the seam's own words, and the service's refusal text.
   */
  async #mintSession(): Promise<Session> {
    const headers: Record<string, string> = {
      ...this.#credential.headers(),
      // After the credential, so a header map can never change what this request is.
      "content-type": "application/json",
    };
    const body = {
      user_id: this.#userId,
      ...(this.#toolkits === null ? {} : { toolkits: [...this.#toolkits] }),
    };
    let response: Response;
    try {
      response = await fetch(`${this.#apiBase}${COMPOSIO_SESSION_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ConnectorError(this.id, `the session could not be reached: ${messageOf(error)}`);
    }
    if (response.status >= 400) {
      throw new ConnectorError(
        this.id,
        `the session was refused with ${response.status}: ${await refusalOf(response)}`,
      );
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      throw new ConnectorError(this.id, "the session answered no JSON");
    }
    // Both halves of reading the answer refuse as this connector's own error, so a shape the seam
    // cannot speak to is named the way every other refusal here is.
    let endpoint: string;
    try {
      endpoint = this.#checkedEndpoint(endpointOf(answer));
    } catch (error) {
      throw new ConnectorError(this.id, messageOf(error));
    }
    return { endpoint, headers: endpointHeadersOf(answer) };
  }

  /** An endpoint this seam can carry: a URL, over a protocol `McpConnector` speaks. */
  #checkedEndpoint(url: string): string {
    let answered: URL;
    try {
      answered = new URL(url);
    } catch {
      throw new Error("the session's MCP endpoint is not a URL");
    }
    if (answered.protocol !== "http:" && answered.protocol !== "https:") {
      throw new Error(
        `the session's MCP endpoint is ${answered.protocol}, and this seam speaks http`,
      );
    }
    return url;
  }

  /** The endpoint, then the seam's own adapter over it. */
  async #connector(): Promise<McpConnector> {
    const session = await this.#sessionOf();
    return new McpConnector({
      id: this.id,
      url: session.endpoint,
      // The session's own headers when it named any, and nothing when it did not. The project key
      // stays on the session route, because it mints sessions and it is not this endpoint's
      // credential. Neither map is logged, and what reaches the wire reaches one request header.
      credential: { ref: this.ref, headers: () => session.headers ?? {} },
      clientName: this.#clientName,
      clientVersion: this.#clientVersion,
    });
  }

  async describe(): Promise<readonly ConnectorTool[]> {
    return await (await this.#connector()).describe();
  }

  async authenticate(): Promise<TokenRef> {
    return await (await this.#connector()).authenticate();
  }

  async call(tool: string, args: unknown): Promise<ConnectorResult> {
    return await (await this.#connector()).call(tool, args);
  }

  /** A probe, not a throw: a refused session or an unreachable endpoint is a state a surface renders. */
  async health(): Promise<ConnectorHealth> {
    try {
      return await (await this.#connector()).health();
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
  }
}
