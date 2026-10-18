/**
 * A real MCP server over the streamable HTTP transport, in this package because two callers need
 * one and neither may invent the wire twice: the client's own tests drive it, and the evidence
 * harness builds the fixture connector's tool set on top of it.
 *
 * It is a server, not a mock. It answers the handshake, a session header, `tools/list` and
 * `tools/call` the way the specification (revision 2025-06-18) says, so a client that passes here
 * has passed against the wire rather than against its own opinion of it. What each tool *does* is
 * the caller's: the tool set arrives as handlers, and the harness's handlers call the emulated
 * service. Nothing here logs a request header.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface McpServerTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  run(args: unknown): Promise<{ readonly text: string; readonly isError?: boolean }>;
}

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpServerTool[];
  /**
   * The request gate. Returning a string refuses the request with that line and a 401, so a test
   * can prove the credential is required rather than merely sent.
   */
  readonly authorize?: (request: Request) => string | null;
  readonly port?: number;
  readonly hostname?: string;
}

export interface McpServer {
  readonly url: string;
  readonly port: number;
  /** Every tool call this server served, in order, as its own name and the arguments it was given. */
  readonly calls: readonly string[];
  readonly protocolVersion: string;
  close(): Promise<void>;
}

interface RpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const calls: string[] = [];
  const sessions = new Set<string>();

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response("this server speaks the streamable HTTP transport: POST a message", {
          status: 405,
        });
      }
      const refusal = options.authorize?.(request);
      if (refusal !== undefined && refusal !== null) {
        return new Response(refusal, { status: 401 });
      }
      let message: RpcRequest;
      try {
        message = (await request.json()) as RpcRequest;
      } catch {
        return rpcError(null, -32700, "the body is not JSON");
      }
      const method = typeof message.method === "string" ? message.method : "";

      if (method === "initialize") {
        const sessionId = crypto.randomUUID();
        sessions.add(sessionId);
        const params = (message.params ?? {}) as { protocolVersion?: unknown };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id ?? null,
            result: {
              protocolVersion:
                typeof params.protocolVersion === "string"
                  ? params.protocolVersion
                  : PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: options.name, version: options.version },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": sessionId },
          },
        );
      }

      const session = request.headers.get("mcp-session-id");
      if (session === null || !sessions.has(session)) {
        return new Response("no session: initialize first", { status: 404 });
      }

      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (method === "tools/list") {
        return rpcResult(message.id, {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        });
      }
      if (method === "tools/call") {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== "string" || !byName.has(params.name)) {
          return rpcError(message.id, -32602, `no such tool: ${String(params.name)}`);
        }
        const tool = byName.get(params.name);
        if (tool === undefined) return rpcError(message.id, -32602, "no such tool");
        calls.push(`${params.name} ${JSON.stringify(params.arguments ?? {})}`);
        try {
          const outcome = await tool.run(params.arguments ?? {});
          return rpcResult(message.id, {
            content: [{ type: "text", text: outcome.text }],
            ...(outcome.isError === true ? { isError: true } : {}),
          });
        } catch (error) {
          return rpcError(
            message.id,
            -32603,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return rpcError(message.id, -32601, `no such method: ${method}`);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port ?? 0}`,
    port: server.port ?? 0,
    calls,
    protocolVersion: PROTOCOL_VERSION,
    async close() {
      await server.stop(true);
    },
  };
}
