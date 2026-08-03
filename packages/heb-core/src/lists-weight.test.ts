/**
 * Write-path behaviour for counter goods and written lines, against a scripted HEB.
 *
 * These assert on the *GraphQL text actually sent*, because the bugs they guard are all of
 * the same shape: a plausible-looking call that names the wrong unit. A test that only
 * checked the returned object would pass while the list took a quantity update it cannot
 * honour.
 */

import { describe, expect, it } from 'vitest';
import { HebClient } from './graphql/client.js';
import { HebListOps, snapWeight } from './lists.js';
import { hasCode } from './errors.js';
import type { SessionState, Store } from './types.js';

const NOW = 1_800_000_000_000;

function storeWith(): Store {
  const far = NOW / 1_000 + 30 * 24 * 3600;
  const cookie = (name: string, domain: string) => ({
    name, value: `fixture-${name}`, domain, path: '/', expires: far,
    httpOnly: true, secure: true, sameSite: 'Lax' as const,
  });
  return {
    getSession: async (): Promise<SessionState> => ({
      cookies: [
        cookie('sat', 'www.heb.com'), cookie('sst', 'www.heb.com'),
        cookie('sst.sig', 'www.heb.com'), cookie('reese84', '.heb.com'),
      ],
      capturedAt: NOW,
      buildId: null,
    }),
    putSession: async () => undefined,
  };
}

interface FakeLine {
  id: string;
  quantity: number;
  weight?: number;
  productId?: string;
  name?: string;
  genericName?: string;
}

/** Products the scripted store knows about. Only the fields the code reads. */
const CATALOG: Record<string, { name: string; pricedByWeight: boolean; increments: number[] }> = {
  'p-turkey': {
    name: 'H-E-B Deli Honey-Smoked Turkey Breast, Custom Sliced, lb',
    pricedByWeight: true,
    increments: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5],
  },
  'p-milk': { name: 'H-E-B Half & Half, 32 oz', pricedByWeight: false, increments: [] },
};

function scripted(lines: FakeLine[]) {
  /** Every query document sent, in order. The assertions read these. */
  const sent: string[] = [];

  const wire = (line: FakeLine): object => {
    if (line.genericName !== undefined) {
      return {
        __typename: 'GenericShoppingListItemV2',
        id: line.id,
        quantity: line.quantity,
        genericName: line.genericName,
      };
    }
    const entry = CATALOG[line.productId!]!;
    return {
      __typename: 'ProductShoppingListItemV2',
      id: line.id,
      quantity: line.quantity,
      weight: line.weight ?? null,
      product: {
        __typename: 'Product',
        id: line.productId,
        fullDisplayName: entry.name,
        pricedByWeight: entry.pricedByWeight,
        SKUs: [{ weightSelectionIncrements: entry.increments }],
      },
    };
  };

  const payload = () => ({
    __typename: 'ShoppingListV2',
    id: 'list-1',
    name: 'Shopping',
    fulfillment: { store: { storeNumber: 1 } },
    itemPage: { items: lines.map(wire) },
  });

  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { operationName: string; query: string };
    sent.push(body.query);

    switch (body.operationName) {
      case 'HebGetShoppingList':
        return json({ getShoppingListV2: payload() });

      case 'HebAddShoppingListItems': {
        const productId = /productId: "([^"]+)"/.exec(body.query)?.[1];
        const entry = CATALOG[productId!]!;
        lines.push({
          id: `line-${lines.length}`,
          quantity: 1,
          productId: productId!,
          // HEB assigns a counter line its own smallest weight on creation.
          ...(entry.pricedByWeight ? { weight: entry.increments[0]! } : {}),
        });
        return json({ addShoppingListItemsV2: payload() });
      }

      case 'HebAddShoppingListText': {
        const text = /genericName: "([^"]+)"/.exec(body.query)?.[1];
        lines.push({ id: `line-${lines.length}`, quantity: 1, genericName: text! });
        return json({ addShoppingListItemsV2: payload() });
      }

      case 'HebUpdateShoppingListItem': {
        const id = /itemId: "([^"]+)"/.exec(body.query)?.[1];
        const quantity = Number(/quantity: (\d+)/.exec(body.query)?.[1]);
        const target = lines.find((line) => line.id === id);
        if (target !== undefined) target.quantity = quantity;
        return json({ updateShoppingListItemV2: payload() });
      }

      case 'HebUpdateShoppingListItemWeight': {
        const id = /itemId: "([^"]+)"/.exec(body.query)?.[1];
        const weight = Number(/weight: ([\d.]+)/.exec(body.query)?.[1]);
        const target = lines.find((line) => line.id === id);
        if (target !== undefined) target.weight = weight;
        return json({ updateShoppingListItemV2: payload() });
      }

      default:
        throw new Error(`unscripted operation ${body.operationName}`);
    }
  }) as unknown as typeof fetch;

  const ops = new HebListOps({
    client: new HebClient({ store: storeWith(), fetchImpl, now: () => NOW, minDelayMs: 0 }),
    listId: 'list-1',
  });
  return { ops, sent, lines };
}

const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

/** Did we ever send a quantity update? The bug these tests guard is sending one. */
const quantityUpdates = (sent: string[]) =>
  sent.filter((query) => query.includes('quantityOrWeight: { quantity:'));
const weightUpdates = (sent: string[]) =>
  sent.filter((query) => query.includes('quantityOrWeight: { weight:'));

