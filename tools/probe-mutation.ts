/**
 * Can we write our own mutations instead of depending on HEB's persisted-query cache?
 *
 * Why this matters: APQ here is non-strict, which means HEB's persisted store is a *cache*,
 * not a safelist. Rarely-used operations get evicted — `deleteShoppingListItems` worked in
 * the browser and then returned PersistedQueryNotFound minutes later. Hash-only requests
 * are therefore unreliable for exactly the operations we use least.
 *
 * Introspection is disabled, so we cannot learn input type names for a variable
 * declaration. But inlining literals needs no type name at all — the only question is
 * whether enum-valued fields (`sort: CATEGORY`) must be unquoted. This settles that.
 *
 *   npx tsx tools/probe-mutation.ts
 *
 * Adds a throwaway item and tries to delete it with a hand-written mutation.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  FileStore,
  HebClient,
  HebListOps,
  HEB_GRAPHQL_URL,
  HEB_ORIGIN,
  cookieHeaderFor,
  type Cookie,
  type SessionState,
} from '@heb/core';

const SESSION_PATH = resolve('.session/session.json');

/** No raw probe may outlive this; see the note in `rawGraphql`. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The current session, read but never written.
 *
 * This used to overwrite `.session/session.json` from an old W0 capture on every run,
 * which silently downgraded a freshly logged-in session to a stale jar and broke every
 * other command until the user logged in again.
 */
async function currentSession(): Promise<SessionState> {
  const session = await new FileStore(SESSION_PATH).getSession();
  if (session === null) {
    throw new Error('No session stored. Run `npm run login` first.');
  }
  return session;
}

