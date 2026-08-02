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
import { FileStore, HebClient, HebListOps, HEB_GRAPHQL_URL, HEB_ORIGIN, type Cookie, type SessionState } from '@heb/core';

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
  const cookies = session.cookies
    .filter((c) => c.domain === 'www.heb.com' || c.domain === '.heb.com')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

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
  const lists = new HebListOps({ client: new HebClient({ store: new FileStore(SESSION_PATH) }) });

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
  const onList = new Set(list.items.map((item) => item.product?.id).filter(Boolean));
  const disposable = candidates.find((product) => !onList.has(product.id));
  if (disposable === undefined) {
    throw new Error('Every candidate product is already on the list; nothing safe to probe with.');
  }

  // Enter the cleanup scope *before* mutating: a commit whose response is lost rejects
  // here, and outside the try that failure would exit through the outer catch with the
  // line still on a real household list.
  let lineId: string | null = null;
  try {
    const added = await lists.addItem({ productId: disposable.id });
    if (added.status !== 'added') {
      throw new Error(`expected a fresh line, got ${added.status}`);
    }
    lineId = added.item.lineId;
    console.log(`Added throwaway line: ${added.item.text}`);
  } catch (error) {
    const committed = (await lists.getList().catch(() => null))?.items.find(
      (item) => item.product?.id === disposable.id,
    );
    if (committed === undefined) throw error;
    lineId = committed.lineId;
    console.log(`Add reported failure but committed line ${lineId}; will clean up.`);
  }

  // Whatever any attempt returns — success, a refusal union member, or a throw — the
  // throwaway line must not survive this probe. Attempts B and C run precisely when A
  // failed to delete it, so falling through without cleanup leaves test data on a real
  // household list.
  try {
    const listId = list.listId;

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
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