describe('counter lines are never driven by quantity', () => {
  it('reports an existing counter line rather than incrementing its quantity', async () => {
    // "Add sliced turkey" with no amount. There is no honest quantity to add — the line is
    // measured in pounds — and a quantity update would be refused or change a number
    // nobody buys by.
    const { ops, sent } = scripted([
      { id: 'line-0', quantity: 1, weight: 2, productId: 'p-turkey' },
    ]);

    const result = await ops.addItem({ productId: 'p-turkey' });

    expect(result.status).toBe('already_present');
    expect(result.status === 'already_present' && result.item.weight).toBe(2);
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(weightUpdates(sent)).toHaveLength(0);
  });

  it('does not issue a quantity update for a newly created counter line', async () => {
    // "Add three sliced turkeys" is not expressible: counter goods have no unit to
    // multiply. The line is created and confirmed at the weight HEB gave it.
    const { ops, sent } = scripted([]);

    const result = await ops.addItem({ productId: 'p-turkey', quantity: 3 });

    expect(result.status).toBe('added');
    expect(result.status === 'added' && result.item.weight).toBe(0.25);
    expect(quantityUpdates(sent)).toHaveLength(0);
  });

  it('still uses quantity for an ordinary packaged good', async () => {
    // The guard above must not disarm the normal path.
    const { ops, sent } = scripted([]);

    const result = await ops.addItem({ productId: 'p-milk', quantity: 3 });

    expect(result.status === 'added' && result.item.quantity).toBe(3);
    expect(quantityUpdates(sent)).toHaveLength(1);
  });
});

describe('weight on a counter line', () => {
  it('adds to what is already there, snapped to the ladder', async () => {
    const { ops, sent } = scripted([
      { id: 'line-0', quantity: 1, weight: 0.5, productId: 'p-turkey' },
    ]);

    const result = await ops.addItem({ productId: 'p-turkey', weight: 1 });

    expect(result.status === 'already_present' && result.item.weight).toBe(1.5);
    expect(weightUpdates(sent)).toHaveLength(1);
    expect(quantityUpdates(sent)).toHaveLength(0);
  });

  it('sets the requested weight on a new line', async () => {
    const { ops } = scripted([]);

    const result = await ops.addItem({ productId: 'p-turkey', weight: 2 });

    expect(result.status === 'added' && result.item.weight).toBe(2);
  });

  it('snaps an off-ladder request rather than letting HEB refuse it', async () => {
    const { ops, sent } = scripted([]);

    await ops.addItem({ productId: 'p-turkey', weight: 1.3 });

    expect(weightUpdates(sent)[0]).toContain('weight: 1.25');
  });
});

describe('written lines', () => {
  it('honours a quantity, which HEB accepts on a generic line', async () => {
    // Verified against the live list: an update on a generic line read back as 3.
    // Discarding it would report success for a request that was not carried out.
    const { ops, sent } = scripted([]);

    const result = await ops.addItem({ text: 'birthday candles', quantity: 3 });

    expect(result.status === 'added' && result.item.quantity).toBe(3);
    expect(result.status === 'added' && result.item.text).toBe('birthday candles');
    expect(quantityUpdates(sent)).toHaveLength(1);
  });

  it('writes a single line without an update when no quantity is asked for', async () => {
    const { ops, sent } = scripted([]);

    await ops.addItem({ text: 'birthday candles' });

    expect(quantityUpdates(sent)).toHaveLength(0);
  });

  it('refuses a weight, which a line with no product cannot have', async () => {
    const { ops } = scripted([]);

    await expect(ops.addItem({ text: 'birthday candles', weight: 2 })).rejects.toThrow(TypeError);
  });

  it('refuses more than one of query, productId and text', async () => {
    const { ops } = scripted([]);

    await expect(ops.addItem({ text: 'a', productId: 'p-milk' })).rejects.toThrow(TypeError);
    await expect(ops.addItem({})).rejects.toThrow(TypeError);
  });
});

describe('failed writes never invite a duplicating retry', () => {
  /** A store whose reads work once and then fail, to force the reconciliation path. */
  function failingAfter(mutation: string) {
    const { ops, sent } = scripted([]);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    let mutationSeen = false;
    client.execute = async (document: unknown) => {
      const name = (document as { operationName: string }).operationName;
      if (name === mutation) {
        mutationSeen = true;
        throw new Error('connection reset');
      }
      // Every read *after* the lost mutation also fails: the budget is gone.
      if (mutationSeen && name === 'HebGetShoppingList') throw new Error('connection reset');
      return real(document);
    };
    return { ops, sent };
  }

  it('marks a lost free-text add as indeterminate, not retryable', async () => {
    // A written line has no product id to deduplicate against, so a retry writes a second
    // copy. "Try again" is the one answer that can make this worse.
    const { ops } = failingAfter('HebAddShoppingListText');

    await expect(ops.addItem({ text: 'birthday candles' })).rejects.toSatisfy((error: unknown) => {
      const typed = error as { details?: Record<string, unknown>; retryable?: boolean };
      return (
        hasCode(error, 'UPSTREAM_ERROR') &&
        typed.details?.['indeterminate'] === true &&
        typed.retryable === false
      );
    });
  });

  it('marks a lost weight adjustment on a new line as a partial add', async () => {
    // The line already exists at HEB's default weight. A retry takes the existing-line
    // path and adds the whole request on top of that default.
    const { ops } = failingAfter('HebUpdateShoppingListItemWeight');

    await expect(ops.addItem({ productId: 'p-turkey', weight: 2 })).rejects.toSatisfy(
      (error: unknown) => {
        const typed = error as { details?: Record<string, unknown>; retryable?: boolean };
        return typed.details?.['partialAdd'] === true && typed.retryable === false;
      },
    );
  });
});

describe('snapWeight rounds toward the shopper', () => {
  it('never returns a rung the product does not offer', () => {
    expect([0.25, 0.5, 0.75]).toContain(snapWeight(0.4, [0.25, 0.5, 0.75]));
  });
});
