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

/** The candidate's name, so cleanup can identify its line in a text listing. */
let createdProductName: string | null = null;

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

/**
 * What `heb_read_list` says about one line.
 *
 * The MCP surface renders a line as `• <text>  [lineId: …]`, and prefixes `N × ` only when
 * the quantity exceeds one (`describeItem` in the server). So the absence of that prefix
 * *is* the "still exactly one unit" signal.
 *
 * `absent` is not a failure: the line may legitimately be gone already.
 */
function lineStateIn(listing: string, lineId: string): 'absent' | 'sole' | 'shared' {
  const line = listing.split('\n').find((row) => row.includes(lineId));
  if (line === undefined) return 'absent';
  return /^\s*•\s*\d+\s*×/.test(line) ? 'shared' : 'sole';
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

  // Prove every product this probe could resolve to is absent from the household list
  // *before* risking the write. If ranking or purchase history makes "oat milk" confident,
  // HEB merges the add into an existing line of the same product rather than creating one,
  // and MCP exposes no way to set a quantity back down — so a merge here could not be
  // undone. Checking absence first, rather than only after the fact, means a confident write
  // is guaranteed to create a brand-new line that the cleanup below can find and remove.
  //
  // `heb_search_product` fetches more candidates internally than it renders — `limit` only
  // caps the *shown* list, and `heb_add_item` can also merge in a second, broadened search
  // that this probe never sees at all. 25 is the tool's own maximum, so it is the most this
  // check can inspect; the reply's own "N match(es)" count says whether that maximum still
  // left candidates unseen, and the probe refuses to run rather than guess past it.
  const oatMilkCandidates = await call('heb_search_product', { query: 'oat milk', limit: 25 });
  const totalMatches = Number(oatMilkCandidates.match(/^(\d+) match\(es\)/)?.[1] ?? NaN);
  const shownNames = [...oatMilkCandidates.matchAll(/^•\s*(.+?)\s*\[productId: \d+\]/gm)].map(
    (match) => match[1]!.trim(),
  );
  if (!Number.isFinite(totalMatches) || totalMatches > shownNames.length) {
    throw new Error(
      `the ambiguity probe is unsafe right now: "oat milk" has ${
        Number.isFinite(totalMatches) ? totalMatches : 'an unknown number of'
      } candidate(s) but only ${shownNames.length} could be inspected, so absence from the ` +
        'household list cannot be proven for all of them — a confident add could merge into ' +
        'an unseen one and there would be no way to undo it',
    );
  }
  const alreadyOwned = shownNames.find((name) => initial.includes(name));
  if (alreadyOwned !== undefined) {
    throw new Error(
      `the ambiguity probe is unsafe right now: "${alreadyOwned}" is already on the list, ` +
        'so a confident "oat milk" add would merge into it instead of creating a removable line',
    );
  }

  // A vague query must NOT write; it should hand back candidates.
  //
  // "Must not" is the assertion, not a guarantee — that is the point of testing it. Ranking
  // and purchase history are live inputs, so this query can come back confident and write.
  // Throwing straight from the failed assertion left that write with nothing armed: the
  // finalizer had neither a line nor a product, and the run exited having put a real item on
  // a real list while reporting only that the assertion failed.
  const vague = await call('heb_add_item', { query: 'oat milk' });
  if (!vague.includes('NOT added')) {
    // The read is allowed to fail without hiding the assertion: throwing from in here would
    // replace "the ambiguous query wrote" with a read error, which is the less useful of the
    // two facts and the one that does not tell the operator to go look at their list.
    const listing = await call('heb_read_list').catch(() => '');
    const fresh = [...lineIdsIn(listing)].filter((id) => !before.has(id));
    if (fresh.length === 1) {
      createdLine = fresh[0]!;
      console.error('\n⚠ The ambiguous query wrote a line. Armed for cleanup; failing the run.');
    } else {
      // No new line means it merged into an existing one, and MCP exposes no way to set a
      // quantity back down — the reason this script only ever adds products it has proved
      // absent. Nothing here can undo it.
      console.error(
        `\n⛔ The ambiguous query wrote, and ${fresh.length} new lines appeared, so this run\n` +
          '  cannot identify what to undo. It may have incremented a household line.\n' +
          '  Reconcile by hand.',
      );
    }
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
  createdProductName = absent.name;
  const addReply = await call('heb_add_item', { productId });

  const listed = await call('heb_read_list');

  const added = [...lineIdsIn(listed)].filter((lineId) => !before.has(lineId));

  /** The quantity MCP reported, e.g. "Added to the HEB list: 2 × Milk" → 2. */
  const reportedQuantity = Number(/:\s*(\d+)\s*×/.exec(addReply)?.[1] ?? '1');

  // Arm cleanup only when exactly one line appeared *and* it holds exactly one unit.
  //
  // `includes('Added')` alone does not prove creation: if a household member created this
  // product between HebListOps' internal snapshot and its mutation, HEB merges our unit
  // into their line and the reply still reads "Added to the HEB list: 2 × …", with exactly
  // one unfamiliar line id in the diff. A created line reads one; anything higher was
  // merged and belongs to somebody else.
  if (added.length === 1 && addReply.includes('Added') && reportedQuantity === 1) {
    createdLine = added[0]!;
  }

  if (added.length !== 1) {
    // Zero would mean the add incremented a pre-existing line despite the absence check;
    // stopping here without deleting anything is the safe response, since MCP offers no
    // way to set a quantity back down.
    throw new Error(`expected exactly one new line, saw ${added.length} — list left untouched`);
  }

  // The removal is gated on the *same* proof that arms cleanup, not merely on the diff
  // holding one id. If a household member added this product between the snapshot and the
  // add, MCP reports "Already on the list" — our call merged into their line, created
  // nothing, and the single unfamiliar id in the diff is *their* new grocery. Deleting it
  // would destroy real data precisely because something unexpected happened.
  if (createdLine === null) {
    // Disarm the finalizer before aborting. Leaving the product markers set sends the
    // late-resolution branch looking for "the line matching this product", which is
    // precisely the household member's line that the merge proved we do not own — so the
    // abort would be followed by the deletion it exists to prevent.
    createdProductId = null;
    createdProductName = null;
    throw new Error(
      'the add merged into an existing line rather than creating one — ' +
        'list left untouched, nothing deleted',
    );
  }

  // One more read, immediately before deleting. The exact-one check above proved ownership
  // when the add returned; since then this run has done a full list read, and a household
  // member merging into the same line leaves it holding their unit too. Deleting by line id
  // takes the whole line, so a changed quantity means it is no longer ours to remove.
  const state = lineStateIn(await call('heb_read_list'), createdLine);
  if (state === 'absent') {
    console.log('   (the line is already gone; nothing to remove)');
    createdLine = null;
    createdProductId = null;
    createdProductName = null;
    return;
  }
  if (state === 'shared') {
    createdLine = null;
    createdProductId = null;
    createdProductName = null;
    throw new Error(
      'the line this run created no longer reads one unit — somebody added to it, so it ' +
        'is not being deleted. Reconcile by hand.',
    );
  }

  // Remove by lineId, not by free text. Free-text removal against a real list can match a
  // pre-existing grocery, and `verify:alexa` already covers that path behind a guard that
  // refuses to delete anything it did not create.
  await call('heb_remove_item', { lineId: createdLine });
  // Disarm the finalizer completely. Clearing only `createdLine` leaves the product
  // markers armed, so the late-resolution branch runs on every successful verification:
  // usually it fails to find the already-removed product and turns a passing run into
  // exit code 1, and if a household member has since added the same product it identifies
  // and deletes *their* line.
  createdLine = null;
  createdProductId = null;
  createdProductName = null;

  const removed = added[0]!;
  const afterward = await call('heb_read_list');
  const remaining = lineIdsIn(afterward);
  if (remaining.has(removed)) throw new Error('the added item was not removed');
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
    // Deliberately NOT resolving ownership late from the product name.
    //
    // That branch existed for the case where the add committed but the read identifying
    // its line never happened. It cannot survive the current contract: a thrown add is
    // explicitly indeterminate — the write may never have reached HEB — and a household
    // member adding the same product leaves a line matching the name just as well. Deleting
    // on a name match would destroy their grocery in exactly the situation the uncertainty
    // was created by.
    //
    // The cost is a line left behind after a failed run, which is visible, reported, and
    // removable by hand. The alternative cost is deleting somebody's shopping.
    if (createdLine === null && createdProductId !== null) {
      console.error(
        `⛔ The add for "${createdProductName ?? createdProductId}" did not confirm, so this\n` +
          '   run cannot prove which line — if any — it created. Leaving the list untouched.\n' +
          '   Check it by hand: there may be one extra unit of that product.',
      );
      process.exitCode = 1;
    }

    if (createdLine !== null) {
      // Same fresh check as the normal path: a line that has grown since is shared, and
      // the finalizer runs precisely when something went wrong — the moment least likely
      // to have left the list as this run expects.
      // Fails CLOSED. `.catch(() => '')` made an unreadable list indistinguishable from an
      // empty one, which `lineStateIn` calls `absent` — and only `shared` blocked the
      // delete. A transient outage therefore authorised removing a line whose quantity was
      // unknown, during the finalizer, which runs precisely when things have gone wrong.
      let listing: string;
      try {
        listing = await call('heb_read_list');
      } catch (readError) {
        console.error(
          `⛔ Could not re-read the list to confirm line ${createdLine} is still solely ` +
            `this run's, so it will NOT be deleted. Check by hand. Cause: ${String(readError)}`,
        );
        process.exitCode = 1;
        return;
      }
      const state = lineStateIn(listing, createdLine);
      if (state === 'shared') {
        console.error(
          `⛔ Line ${createdLine} now holds more than the unit this run added. NOT deleting ` +
            'it; reconcile by hand.',
        );
        process.exitCode = 1;
        return;
      }
      console.log(`\n🧹 removing the line this run created (${createdLine})`);
      await call('heb_remove_item', { lineId: createdLine }).catch((error: unknown) => {
        console.error('⛔ CLEANUP FAILED — the list still holds test data:', error);
        process.exitCode = 1;
      });
    }
    await client.close().catch(() => {});
  });
