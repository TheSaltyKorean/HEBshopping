/**
 * W7 acceptance: drive the MCP server exactly as Gemini CLI or Claude Code would.
 *
 * Spawns the real stdio server as a subprocess and speaks the protocol to it, so this
 * exercises transport, tool registration, schemas, and the HEB calls underneath — not just
 * the handler functions.
 *
 *   npx tsx tools/verify-mcp.ts
 *
 * MUTATES the real list, and cleans up after itself.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const client = new Client({ name: 'verify-mcp', version: '0.1.0' });

const transport = new StdioClientTransport({
  command: 'node',
  args: [resolve('packages/mcp-server/dist/stdio.js')],
  env: {
    ...(process.env as Record<string, string>),
    HEB_SESSION_PATH: resolve('.session/session.json'),
  },
  stderr: 'pipe',
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const body = textOf(result);
  const failed = (result as { isError?: boolean }).isError === true;
  console.log(`\n── ${name}(${JSON.stringify(args)})  ${Date.now() - started}ms${failed ? '  [isError]' : ''}`);
  console.log(
    body
      .split('\n')
      .map((line) => `   ${line}`)
      .join('\n'),
  );
  return body;
};

async function main(): Promise<void> {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Connected. ${tools.length} tools registered:`);
  for (const tool of tools) console.log(`  • ${tool.name} — ${tool.title ?? ''}`);

  await call('heb_read_list');
  await call('heb_search_product', { query: 'flour tortillas', limit: 3 });

  // A vague query must NOT write; it should hand back candidates.
  const vague = await call('heb_add_item', { query: 'oat milk' });
  if (!vague.includes('NOT added')) {
    throw new Error('expected an ambiguous query to be refused rather than written');
  }

  const productId = vague.match(/productId: (\d+)/)?.[1];
  if (productId === undefined) throw new Error('no productId offered in the candidate list');

  await call('heb_add_item', { productId });
  const listed = await call('heb_read_list');
  if (!/1 item\(s\)/.test(listed)) throw new Error('item did not appear on the list');

  // Remove by free text, exercising the match-against-the-list path.
  await call('heb_remove_item', { item: 'oat milk' });

  const afterward = await call('heb_read_list');
  if (!afterward.includes('is empty')) throw new Error('list was not restored to empty');

  // Guardrails: exactly one of the mutually exclusive arguments.
  const both = await call('heb_add_item', { query: 'milk', productId: '123' });
  if (!both.includes('exactly one')) throw new Error('expected mutually-exclusive args to be rejected');

  console.log('\n✅ MCP server verified end to end: read, search, ambiguous-add refusal,');
  console.log('   confirmed add, free-text removal, and argument validation.');
  await client.close();
}

main().catch(async (error: unknown) => {
  console.error('\n⛔', error);
  await client.close().catch(() => {});
  process.exit(1);
});
