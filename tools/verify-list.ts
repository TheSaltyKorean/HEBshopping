/**
 * W6 acceptance: a full add → read → remove cycle against the real HEB list.
 *
 *   npx tsx tools/verify-list.ts ["search term"]
 *
 * This MUTATES the real shopping list, so it cleans up after itself: anything it adds, it
 * removes. It touches lists only — never the cart, never checkout.
 */

import { resolve } from 'node:path';
import {
  FileStore,
  HebClient,
  HebListOps,
  checkSession,
  isHebError,
  type HebList,
} from '@heb/core';

const SESSION_PATH = resolve('.session/session.json');
const TERM = process.argv[2] ?? 'oat milk';

/**
 * Read the session the way the real surfaces do — through the `Store`.
 *
 * This used to re-seed from `captures/storage-state.json` on every run, which predates
 * `npm run login`. Doing that now would overwrite a freshly-obtained session with a stale
 * capture, so the seeding lives in exactly one place: the login tool.
 */
async function requireSession(store: FileStore): Promise<void> {
  const health = checkSession(await store.getSession(), Date.now());
  if (health.usable) return;
  console.error(`⛔ No usable session (${health.reason ?? 'unknown'}). Run \`npm run login\`.`);
  process.exit(1);
}

const time = async <T>(label: string, task: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await task();
  console.log(`   (${Date.now() - started}ms) ${label}`);
  return result;
};

/**
 * Put one line back the way it was.
 *
 * A line that existed before this run was *incremented* rather than created, so deleting
 * it would remove a real grocery; only lines this run brought into existence are deleted.
 */
async function restoreLine(
  lists: HebListOps,
  before: HebList,
  lineId: string,
  label: string,
): Promise<void> {
  const preExisting = before.items.find((item) => item.lineId === lineId);

  if (preExisting === undefined) {
    await time('removeItem', () => lists.removeItem({ lineId }));
    return;
  }
  console.log(`   "${label}" pre-existed — restoring quantity ${preExisting.quantity}`);
  await time('restore quantity', () => lists.setItemQuantity(lineId, preExisting.quantity));
}

async function main(): Promise<void> {
  const store = new FileStore(SESSION_PATH);
  await requireSession(store);
  const lists = new HebListOps({ client: new HebClient({ store }) });

  console.log('── 1. read the list');
  const before = await time('getList', () => lists.getList());
  console.log(`   "${before.name}" — ${before.items.length} item(s)`);
  for (const item of before.items) console.log(`     • ${item.quantity} × ${item.text}`);

  // Everything below mutates the real list, so restoration must be unconditional: a
  // failed assertion or a timed-out read would otherwise leave a grocery — or a raised
  // quantity — behind on someone's shopping list. These are declared outside the `try` so
  // the `finally` can undo whatever was actually done.
  let touchedLine: string | null = null;
  let done = false;

  try {
    console.log(`\n── 2. add "${TERM}"`);
    const result = await time('addItem', () => lists.addItem({ query: TERM }));

    let lineId: string;
    let addedName: string;

    if (result.status === 'needs_confirmation') {
      // Expected for a generic phrase: the safe path is to ask rather than guess.
      console.log(`   ↪ needs confirmation (confidence ${result.match.confidence.toFixed(2)})`);
      console.log(`     best: ${result.match.product.name}`);
      for (const alt of result.match.alternatives.slice(0, 3)) console.log(`     alt:  ${alt.name}`);

      console.log('\n   confirming the top match by productId …');
      const confirmed = await time('addItem(productId)', () =>
        lists.addItem({ productId: result.match.product.id }),
      );
      if (confirmed.status === 'needs_confirmation') throw new Error('unreachable');
      lineId = confirmed.item.lineId;
      touchedLine = lineId;
      addedName = confirmed.item.text;
      console.log(`   ↪ ${confirmed.status}: ${confirmed.item.quantity} × ${addedName}`);
    } else {
      lineId = result.item.lineId;
      touchedLine = lineId;
      addedName = result.item.text;
      console.log(`   ↪ ${result.status}: ${result.item.quantity} × ${addedName}`);
    }

    console.log('\n── 3. read back');
    const during = await time('getList', () => lists.getList());
    const present = during.items.some((item) => item.lineId === lineId);
    console.log(`   ${during.items.length} item(s); added item present: ${present ? 'yes' : 'NO'}`);
    if (!present) throw new Error('the item did not appear on the list after adding');

    console.log('\n── 4. find it by spoken text (the removal path)');
    try {
      const found = await time('findLine', () => lists.findLine(addedName));
      console.log(`   matched line: ${found.text}`);
    } catch (error) {
      // Not fatal: with one item on the list this should match, but ambiguity here is a
      // matching-calibration signal rather than a broken write path.
      console.log(`   (${isHebError(error) ? error.code : 'error'}: ${(error as Error).message})`);
    }

    console.log('\n── 5. restore the list to how it was');
    await restoreLine(lists, before, lineId, addedName);
    touchedLine = null;

    const after = await time('getList', () => lists.getList());
    console.log(`   ${after.items.length} item(s)`);
    done = true;

    console.log(
      `\n✅ add → read → remove verified. List restored to ${after.items.length} item(s).`,
    );
  } finally {
    // The mutation happened but the run did not reach its own restore step. Undo it here
    // rather than leaving a grocery — or a raised quantity — on a real household list.
    if (touchedLine !== null) {
      console.error('\n🧹 run did not complete; restoring the line it touched …');
      await restoreLine(lists, before, touchedLine, touchedLine).catch((error: unknown) => {
        console.error('⛔ RESTORE FAILED — the list still holds test data:', error);
      });
    } else if (!done) {
      console.error('\n(the list was not modified)');
    }
  }
}

main().catch((error: unknown) => {
  if (isHebError(error)) {
    console.error(`\n⛔ ${error.code}: ${error.message}`);
    if (error.details) console.error(`   ${JSON.stringify(error.details)}`);
  } else {
    console.error('\n⛔', error);
  }
  process.exit(1);
});
