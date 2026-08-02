/**
 * Removal semantics against a list, which is a closed set — unlike catalog search, where a
 * lone result usually means an over-constrained query hid better ones.
 */

import { describe, expect, it } from 'vitest';
import { HebClient } from './graphql/client.js';
import { HebListOps } from './lists.js';
import { hasCode } from './errors.js';
import type { SessionState, Store } from './types.js';

const NOW = 1_800_000_000_000;

function storeWith(): Store {
  const far = NOW / 1_000 + 30 * 24 * 3600;
  const cookie = (name: string, domain: string) => ({
    name, value: `fixture-${name}`, domain, path: '/', expires: far,
    httpOnly: true, secure: true, sameSite: 'Lax' as const,
  });
  const session: SessionState = {
    cookies: [
      cookie('sat', 'www.heb.com'), cookie('sst', 'www.heb.com'),
      cookie('sst.sig', 'www.heb.com'), cookie('reese84', '.heb.com'),
    ],
    capturedAt: NOW,
    buildId: null,
  };
  return { getSession: async () => session, putSession: async () => undefined };
}

/** A list holding exactly the given product names. */
function opsWithList(...names: string[]): HebListOps {
  const payload = {
    __typename: 'ShoppingListV2',
    id: 'list-1',
    name: 'Shopping',
    fulfillment: { store: { storeNumber: 1 } },
    itemPage: {
      items: names.map((name, index) => ({
        __typename: 'ProductShoppingListItemV2',
        id: `line-${index}`,
        quantity: 1,
        product: { __typename: 'Product', id: `p${index}`, fullDisplayName: name },
      })),
    },
  };

  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: { getShoppingListV2: payload } }), {
      status: 200,
    })) as unknown as typeof fetch;

  return new HebListOps({
    client: new HebClient({ store: storeWith(), fetchImpl, now: () => NOW, minDelayMs: 0 }),
    listId: 'list-1',
  });
}

describe('rankLines — the sole-line shortcut', () => {
  it('is confident when the request describes the only line', () => {
    // A one-item list is a closed set: asking a confirmation here is pointless.
    return expect(
      opsWithList('H-E-B Chocolate Milk, 1 gal').rankLines('chocolate milk'),
    ).resolves.toMatchObject([{ confident: true }]);
  });

  it('is NOT confident when the request merely shares a word', async () => {
    // The failure this guards: "remove chocolate cake" silently deleting the chocolate
    // milk, because a single shared token is enough for matchProducts to return a result.
    const ranked = await opsWithList('H-E-B Chocolate Milk, 1 gal').rankLines('chocolate cake');
    expect(ranked[0]?.confident).toBe(false);
  });

  it('refuses to guess via findLine when the match is partial', async () => {
    await expect(
      opsWithList('H-E-B Chocolate Milk, 1 gal').findLine('chocolate cake'),
    ).rejects.toSatisfy((error: unknown) => hasCode(error, 'AMBIGUOUS_REMOVAL'));
  });

  it('reports nothing on the list when no word matches at all', async () => {
    expect(await opsWithList('H-E-B Chocolate Milk, 1 gal').rankLines('motorcycle tyres')).toEqual([]);
  });
});
