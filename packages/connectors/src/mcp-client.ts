/**
 * The MCP client: JSON-RPC 2.0 over the streamable HTTP transport, written here rather than
 * imported. The seam above it then has no vendor package in its import graph, and the wire below it
 * is the one the MCP specification names rather than one SDK's shape.
 *
 * The transport as the spec (revision 2025-06-18) states it, and as this client uses it:
 *
 * - every message is one POST to the endpoint, with `Accept: application/json, text/event-stream`;
 * - the answer is either a JSON body or an SSE stream whose `data:` line carries the same payload;
 * - `initialize` may answer with `Mcp-Session-Id`, which every later request repeats;
 * - `notifications/initialized` follows it, with no id and nothing to wait for.
 *
 * The protocol version is the one this client asks for. A server that answers with a different
 * version is taken at its word: the seam uses `tools/list` and `tools/call`, which both revisions
 * carry with the same shape. Whatever the person's credential is, it arrives through
 * `CredentialSource.headers()` at call time and reaches no error message this module builds.
 */

/** One tool as the wire reports it. `inputSchema` is passed through unread. */
export interface McpToolWire {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** One content block of a tool result. This client reads text and names anything else by its type. */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface McpCallResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

/** What `initialize` answered. The version and the server's name, neither of which is a secret. */
export interface McpServerInfo {
  readonly protocolVersion: string;
  readonly name: string;
  readonly version: string;
}

/** A JSON-RPC error, or an HTTP answer that is not one this client can read. */
export class McpError extends Error {
  readonly code: number | null;

  constructor(code: number | null, detail: string) {
    super(detail);
    this.name = "McpError";
    this.code = code;
  }
}

export interface McpClientOptions {
  readonly url: string;
  readonly clientName: string;
  readonly clientVersion: string;
  /** Read at call time, so a rotated credential needs no new client. */
  readonly headers?: () => Record<string, string>;
  readonly protocolVersion?: string;
  /** Injected for a unit test. Defaults to the global fetch. */
  readonly fetch?: FetchLike;
}

/** The one network call this client makes, so a test can drive the wire's two answer shapes. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The revision this client asks for. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The only two content types an answer to a request may carry. */
const ACCEPT = "application/json, text/event-stream";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The payload of an SSE body. One reply arrives as one event, so the first `data:` line carrying
 * JSON is the answer; anything after it belongs to a stream this client never opened.
 */
function payloadOfEventStream(body: string): unknown {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data.length === 0) continue;
    try {
      return JSON.parse(data);
    } catch {
      throw new McpError(null, `the event stream carried a data line that is not JSON: ${data}`);
    }
  }
  throw new McpError(null, "the event stream carried no data line");
}

export class McpClient {
  readonly #url: string;
  readonly #clientName: string;
  readonly #clientVersion: string;
  readonly #protocolVersion: string;
  readonly #headers: () => Record<string, string>;
  readonly #fetch: FetchLike;
  #sessionId: string | null = null;
  #nextId = 1;

  constructor(options: McpClientOptions) {
    this.#url = options.url;
    this.#clientName = options.clientName;
    this.#clientVersion = options.clientVersion;
    this.#protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.#headers = options.headers ?? (() => ({}));
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The handshake. A server that refuses this credential refuses here, before any tool is listed. */
  async initialize(): Promise<McpServerInfo> {
    const result = await this.#request("initialize", {
      protocolVersion: this.#protocolVersion,
      capabilities: {},
      clientInfo: { name: this.#clientName, version: this.#clientVersion },
    });
    if (!isRecord(result)) throw new McpError(null, "initialize answered no result object");
    const version = typeof result.protocolVersion === "string" ? result.protocolVersion : "unknown";
    const info = isRecord(result.serverInfo) ? result.serverInfo : {};
    await this.#notify("notifications/initialized", {});
    return {
      protocolVersion: version,
      name: typeof info.name === "string" ? info.name : "unknown",
      version: typeof info.version === "string" ? info.version : "unknown",
    };
  }

  async listTools(): Promise<readonly McpToolWire[]> {
    const result = await this.#request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new McpError(null, "tools/list answered no tools array");
    }
    return result.tools.flatMap((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") return [];
      return [
        {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
        },
      ];
    });
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const result = await this.#request("tools/call", { name, arguments: args });
    if (!isRecord(result)) throw new McpError(null, "tools/call answered no result object");
    const content = Array.isArray(result.content) ? result.content : [];
    return {
      content: content.flatMap((block) => {
        if (!isRecord(block) || typeof block.type !== "string") return [];
        return [
          { type: block.type, ...(typeof block.text === "string" ? { text: block.text } : {}) },
        ];
      }),
      ...(result.isError === true ? { isError: true } : {}),
    };
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    const response = await this.#post({ jsonrpc: "2.0", method, params });
    // A notification is answered with 202 and no body, and a server that answers 200 is also right.
    if (response.status >= 400) {
      throw new McpError(
        null,
        `${method} was refused with ${response.status}: ${await this.#refusalOf(response)}`,
      );
    }
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params });
    if (response.status >= 400) {
      throw new McpError(
        null,
        `${method} was refused with ${response.status}: ${await this.#refusalOf(response)}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const envelope = contentType.includes("text/event-stream")
      ? payloadOfEventStream(body)
      : body.trim().length === 0
        ? null
        : JSON.parse(body);
    if (!isRecord(envelope)) throw new McpError(null, `${method} answered no JSON-RPC envelope`);
    if ("error" in envelope) {
      const error = envelope.error;
      const code = isRecord(error) && typeof error.code === "number" ? error.code : null;
      const message =
        isRecord(error) && typeof error.message === "string" ? error.message : "no message";
      throw new McpError(code, `${method} failed (${code ?? "no code"}): ${message}`);
    }
    return envelope.result;
  }

  async #post(payload: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: ACCEPT,
      ...this.#headers(),
    };
    if (this.#sessionId !== null) headers["mcp-session-id"] = this.#sessionId;
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const minted = response.headers.get("mcp-session-id");
    if (minted !== null) this.#sessionId = minted;
    return response;
  }

  /** A refusal's own words, bounded, so an error message stays an error message. */
  async #refusalOf(response: Response): Promise<string> {
    const text = (await response.text()).trim().replaceAll("\n", " ");
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  }
}
