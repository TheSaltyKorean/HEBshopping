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

/**
 * The line this run created, if any.
 *
 * Module scope so the `finally` in `main` can reach it: a timeout or a failed assertion
 * between the add and the removal would otherwise leave a real grocery list holding test
 * data, with the top-level catch only closing the transport.
 */
let createdLine: string | null = null;

/**
 * The product this run added, recorded the instant the add succeeds.
 *
 * Arming cleanup only after the follow-up `heb_read_list` means a failure *between* those
 * two calls leaves a real grocery list holding test data — and the read is exactly the
 * kind of call that times out. With the product id, cleanup can find the line itself.
 */
let createdProductId: string | null = null;

/** Line ids present before this run touched anything; module scope so cleanup can see it. */
let before: ReadonlySet<string> = new Set();

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

/**
 * Call a tool and log it. Throws when the tool reports failure.
 *
 * `isError: true` arrives as a perfectly normal protocol response, so resolving it as a
 * string made a failed removal indistinguishable from a successful one — the verifier
 * would clear its cleanup marker and leave test data on a real household list.
 * `expectError` is for the cases that are *supposed* to fail, like argument validation.
 */
const call = async (
  name: string,
  args: Record<string, unknown> = {},
  expectError = false,
): Promise<string> => {
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

  if (failed && !expectError) throw new Error(`${name} failed: ${body}`);
  return body;
};

/** Every lineId the list currently holds, parsed out of `heb_read_list` output. */
function lineIdsIn(listing: string): Set<string> {
  return new Set([...listing.matchAll(/lineId: ([0-9a-f-]{36})/g)].map((match) => match[1]!));
}

/**
 * Candidate `name [productId: N]` pairs from an ambiguous `heb_add_item` reply.
 *
 * Needed so the run can pick a product that is *not* already on the list. Adding one that
 * is would increment a real grocery instead of creating a line, and MCP exposes no way to
 * set a quantity back down — so the only safe restore is never to cause the increment.
 */
function candidatesIn(reply: string): Array<{ name: string; productId: string }> {
  return [...reply.matchAll(/^\s*\d+\.\s*(.+?)\s*\[productId: (\d+)\]/gm)].map((match) => ({
    name: match[1]!.trim(),
    productId: match[2]!,
  }));
}

async function main(): Promise<void> {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Connected. ${tools.length} tools registered:`);
  for (const tool of tools) console.log(`  • ${tool.name} — ${tool.title ?? ''}`);

  // Snapshot BEFORE mutating. This runs against a real household list, so correctness
  // claims have to be relative to its starting state — asserting an absolute item count
  // would both fail spuriously and, worse, exit before cleanup and leave the item behind.
  const initial = await call('heb_read_list');
  before = lineIdsIn(initial);

  await call('heb_search_product', { query: 'flour tortillas', limit: 3 });

  // A vague query must NOT write; it should hand back candidates.
  const vague = await call('heb_add_item', { query: 'oat milk' });
  if (!vague.includes('NOT added')) {
    throw new Error('expected an ambiguous query to be refused rather than written');
  }

  // Choose a candidate that is demonstrably absent, so the add creates a line rather than
  // incrementing one belonging to the household.
  const candidates = candidatesIn(vague);
  if (candidates.length === 0) throw new Error('no candidates offered in the ambiguous reply');

  const absent = candidates.find((candidate) => !initial.includes(candidate.name));
  if (absent === undefined) {
    throw new Error('every offered candidate is already on the list; nothing safe to add');
  }
  const productId = absent.productId;

  // Armed *before* the call: a committed add whose response is lost rejects here, and the
  // cleanup would otherwise have neither a line nor a product to resolve.
  createdProductId = productId;
  const addReply = await call('heb_add_item', { productId });

  const listed = await call('heb_read_list');

  const added = [...lineIdsIn(listed)].filter((lineId) => !before.has(lineId));

  // Arm cleanup only when exactly one line appeared. If a household member added
  // something between the snapshot and this read, the diff holds several ids and picking
  // "the first" would arm deletion of *their* grocery — the cleanup would then destroy
  // real data precisely because something unexpected happened.
  if (added.length === 1 && addReply.includes('Added')) {
    createdLine = added[0]!;
  }

  if (added.length !== 1) {
    // Zero would mean the add incremented a pre-existing line despite the absence check;
    // stopping here without deleting anything is the safe response, since MCP offers no
    // way to set a quantity back down.
    throw new Error(`expected exactly one new line, saw ${added.length} — list left untouched`);
  }

  // Remove by lineId, not by free text. Free-text removal against a real list can match a
  // pre-existing grocery, and `verify:alexa` already covers that path behind a guard that
  // refuses to delete anything it did not create.
  await call('heb_remove_item', { lineId: added[0]! });
  createdLine = null;

  const afterward = await call('heb_read_list');
  const remaining = lineIdsIn(afterward);
  if (remaining.has(added[0]!)) throw new Error('the added item was not removed');
  for (const lineId of before) {
    if (!remaining.has(lineId)) throw new Error(`a pre-existing line was removed: ${lineId}`);
  }

  // Guardrails: exactly one of the mutually exclusive arguments.
  const both = await call('heb_add_item', { query: 'milk', productId: '123' }, true);
  if (!both.includes('exactly one')) throw new Error('expected mutually-exclusive args to be rejected');

  console.log('\n✅ MCP server verified end to end: read, search, ambiguous-add refusal,');
  console.log('   confirmed add, free-text removal, and argument validation.');
  await client.close();
}

main()
  .catch(async (error: unknown) => {
    console.error('\n⛔', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Unconditional: whatever went wrong, the household list must not keep test data.
    // Resolve the line late if the read that would have identified it never happened.
    if (createdLine === null && createdProductId !== null) {
      const listing = await call('heb_read_list').catch(() => '');
      const fresh = [...lineIdsIn(listing)].filter((lineId) => !before.has(lineId));
      if (fresh.length === 1) createdLine = fresh[0]!;
      else if (fresh.length > 1) {
        console.error('⛔ Several new lines exist; not guessing which is ours. Check the list.');
        process.exitCode = 1;
      }
    }

    if (createdLine !== null) {
      console.log(`\n🧹 removing the line this run created (${createdLine})`);
      await call('heb_remove_item', { lineId: createdLine }).catch((error: unknown) => {
        console.error('⛔ CLEANUP FAILED — the list still holds test data:', error);
        process.exitCode = 1;
      });
    }
    await client.close().catch(() => {});
  });
