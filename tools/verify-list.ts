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
  broadenQuery,
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
  /** What this run left the line reading. Restoration is only safe while it still does. */
  produced: number,
  /**
   * True when the list is back to how this run found it.
   *
   * Every branch that deliberately declines to restore returns false, because "refused to
   * touch a shared line" and "cleaned up" are opposite outcomes that used to be reported
   * identically: `restoreLine` returned void, the caller cleared its marker, and the run
   * printed the green success line with exit 0 while its unit sat on a household list.
   */
): Promise<boolean> {
  const preExisting = before.items.find((item) => item.lineId === lineId);

  // Absence from the opening snapshot is NOT proof this run created the line. If a
  // household member added the same product in between, HEB merged this run's unit into
  // *their* new line — whose id is equally unfamiliar. Only a line reading exactly one can
  // have been created here; anything higher was merged, and deleting it would take their
  // grocery with it.
  if (preExisting === undefined) {
    if (produced !== 1) {
      // Not this run's line to delete — but the unit this run contributed to it is still
      // this run's to take back. Refusing to delete and then walking away leaves the
      // household with an extra unit they never asked for, which is the other half of the
      // same mistake. Undo exactly the one unit, and only while the line still reads what
      // this run left it at.
      console.error(
        `   ⚠ "${label}" is not in the opening snapshot but reads ${produced}, so this run\n` +
          '     merged into a line somebody else created. NOT deleting it.',
      );

      let live;
      try {
        live = (await freshList(lists)).items.find((item) => item.lineId === lineId);
      } catch (error) {
        console.error(
          `   ⛔ Could not re-read the list, so this run's extra unit on "${label}" was NOT\n` +
            `      undone. Reconcile by hand. Cause: ${(error as Error).message}`,
        );
        process.exitCode = 1;
        return false;
      }

      if (live === undefined) {
        console.log(`   "${label}" is gone; nothing to undo.`);
      } else if (live.quantity !== produced) {
        console.error(
          `   ⚠ "${label}" reads ${live.quantity}, not the ${produced} this run left, so\n` +
            '     somebody changed it since. NOT undoing; reconcile by hand.',
        );
        process.exitCode = 1;
        return false;
      }
      if (live !== undefined) {
        console.log(`   undoing this run's extra unit on "${label}" (${produced} → ${produced - 1})`);
        await time('undo merged unit', () => lists.setItemQuantity(lineId, produced - 1));
      }
      return true;
    }

    // One unit *at the time the add returned* proves this run created the line. It does
    // not prove the line is still only this run's: a household member merging into it
    // during the read-back and find steps leaves it at two, and deleting it then takes
    // their unit as well. Re-check before destroying anything.
    const current = (await freshList(lists)).items.find((item) => item.lineId === lineId);
    if (current === undefined) {
      console.log(`   "${label}" is already gone; nothing to remove.`);
      return true;
    }
    if (current.quantity !== 1) {
      console.error(
        `   ⚠ "${label}" was created by this run but now reads ${current.quantity}, so\n` +
          '     somebody added to it. NOT deleting it; reconcile by hand — the line holds\n' +
          "     one unit this run added.",
      );
      process.exitCode = 1;
      return false;
    }
    await time('removeItem', () => lists.removeItem({ lineId }));
    return true;
  }

  // A *fresh* read, through a client that has not cached anything since the mutation —
  // otherwise this observes the pre-restore snapshot and cannot see an edit made after it.
  const now = (await freshList(lists)).items.find((item) => item.lineId === lineId);
  if (now === undefined) {
    console.log(`   "${label}" is gone; nothing to restore.`);
    return true;
  }

  // Exactly what this run produced, not merely "above where it started". A household
  // member incrementing the same line also satisfies the looser test, and writing the
  // opening quantity then discards their unit along with this run's.
  if (now.quantity !== produced) {
    console.error(
      `   ⚠ "${label}" reads ${now.quantity}, not the ${produced} this run left. Somebody\n` +
        '     changed it during the run, so it is NOT being restored.',
    );
    process.exitCode = 1;
    return false;
  }

  // Take back this run's one unit — do NOT write the opening quantity.
  //
  // `produced` is what the line read after the add, and the opening snapshot is older than
  // that. A household member incrementing this same line between the two means `produced`
  // holds their unit as well as this run's, and the equality check above still passes
  // because the line has not changed *since the add*. Writing `preExisting.quantity` there
  // silently deletes their contribution. This run added exactly one unit, so exactly one
  // comes back off; with nobody else involved that lands on the opening quantity anyway.
  const target = produced - 1;
  if (target < preExisting.quantity) {
    // The add never landed (a server-side cap, most likely), so there is nothing to undo.
    console.log(`   "${label}" is unchanged from the opening quantity; nothing to restore.`);
    return true;
  }

  console.log(
    `   "${label}" pre-existed — taking back this run's unit (${produced} → ${target})` +
      (target === preExisting.quantity ? '' : `, above the opening ${preExisting.quantity}`),
  );
  await time('restore quantity', () => lists.setItemQuantity(lineId, target));
  return true;
}

/**
 * Read the list through a client that has cached nothing.
 *
 * `HebListOps` caches the resolved list, which is correct within one operation and wrong
 * across two — a cleanup that reuses the instance which performed the mutation sees its
 * own pre-mutation snapshot and cannot observe a concurrent edit.
 */
