/**
 * The connectors package's public surface. Above the adapter there is a `Connector` and no vendor:
 * `boundary.test.ts` reads this package's own source and fails if that stops being true.
 */

export {
  type Connector,
  ConnectorError,
  type ConnectorHealth,
  type ConnectorResult,
  type ConnectorTool,
  type CredentialSource,
  namespacedToolName,
  type OfferedTool,
  offeredTools,
  type TokenRef,
  tokenRef,
} from "./connector.ts";
export {
  MCP_PROTOCOL_VERSION,
  type McpCallResult,
  McpClient,
  type McpClientOptions,
  type McpContentBlock,
  McpError,
  type McpServerInfo,
  type McpToolWire,
} from "./mcp-client.ts";
export { McpConnector, type McpConnectorOptions, outputOf } from "./mcp-connector.ts";
export {
  createMcpServer,
  type McpServer,
  type McpServerOptions,
  type McpServerTool,
} from "./mcp-server.ts";
