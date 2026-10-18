/**
 * `McpConnector`: the seam over the MCP client. One adapter, and the one every connector goes
 * through by default, because MCP is the wire a person's own server already speaks.
 *
 * The adapter is thin on purpose. It owns no tool table of its own: `describe` asks the server, so
 * a tool the person's server adds appears at the next run, and a call names the tool by the name the
 * server itself reported.
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
import { McpClient, type McpContentBlock } from "./mcp-client.ts";

export interface McpConnectorOptions {
  readonly id: string;
  readonly url: string;
  readonly credential: CredentialSource;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/**
 * The text a model reads off a tool result: every text block in order, and one line naming anything
 * else by its type, so a result shape this seam does not read is visible rather than silently empty.
 */
export function outputOf(content: readonly McpContentBlock[]): string {
  const parts = content.map((block) =>
    block.type === "text" && block.text !== undefined ? block.text : `[${block.type} content]`,
  );
  return parts.join("\n");
}

export class McpConnector implements Connector {
  readonly id: string;
  readonly ref: TokenRef;
  readonly #url: string;
  readonly #credential: CredentialSource;
  readonly #clientName: string;
  readonly #clientVersion: string;

  constructor(options: McpConnectorOptions) {
    this.id = options.id;
    this.ref = options.credential.ref;
    this.#url = options.url;
    this.#credential = options.credential;
    this.#clientName = options.clientName ?? "freebot-connectors";
    this.#clientVersion = options.clientVersion ?? "0.0.0";
  }

  #client(): McpClient {
    return new McpClient({
      url: this.#url,
      clientName: this.#clientName,
      clientVersion: this.#clientVersion,
      headers: () => this.#credential.headers(),
    });
  }

  async describe(): Promise<readonly ConnectorTool[]> {
    const client = this.#client();
    try {
      await client.initialize();
      const tools = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      }));
    } catch (error) {
      throw new ConnectorError(this.id, messageOf(error));
    }
  }

  async authenticate(): Promise<TokenRef> {
    const client = this.#client();
    try {
      await client.initialize();
    } catch (error) {
      throw new ConnectorError(this.id, messageOf(error));
    }
    return this.#credential.ref;
  }

  async call(tool: string, args: unknown): Promise<ConnectorResult> {
    const client = this.#client();
    try {
      await client.initialize();
      const result = await client.callTool(tool, args);
      return { ok: result.isError !== true, output: outputOf(result.content) };
    } catch (error) {
      throw new ConnectorError(this.id, messageOf(error));
    }
  }

  /** A probe, not a throw: a surface renders an unreachable connector as a state. */
  async health(): Promise<ConnectorHealth> {
    const client = this.#client();
    try {
      const info = await client.initialize();
      const tools = await client.listTools();
      return {
        ok: true,
        detail: `${info.name} ${info.version}, protocol ${info.protocolVersion}, ${tools.length} tools`,
      };
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
