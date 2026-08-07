/**
 * @heb/mcp-server — the MCP surface over the HEB shopping list.
 *
 * `createHebMcpServer` is transport-agnostic on purpose: stdio drives it today (see
 * `stdio.ts`), and the same factory is what a Lambda Function URL will serve over
 * Streamable HTTP for Gemini Spark, with no change to the tools themselves.
 */

export { createHebMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { CreateServerOptions } from './server.js';
