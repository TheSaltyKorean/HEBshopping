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
// Blank is not "pinned". An unset variable interpolated into a wrapper script arrives as
// an empty string, and `resolveListId` would treat that as an explicit id — sending every
// operation to a list that does not exist, instead of the documented sole-list fallback.
const configuredListId = process.env['HEB_LIST_ID'];
const listId =
  configuredListId === undefined || configuredListId.trim() === '' ? undefined : configuredListId;

// One client, many list-ops.
//
// `HebListOps` must be per-call, because it caches the resolved list and this process
// outlives every tool call. `HebClient` must NOT be: it owns the concurrency cap and the
// inter-request spacing, and a fresh instance per call starts with empty throttle state —
// so concurrent tool calls would hit HEB simultaneously, which is exactly the burst the
// politeness gate exists to prevent.
const store = new FileStore(sessionPath);
const client = new HebClient({ store });

const server = createHebMcpServer({
  createListOps: () => new HebListOps({ client, ...(listId === undefined ? {} : { listId }) }),
});

// stderr, deliberately — see the note above.
console.error(`${SERVER_NAME} v${SERVER_VERSION} — session: ${sessionPath}`);

await server.connect(new StdioServerTransport());
