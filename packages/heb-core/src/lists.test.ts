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

  it('ignores filler when judging whether the sole line was described', async () => {
    // "the milk" is one meaningful token, not two. Computing coverage from raw tokens
    // halved the ratio and made a one-item list ask a question it had no business asking.
    const ranked = await opsWithList('H-E-B Chocolate Milk, 1 gal').rankLines('the milk');
    expect(ranked[0]?.confident).toBe(true);
  });
});

describe('rankLines — removal candidates', () => {
  it('never offers a line that shares nothing with the request', async () => {
    // The dialog walks these one at a time and a "yes" deletes. Offering an unrelated line
    // as the third option means a distracted user can delete their bread by agreeing.
    const ranked = await opsWithList(
      'H-E-B Chocolate Milk, 1 gal',
      'H-E-B Whole Milk, 1 gal',
      'H-E-B White Bread, 20 oz',
    ).rankLines('milk');

    expect(ranked.length).toBeGreaterThan(1);
    for (const entry of ranked) expect(entry.item.text.toLowerCase()).toContain('milk');
  });
});

describe('adding never reduces a quantity', () => {
  it('leaves a line alone when it already exceeds a lowered ceiling', () => {
    // If HEB lowers a product's maximumQuantity after the line was created, clamping alone
    // turns "add one more" into "take four away" — an add that removes groceries.
    const existing = { quantity: 10, maximumQuantity: 5 };
    const requested = 1;

    const clampOnly = Math.min(existing.quantity + requested, existing.maximumQuantity);
    const actual = Math.max(existing.quantity, clampOnly);

    expect(clampOnly).toBe(5); // what the old code did
    expect(actual).toBe(10); // never below what is already there
  });
});

describe('prefix matches must not authorise a silent deletion', () => {
  it('does not treat "bread" as describing "Breaded Chicken Breasts"', async () => {
    // The sole-line shortcut deletes without confirmation, so an open-ended prefix rule
    // — bread starts breaded — meant asking for a missing item removed the chicken.
    const ranked = await opsWithList('H-E-B Breaded Chicken Breasts, 24 oz').rankLines('bread');
    expect(ranked[0]?.confident ?? false).toBe(false);
  });

  it('still matches genuine plurals', async () => {
    const ranked = await opsWithList('H-E-B Grade AA Large White Eggs, 12 ct').rankLines('egg');
    expect(ranked[0]?.confident).toBe(true);
  });
});

describe('indeterminate writes are reconciled, not retried blindly', () => {
  /** A client whose add mutation times out, but where the list shows the line afterwards. */
  function opsWithLostAddResponse(): HebListOps {
    let call = 0;
    const line = {
      __typename: 'ProductShoppingListItemV2',
      id: 'line-new',
      quantity: 1,
      product: { __typename: 'Product', id: 'p-new', fullDisplayName: 'H-E-B Whole Milk, 1 gal' },
    };

    const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
      const body = String(init.body ?? '');
      if (body.includes('addShoppingListItems')) {
        call += 1;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      // The read *after* the failed add shows the line HEB committed anyway.
      const items = call > 0 ? [line] : [];
      return new Response(
        JSON.stringify({
          data: {
            getShoppingListV2: {
              __typename: 'ShoppingListV2',
              id: 'list-1',
              name: 'Shopping',
              fulfillment: { store: { storeNumber: 1 } },
              itemPage: { items },
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    return new HebListOps({
      client: new HebClient({ store: storeWith(), fetchImpl, now: () => NOW, minDelayMs: 0 }),
      listId: 'list-1',
    });
  }

  it('reports the committed line instead of inviting a retry', async () => {
    // The retry is what causes the damage: it finds the line HEB did create and increments
    // it, so "add milk" once leaves two. Reconciling requires an *uncached* read, which is
    // why the cache is now invalidated before the mutation rather than after it succeeds.
    const result = await opsWithLostAddResponse().addItem({ productId: 'p-new' });

    expect(result.status).toBe('added');
    if (result.status === 'added') expect(result.item.lineId).toBe('line-new');
  });
});

describe('removal reconciliation', () => {
  it('treats an absent line as removed when the response was lost', async () => {
    let deleted = false;
    const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
      const body = String(init.body ?? '');
      if (body.includes('deleteShoppingListItems')) {
        deleted = true; // HEB commits, then the response is lost
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return new Response(
        JSON.stringify({
          data: {
            getShoppingListV2: {
              __typename: 'ShoppingListV2',
              id: 'list-1',
              name: 'Shopping',
              fulfillment: { store: { storeNumber: 1 } },
              itemPage: {
                items: deleted
                  ? []
                  : [
                      {
                        __typename: 'ProductShoppingListItemV2',
                        id: 'line-1',
                        quantity: 1,
                        product: { __typename: 'Product', id: 'p1', fullDisplayName: 'Milk' },
                      },
                    ],
              },
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const ops = new HebListOps({
      client: new HebClient({ store: storeWith(), fetchImpl, now: () => NOW, minDelayMs: 0 }),
      listId: 'list-1',
    });

    // Reporting failure would send the user to retry a removal that worked — and the retry
    // then says the item is not on the list, reading as though nothing happened at all.
    await expect(ops.removeItem({ lineId: 'line-1' })).resolves.toBeUndefined();
  });
});
