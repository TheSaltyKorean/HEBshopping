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

async function seed(): Promise<SessionState> {
  const raw = JSON.parse(
    await readFile(resolve('captures/storage-state.json'), 'utf8'),
  ) as { cookies: Cookie[] };
  const session: SessionState = { cookies: raw.cookies, capturedAt: Date.now(), buildId: null };
  await new FileStore(SESSION_PATH).putSession(session);
  return session;
}

async function rawGraphql(session: SessionState, body: unknown): Promise<any> {
  const cookies = session.cookies
    .filter((c) => c.domain === 'www.heb.com' || c.domain === '.heb.com')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const response = await fetch(HEB_GRAPHQL_URL, {
    method: 'POST',
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
  const session = await seed();
  const lists = new HebListOps({ client: new HebClient({ store: new FileStore(SESSION_PATH) }) });

  const list = await lists.getList();
  console.log(`List "${list.name}" has ${list.items.length} item(s)`);

  // Always create the line this probe is going to delete.
  //
  // Reusing an existing line would mean the successful attempt below silently deletes a
  // real household grocery — a probe has no business destroying data it did not create,
  // and a nonempty list is the normal case, not the edge case.
  const candidates = await lists.searchProducts('oat milk');
  const added = await lists.addItem({ productId: candidates[0]!.id });
  if (added.status === 'needs_confirmation') throw new Error('unreachable');
  if (added.status === 'already_present') {
    throw new Error(
      'The throwaway product is already on the list; deleting it would remove a real line. ' +
        'Re-run when it is not on the list.',
    );
  }
  const lineId = added.item.lineId;
  console.log(`Added throwaway line: ${added.item.text}`);

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

  if (unquoted?.data?.deleteShoppingListItemsV2) {
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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