async function rawGraphql(session: SessionState, body: unknown): Promise<any> {
  // The same builder the production client uses. A hand-rolled domain filter sends
  // expired, path-ineligible and duplicate copies that `HebClient` omits — so the server
  // can reject this request while the real client stays authenticated, and the probe then
  // concludes that the GraphQL syntax under test does not work. This tool exists to decide
  // exactly that question, so measuring something other than production is worse than not
  // measuring.
  const cookies = cookieHeaderFor(session, 'www.heb.com', '/graphql');

  const response = await fetch(HEB_GRAPHQL_URL, {
    method: 'POST',
    // Bounded so the cleanup in `finally` is always reachable. An unbounded raw request
    // that hangs leaves the throwaway line on a real household list, and the only way out
    // is killing the process — which skips the cleanup entirely.
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      'Content-Type': 'application/json',
      Origin: HEB_ORIGIN,
      Referer: `${HEB_ORIGIN}/shopping-list`,
      Cookie: cookies,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { nonJson: text.slice(0, 200) };
  }
}

async function main(): Promise<void> {
  const session = await currentSession();
  /**
   * A brand-new client, every time.
   *
   * `HebListOps` caches the resolved list, which is right within one operation and wrong
   * across two. Reconciling a lost write through an instance whose snapshot predates the
   * mutation reads the pre-mutation list and concludes nothing was committed.
   */
  const reader = (): HebListOps =>
    new HebListOps({ client: new HebClient({ store: new FileStore(SESSION_PATH) }) });

  const lists = reader();

  const list = await lists.getList();
  console.log(`List "${list.name}" has ${list.items.length} item(s)`);

  // Always create the line this probe is going to delete.
  //
  // Reusing an existing line would mean the successful attempt below silently deletes a
  // real household grocery — a probe has no business destroying data it did not create,
  // and a nonempty list is the normal case, not the edge case.
  const candidates = await lists.searchProducts('oat milk');

  // Check BEFORE mutating. Guarding after the add is no guard at all: `addItem` has
  // already incremented the real line by then, and the probe leaves the household list
  // changed even as it refuses to continue.
  // Re-read through a *fresh* instance. The one above cached the list before the search,
  // and if a household member added this exact product in the meantime the cached copy
  // still calls it absent — H-E-B then increments their line instead of creating ours,
  // and the probe would delete a grocery it did not create.
  const fresh = new HebListOps({ client: new HebClient({ store: new FileStore(SESSION_PATH) }) });
  const current = await fresh.getList();
  const onList = new Set(current.items.map((item) => item.product?.id).filter(Boolean));

  const disposable = candidates.find((product) => !onList.has(product.id));
  if (disposable === undefined) {
    throw new Error('Every candidate product is already on the list; nothing safe to probe with.');
  }

  // Enter the cleanup scope *before* mutating: a commit whose response is lost rejects
  // here, and outside the try that failure would exit through the outer catch with the
  // line still on a real household list.
  let lineId: string | null = null;
  /**
   * A line this probe incremented but did not create.
   *
   * Deleting it would destroy somebody's grocery; leaving it silently raised is the other
   * half of the same mistake. Cleanup restores it instead — but only while it still reads
   * what the probe left, since a further change is not this probe's to undo.
   */
  let mergedLine: { lineId: string; produced: number } | null = null;

  // The cleanup scope opens HERE, around the add itself. Previously it began after this
  // block, so every path that threw during the add — including the one that had just
  // recorded a merged line to restore — exited before the `finally` and left the change
  // behind. The thing that needs undoing is created inside the add, so the guard has to
  // start before it.
  try {
    const added = await fresh.addItem({ productId: disposable.id });
    if (added.status !== 'added') {
      throw new Error(`expected a fresh line, got ${added.status}`);
    }
    // `added` alone is not proof of creation. If a household member added the same product
    // between the absence check and this mutation, HEB merges the probe's unit into *their*
    // line — and `HebListOps`, whose opening snapshot showed nothing, still calls that
    // `added` and returns their line id. Marking it disposable would hand it to the raw
    // deletion below. A genuinely new line reads exactly one.
    if (added.item.quantity !== 1) {
      // Refusing to delete is not enough on its own: the probe still added a unit to a
      // line it does not own, and simply throwing here would leave that increment behind.
      // Record it so the cleanup can put the line back rather than remove it.
      mergedLine = { lineId: added.item.lineId, produced: added.item.quantity };
      throw new Error(
        `the add merged into an existing line (quantity ${added.item.quantity}) rather than ` +
          'creating one — nothing will be deleted; the extra unit is undone in cleanup',
      );
    }
    lineId = added.item.lineId;
    console.log(`Added throwaway line: ${added.item.text}`);

    const listId = list.listId;

    // Revalidate immediately before issuing any raw delete. The quantity check above proved
    // ownership *when the add returned*; between then and now a household member can have
    // incremented the same line, and these attempts delete the whole line by id — they have
    // no notion of "just my unit". A line that has changed is no longer this probe's to
    // destroy, so hand it to the restore path instead.
    const beforeDelete = (await reader().getList().catch(() => null))?.items.find(
      (item) => item.lineId === lineId,
    );
    if (beforeDelete === undefined) {
      console.log('\nThe throwaway line is already gone; nothing to delete.');
      return;
    }
    if (beforeDelete.quantity !== 1) {
      mergedLine = { lineId, produced: beforeDelete.quantity };
      lineId = null; // never hand a shared line to the raw deletes or the cleanup remove
      throw new Error(
        `the throwaway line now reads ${beforeDelete.quantity} — somebody added to it, so ` +
          'it will not be deleted; the probe\'s own unit is undone in cleanup',
      );
    }

    console.log('\n══ Attempt A: enums UNQUOTED (proper GraphQL literal syntax) ══');
    const unquoted = await rawGraphql(session, {
      operationName: 'DeleteItems',
      query: `mutation DeleteItems {
        deleteShoppingListItemsV2(input: {
          itemIds: ["${lineId}"]
          listId: "${listId}"
          page: { sort: CATEGORY, sortDirection: ASC }
        }) { __typename ... on ShoppingListV2 { id totalItemCount } }
      }`,
      variables: {},
    });
    console.log(JSON.stringify(unquoted).slice(0, 500));

    // A refusal is still a truthy object carrying only its __typename, so "we got a payload"
    // is not "the delete happened" — and returning here would also skip the cleanup below,
    // leaving the throwaway line on the list.
    if (unquoted?.data?.deleteShoppingListItemsV2?.__typename === 'ShoppingListV2') {
      console.log('\n✅ Hand-written mutation WORKS with unquoted enums.');
      console.log('   → We can stop depending on the persisted-query cache entirely.');
      return;
    }

    console.log('\n══ Attempt B: field name without the V2 suffix ══');
    const noV2 = await rawGraphql(session, {
      operationName: 'DeleteItems',
      query: `mutation DeleteItems {
        deleteShoppingListItems(input: {
          itemIds: ["${lineId}"]
          listId: "${listId}"
          page: { sort: CATEGORY, sortDirection: ASC }
        }) { id totalItemCount }
      }`,
      variables: {},
    });
    console.log(JSON.stringify(noV2).slice(0, 500));

    console.log('\n══ Attempt C: minimal input (no page argument) ══');
    const minimal = await rawGraphql(session, {
      operationName: 'DeleteItems',
      query: `mutation DeleteItems {
        deleteShoppingListItemsV2(input: {
          itemIds: ["${lineId}"]
          listId: "${listId}"
        }) { id totalItemCount }
      }`,
      variables: {},
    });
    console.log(JSON.stringify(minimal).slice(0, 500));

    console.log(
      '\nIf an error names an expected input type, that type name unlocks proper variable\n' +
        'declarations and we can hand-write every operation.',
    );
  } finally {
    // Attempt the removal for any line this probe created, without gating on a read.
    // A transient read failure would otherwise skip cleanup entirely and leave test data
    // on a real list — and a delete of an already-deleted line is harmless.
    if (lineId !== null) {
      console.log('\n🧹 removing the throwaway line (if it still exists)');
      await lists.removeItem({ lineId }).catch((error: unknown) => {
        console.error('⛔ CLEANUP may have failed — check the list:', error);
        process.exitCode = 1;
      });
    }

    // The probe merged into somebody else's line. Take back exactly the unit it added,
    // and only while a fresh read still shows what it left — a further change belongs to
    // whoever made it.
    if (mergedLine !== null) {
      const { lineId: merged, produced } = mergedLine;
      const now = (await reader().getList().catch(() => null))?.items.find(
        (item) => item.lineId === merged,
      );
      if (now === undefined) {
        console.log('\n🧹 the merged line is gone; nothing to undo.');
      } else if (now.quantity !== produced) {
        console.error(
          `\n⚠ the merged line reads ${now.quantity}, not the ${produced} this probe left.\n` +
            '  Somebody changed it since; NOT undoing. Reconcile by hand.',
        );
        process.exitCode = 1;
      } else {
        console.log(`\n🧹 undoing the probe's extra unit (${produced} → ${produced - 1})`);
        await lists.setItemQuantity(merged, produced - 1).catch((error: unknown) => {
          console.error('⛔ Could not undo the increment — check the list:', error);
          process.exitCode = 1;
        });
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