async function freshList(lists: HebListOps): Promise<HebList> {
  return new HebListOps({
    client: new HebClient({ store: new FileStore(SESSION_PATH) }),
    listId: (await lists.getList()).listId,
  }).getList();
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
  /**
   * The product name for that line, for the messages the cleanup prints.
   *
   * The `finally` used to pass `touchedLine` as the label, so every instruction to reconcile
   * by hand named a line UUID — which is both unactionable (the H-E-B app shows names, not
   * ids) and an account identifier in console output.
   */
  let touchedName = '(the item this run added)';
  /**
   * What this run left that line reading.
   *
   * Restoration compares against it exactly: "higher than it started" is also true when a
   * household member edits the same line mid-run, and resetting then discards their change.
   * Zero means "unknown", which fails the equality check and so restores nothing.
   */
  let touchedQuantity = 0;
  let done = false;

  try {
    console.log(`\n── 2. add "${TERM}"`);

    // Reconcile before rethrowing: a rejection does not mean nothing happened, and the
    // `finally` below would otherwise report an untouched list while a test grocery — or
    // an incremented real one — sits on it.
    // Reconcile against the product this call asked for, not "whatever changed". A
    // household member adding something mid-run also shows as a line absent from the
    // snapshot, and claiming it would have the cleanup delete their grocery.
    const reconcile = async (
      productIds: ReadonlySet<string>,
      error: unknown,
    ): Promise<never> => {
      // Deliberately claims nothing.
      //
      // `HebListOps` now reports a transport failure as *indeterminate* because a line
      // appearing afterwards is equally well explained by a household member's concurrent
      // add. This readback matched on "any plausible product, absent from the snapshot",
      // which is an even looser rule — and `restoreLine` deletes what it is handed when the
      // quantity is one. Inferring ownership here would reinstate exactly the guess the
      // core stopped making, at the one point where being wrong destroys data.
      void productIds;
      console.error(
        '\n⚠ The add did not confirm, so this run cannot prove what it wrote.\n' +
          '  Nothing is claimed for restoration. Check the list by hand: there may be an\n' +
          '  extra unit of whatever the query resolved to.',
      );
      throw error;
    };

    // Everything the query could plausibly resolve to, not just the top match. `addItem`
    // broadens the search and applies purchase-history ranking, so a single pre-computed
    // "likely" id can easily be the wrong one — and reconciling against the wrong id is
    // the same as not reconciling at all.
    const plausible = new Set(
      (await lists.searchProducts(TERM).catch(() => [])).map((product) => product.id),
    );
    const broader = broadenQuery(TERM);
    if (broader !== null) {
      for (const product of await lists.searchProducts(broader).catch(() => [])) {
        plausible.add(product.id);
      }
    }

    const result = await time('addItem', () =>
      lists.addItem({ query: TERM }).catch((error: unknown) => reconcile(plausible, error)),
    );

    let lineId: string;
    let addedName: string;

    if (result.status === 'needs_confirmation') {
      // Expected for a generic phrase: the safe path is to ask rather than guess.
      console.log(`   ↪ needs confirmation (confidence ${result.match.confidence.toFixed(2)})`);
      console.log(`     best: ${result.match.product.name}`);
      for (const alt of result.match.alternatives.slice(0, 3)) console.log(`     alt:  ${alt.name}`);

      console.log('\n   confirming the top match by productId …');
      const chosen = result.match.product.id;
      const confirmed = await time('addItem(productId)', () =>
        // Armed before the call: a committed add whose response is lost rejects here, and
        // the cleanup would otherwise report an untouched list.
        lists
          .addItem({ productId: chosen })
          .catch((error: unknown) => reconcile(new Set([chosen]), error)),
      );
      if (confirmed.status === 'needs_confirmation') throw new Error('unreachable');
      lineId = confirmed.item.lineId;
      touchedLine = lineId;
      addedName = confirmed.item.text;
      touchedName = addedName;
      touchedQuantity = confirmed.item.quantity;
      console.log(`   ↪ ${confirmed.status}: ${confirmed.item.quantity} × ${addedName}`);
    } else {
      lineId = result.item.lineId;
      touchedLine = lineId;
      touchedQuantity = result.item.quantity;
      addedName = result.item.text;
      touchedName = addedName;
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
    const clean = await restoreLine(lists, before, lineId, addedName, touchedQuantity);
    // Cleared either way: the restore has been attempted, and re-running it from the
    // `finally` would repeat the identical refusal. What must not be cleared is the
    // *verdict* — a run that left its unit behind is not a passing run.
    touchedLine = null;

    const after = await time('getList', () => lists.getList());
    console.log(`   ${after.items.length} item(s)`);
    done = true;

    if (clean) {
      console.log(
        `\n✅ add → read → remove verified. List restored to ${after.items.length} item(s).`,
      );
    } else {
      console.error(
        '\n⛔ add → read → remove ran, but cleanup deliberately left this run\'s data on the\n' +
          '   list — see the warning above. Reconcile by hand; NOT reporting success.',
      );
      process.exitCode = 1;
    }
  } finally {
    // The mutation happened but the run did not reach its own restore step. Undo it here
    // rather than leaving a grocery — or a raised quantity — on a real household list.
    if (touchedLine !== null) {
      console.error('\n🧹 run did not complete; restoring the line it touched …');
      await restoreLine(lists, before, touchedLine, touchedName, touchedQuantity).catch((error: unknown) => {
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
