#!/usr/bin/env node
/**
 * stdio entry point — how Gemini CLI, Claude Code, and Claude Desktop launch this server.
 *
 * ⚠️ stdout is the MCP protocol channel. Anything written there that is not a protocol
 * message corrupts the stream and the client disconnects with an opaque parse error, so
 * every diagnostic in this file goes to **stderr**.
 *
 * Configuration:
 *   HEB_SESSION_PATH  session file (default: .session/session.json under the CWD)
 *   HEB_LIST_ID       pin a specific list; only needed if the account has several
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { FileStore, HebClient, HebListOps } from '@heb/core';
import { createHebMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

const sessionPath = resolve(process.env['HEB_SESSION_PATH'] ?? '.session/session.json');
const listId = process.env['HEB_LIST_ID'];

const listOps = new HebListOps({
  client: new HebClient({ store: new FileStore(sessionPath) }),
  ...(listId === undefined ? {} : { listId }),
});

const server = createHebMcpServer({ listOps });

// stderr, deliberately — see the note above.
console.error(`${SERVER_NAME} v${SERVER_VERSION} — session: ${sessionPath}`);

await server.connect(new StdioServerTransport());
