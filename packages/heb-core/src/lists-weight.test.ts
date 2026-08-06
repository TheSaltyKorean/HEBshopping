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
import { HebError, hasCode } from './errors.js';
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
  maximumQuantity?: number;
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

interface Hooks {
  /** Return a successful union member whose page does not contain the new line. */
  omitAddedLine?: boolean;
}

function scripted(lines: FakeLine[], hooks: Hooks = {}) {
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
      ...(line.maximumQuantity === undefined ? {} : { maximumQuantity: line.maximumQuantity }),
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

  /** A successful `ShoppingListV2` whose page happens not to include the new line. */
  const empty = () => ({
    __typename: 'ShoppingListV2',
    id: 'list-1',
    name: 'Shopping',
    fulfillment: { store: { storeNumber: 1 } },
    itemPage: { items: [] },
  });

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
        // Real behaviour: quantity is a property of the line, so adding a product already
        // on the list increments it rather than creating a duplicate — the same merge the
        // written-line path does, and the reason `already_present` exists at all.
        const existing = lines.find((line) => line.productId === productId);
        if (existing !== undefined) existing.quantity += 1;
        else
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
        // Real behaviour, verified against the live list: a duplicate genericName does not
        // create a second line, it merges into the existing one and increments it.
        const existing = lines.find((line) => line.genericName === text);
        if (existing !== undefined) existing.quantity += 1;
        else lines.push({ id: `line-${lines.length}`, quantity: 1, genericName: text! });
        return json({ addShoppingListItemsV2: hooks.omitAddedLine === true ? empty() : payload() });
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

  it('reaches the requested count on a packaged good, additively', async () => {
    // Three units means three additive adds, never one absolute write of "3": the absolute
    // form encodes a total that was true before the last response, and overwrites anybody
    // who touched the line in between.
    const { ops, sent } = scripted([]);

    const result = await ops.addItem({ productId: 'p-milk', quantity: 3 });

    expect(result.status === 'added' && result.item.quantity).toBe(3);
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(sent.filter((query) => query.includes('addShoppingListItemsV2'))).toHaveLength(3);
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

  it('preserves a definitive refusal instead of reconciling it into a generic error', async () => {
    // A rejected union member means HEB explicitly refused the weight update, not that the
    // response was lost. Reconciling would re-read the (unchanged) line and repackage this
    // as an indistinguishable-from-transient UPSTREAM_ERROR, losing the `rejected` marker and
    // sending the caller back to retry a write that cannot succeed.
    const { ops } = scripted([{ id: 'line-0', quantity: 1, weight: 0.5, productId: 'p-turkey' }]);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if (
        (document as { operationName: string }).operationName === 'HebUpdateShoppingListItemWeight'
      ) {
        throw new HebError('UPSTREAM_ERROR', 'HEB refused the weight update.', {
          details: { rejected: true },
        });
      }
      return real(document);
    };

    await expect(ops.addItem({ productId: 'p-turkey', weight: 1 })).rejects.toSatisfy(
      (error: unknown) =>
        (error as { details?: Record<string, unknown> }).details?.['rejected'] === true,
    );
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
    // Additive, like the product path — no absolute write to overwrite a concurrent merge.
    expect(quantityUpdates(sent)).toHaveLength(0);
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

describe('written lines merge rather than duplicate', () => {
  it('adds to a line that is already there, and says so', async () => {
    // Verified live: HEB merges a duplicate genericName into the existing line. So the
    // result is not a new line, and reporting `added` would misdescribe it.
    const { ops } = scripted([{ id: 'line-0', quantity: 2, genericName: 'birthday candles' }]);

    const result = await ops.addItem({ text: 'birthday candles', quantity: 3 });

    // Consistent with the product path: "add three" onto an existing two means five.
    expect(result.status).toBe('already_present');
    expect(result.status === 'already_present' && result.item.quantity).toBe(5);
  });

  it('does not claim success when a failed add leaves a pre-existing line untouched', async () => {
    // The trap: reconciling on text alone finds somebody else's identical line and calls
    // the failed write a success — and then edits their line's quantity.
    const { ops, sent, lines } = scripted([
      { id: 'line-0', quantity: 2, genericName: 'birthday candles' },
    ]);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebAddShoppingListText') {
        throw new Error('connection reset');
      }
      return real(document);
    };

    // Indeterminate, not a fabricated success — and not retryable, because if the write
    // did land the retry merges another unit into the line.
    await expect(ops.addItem({ text: 'birthday candles', quantity: 3 })).rejects.toSatisfy(
      (error: unknown) => {
        const typed = error as { retryable?: boolean; details?: Record<string, unknown> };
        return (
          hasCode(error, 'UPSTREAM_ERROR') &&
          typed.retryable === false &&
          typed.details?.['indeterminate'] === true
        );
      },
    );
    // And the stranger's line is untouched — no quantity update was ever issued.
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(lines[0]!.quantity).toBe(2);
  });

  it('re-reads when the successful response page omits the new line', async () => {
    // A long category-sorted list can place the new line outside the returned page. The
    // add plainly committed, so an indeterminate failure here would send the user to add
    // it again — merging a second unit.
    const { ops } = scripted([], { omitAddedLine: true });

    const result = await ops.addItem({ text: 'birthday candles' });

    expect(result.status).toBe('added');
    expect(result.status === 'added' && result.item.text).toBe('birthday candles');
  });
});

describe('an expired session still reports what was already written', () => {
  /** Fail the Nth call of an operation with SESSION_EXPIRED; everything else works. */
  function expireOnNth(operation: string, nth: number, lines: FakeLine[]) {
    const { ops } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    let seen = 0;
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === operation) {
        seen += 1;
        if (seen === nth) throw new HebError('SESSION_EXPIRED', 'HEB rejected the stored session.');
      }
      return real(document);
    };
    return ops;
  }

  /** Fail one operation with SESSION_EXPIRED; everything else works. */
  function expireOn(operation: string, lines: FakeLine[]) {
    const { ops } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === operation) {
        throw new HebError('SESSION_EXPIRED', 'HEB rejected the stored session.');
      }
      return real(document);
    };
    return ops;
  }

  it('keeps both the login remedy and the partial add for a written line', async () => {
    // The line exists at quantity one. The remedy alone would send someone back to repeat
    // the request after logging in, merging another unit into it. The expiry now arrives on
    // the *second* additive add, since that is how the remaining units are applied.
    const ops = expireOnNth('HebAddShoppingListText', 2, []);

    await expect(ops.addItem({ text: 'birthday candles', quantity: 3 })).rejects.toSatisfy(
      (error: unknown) =>
        hasCode(error, 'SESSION_EXPIRED') &&
        (error as { details?: Record<string, unknown> }).details?.['partialAdd'] === true,
    );
  });

  it('keeps both for a counter line the add just created', async () => {
    // HEB already gave the line its default weight; repeating adds the request on top.
    const ops = expireOn('HebUpdateShoppingListItemWeight', []);

    await expect(ops.addItem({ productId: 'p-turkey', weight: 2 })).rejects.toSatisfy(
      (error: unknown) =>
        hasCode(error, 'SESSION_EXPIRED') &&
        (error as { details?: Record<string, unknown> }).details?.['partialAdd'] === true,
    );
  });

  it('does NOT claim a partial add when the line already existed', async () => {
    // Nothing was created here, so the plain login remedy is the whole story.
    const ops = expireOn('HebUpdateShoppingListItemWeight', [
      { id: 'line-0', quantity: 1, weight: 0.5, productId: 'p-turkey' },
    ]);

    await expect(ops.addItem({ productId: 'p-turkey', weight: 1 })).rejects.toSatisfy(
      (error: unknown) =>
        hasCode(error, 'SESSION_EXPIRED') &&
        (error as { details?: Record<string, unknown> }).details?.['partialAdd'] === undefined,
    );
  });
});

describe('a blank query is not a search', () => {
  it('rejects it rather than letting it become a written line', async () => {
    // "Add some" parses to nothing. Searching for it cannot match, and the resulting
    // PRODUCT_NOT_FOUND would reach the voice fallback and write "some" onto the list.
    const { ops } = scripted([]);

    await expect(ops.addItem({ query: '   ' })).rejects.toThrow(TypeError);
  });
});

describe('concurrent merges are preserved, not overwritten', () => {
  it('applies the remaining units to what the write returned', async () => {
    // Base 2. A household member merges the same text (→3) between the snapshot and this
    // write, whose own unit makes 4. A request for 3 must finish at 6: both adds were
    // accepted. An absolute snapshot-derived target would have set 5, destroying a unit.
    const lines: FakeLine[] = [{ id: 'line-0', quantity: 2, genericName: 'birthday candles' }];
    const { ops, sent } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    let interfered = false;
    client.execute = async (document: unknown) => {
      // Exactly once, before the first of this call's adds — one other person, one unit.
      if (
        !interfered &&
        (document as { operationName: string }).operationName === 'HebAddShoppingListText'
      ) {
        interfered = true;
        lines[0]!.quantity += 1;
      }
      return real(document);
    };

    const result = await ops.addItem({ text: 'birthday candles', quantity: 3 });

    // 2 base + their 1 + our 3 = 6, reached by three additive adds rather than a computed
    // absolute — which would have written 5 and destroyed their unit.
    expect(result.status === 'already_present' && result.item.quantity).toBe(6);
    expect(quantityUpdates(sent)).toHaveLength(0);
  });
});

describe('definitive refusals are not reconciled away', () => {
  it('rethrows a rejected text add even if the line grew meanwhile', async () => {
    // A non-success union member means the write conclusively did not happen. A household
    // member merging the same text raises the line above the snapshot, and treating that
    // as proof would report the refusal as success and then edit their line.
    const lines: FakeLine[] = [{ id: 'line-0', quantity: 2, genericName: 'birthday candles' }];
    const { ops, sent } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebAddShoppingListText') {
        lines[0]!.quantity += 1; // somebody else's add lands
        throw new HebError('UPSTREAM_ERROR', 'HEB refused to add the note.', {
          details: { rejected: true },
        });
      }
      return real(document);
    };

    await expect(ops.addItem({ text: 'birthday candles', quantity: 3 })).rejects.toSatisfy(
      (error: unknown) =>
        (error as { details?: Record<string, unknown> }).details?.['rejected'] === true,
    );
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(lines[0]!.quantity).toBe(3); // only their unit, untouched by us
  });
});

describe('the product path matches the written-line path', () => {
  it('adds the remaining units to a line a household member created first', async () => {
    // The opening read finds nothing, but somebody else creates the same product before
    // this mutation, so HEB merges this call's unit into their line and returns it at 6.
    // A request for 2 must finish at 7. The old absolute target wrote 6 — silently
    // dropping the second requested unit.
    const lines: FakeLine[] = [];
    const { ops, sent } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebAddShoppingListItems') {
        // Their line, already at five, which this add merges into.
        lines.push({ id: 'line-theirs', quantity: 5, productId: 'p-milk' });
        const result = await real(document);
        return result;
      }
      return real(document);
    };

    const result = await ops.addItem({ productId: 'p-milk', quantity: 2 });

    // Their 5, plus this call's two units, reached additively.
    expect(result.status === 'added' && result.item.quantity).toBe(7);
    expect(quantityUpdates(sent)).toHaveLength(0);
  });

  it('rethrows a definitively refused product add instead of reconciling', async () => {
    // A non-success union member means the add did not happen. A household member adding
    // the same product afterwards must not stand in as proof that it did.
    const lines: FakeLine[] = [];
    const { ops, sent } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebAddShoppingListItems') {
        lines.push({ id: 'line-theirs', quantity: 1, productId: 'p-milk' });
        throw new HebError('UPSTREAM_ERROR', 'HEB refused the add.', {
          details: { rejected: true },
        });
      }
      return real(document);
    };

    await expect(ops.addItem({ productId: 'p-milk', quantity: 3 })).rejects.toSatisfy(
      (error: unknown) =>
        (error as { details?: Record<string, unknown> }).details?.['rejected'] === true,
    );
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(lines[0]!.quantity).toBe(1); // their line, untouched
  });

  it('keeps SESSION_EXPIRED when the add itself is refused', async () => {
    // Reconciling would re-read with the same dead cookies and downgrade the auth failure
    // to an indeterminate upstream error, costing the login remedy and the expiry alarm.
    // An expired session is a definitive non-write, so nothing was created either.
    const { ops } = scripted([{ id: 'line-0', quantity: 1, productId: 'p-milk' }]);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebAddShoppingListItems') {
        throw new HebError('SESSION_EXPIRED', 'HEB rejected the stored session.');
      }
      return real(document);
    };

    await expect(ops.addItem({ productId: 'p-milk', quantity: 2 })).rejects.toSatisfy(
      (error: unknown) =>
        hasCode(error, 'SESSION_EXPIRED') &&
        (error as { details?: Record<string, unknown> }).details?.['partialAdd'] === undefined,
    );
  });

  it('reports a lost response for a later unit as indeterminate, not exact', async () => {
    // The first unit committed (the line now reads 1). The second unit's mutation is sent
    // but its response is lost — the write may have landed at HEB regardless. Asserting the
    // amount as exactly 1 would tell a caller to over-correct or misreport a total that
    // might already be 2.
    const { ops } = scripted([{ id: 'line-0', quantity: 0, productId: 'p-milk' }]);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    let calls = 0;
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebAddShoppingListItems') {
        calls += 1;
        if (calls === 2) throw new HebError('UPSTREAM_ERROR', 'response lost');
      }
      return real(document);
    };

    await expect(ops.addItem({ productId: 'p-milk', quantity: 2 })).rejects.toSatisfy(
      (error: unknown) =>
        (error as { details?: Record<string, unknown> }).details?.['indeterminate'] === true,
    );
  });

  it('increments an existing line with the atomic add, never an absolute write', async () => {
    // The whole point of the restructure: "add one more" issues the additive mutation and
    // no quantity update at all, so a household member raising the line in between cannot
    // be overwritten.
    const { ops, sent, lines } = scripted([{ id: 'line-0', quantity: 1, productId: 'p-milk' }]);

    const result = await ops.addItem({ productId: 'p-milk' });

    expect(result.status).toBe('already_present');
    expect(result.status === 'already_present' && result.item.quantity).toBe(2);
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(lines[0]!.quantity).toBe(2);
  });
});

describe('an add never lowers a concurrently raised line', () => {
  it('does not overwrite units added between the read and the write', async () => {
    // The bug this restructure removes: the line is read at 1, a household member raises
    // it to 4, and "add one more" writes an absolute 2 — deleting two of their units.
    // The additive mutation cannot do that, because HEB does the increment server-side.
    const lines: FakeLine[] = [{ id: 'line-0', quantity: 1, productId: 'p-milk' }];
    const { ops, sent } = scripted(lines);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    let raised = false;
    client.execute = async (document: unknown) => {
      const name = (document as { operationName: string }).operationName;
      // They raise it to 4 after our opening read, before our mutation.
      if (name === 'HebAddShoppingListItems' && !raised) {
        raised = true;
        lines[0]!.quantity = 4;
      }
      return real(document);
    };

    const result = await ops.addItem({ productId: 'p-milk' });

    expect(result.status === 'already_present' && result.item.quantity).toBe(5);
    expect(quantityUpdates(sent)).toHaveLength(0);
    expect(lines[0]!.quantity).toBe(5); // their four, plus ours
  });

  it('sends no mutation at all when the line is already at its ceiling', async () => {
    // Adding cannot raise it, so issuing the mutation only invites a refusal.
    const { ops, sent } = scripted([
      { id: 'line-0', quantity: 20, productId: 'p-milk', maximumQuantity: 20 },
    ]);

    const result = await ops.addItem({ productId: 'p-milk' });

    expect(result.status).toBe('already_present');
    expect(sent.filter((q) => q.includes('addShoppingListItemsV2'))).toHaveLength(0);
  });
});

describe('the weight re-read actually reaches HEB', () => {
  it('does not compute the target from a cached snapshot', async () => {
    // The previous "refresh" called getList(), which served cachedList — so the fix was a
    // no-op and a concurrently raised weight could still be overwritten. The re-read must
    // drop the cache first.
    const lines: FakeLine[] = [
      { id: 'line-0', quantity: 1, weight: 1, productId: 'p-turkey' },
    ];
    const { ops, sent } = scripted(lines);

    // Warm the cache, exactly as a real caller would by resolving the list first.
    await ops.getList();
    // A household member raises the deli order after that read.
    lines[0]!.weight = 2;

    await ops.addItem({ productId: 'p-turkey', weight: 0.25 });

    // 2 lb seen fresh, plus the quarter asked for — not 1 lb from the stale snapshot.
    expect(sent.some((query) => query.includes('weight: 2.25'))).toBe(true);
    expect(lines[0]!.weight).toBe(2.25);
  });
});

describe('a failed refresh stops the write rather than licensing it', () => {
  it('aborts a weight add when the line cannot be re-read', async () => {
    // The old `?? existing` fallback resumed with the opening snapshot — writing an
    // absolute weight derived from a value already known to be stale, which is exactly the
    // overwrite the refresh exists to prevent. A read failure must fail closed.
    const { ops, sent } = scripted([
      { id: 'line-0', quantity: 1, weight: 1, productId: 'p-turkey' },
    ]);
    const client = (ops as unknown as { client: { execute: (d: unknown) => Promise<unknown> } })
      .client;
    const real = client.execute.bind(client);
    let reads = 0;
    client.execute = async (document: unknown) => {
      if ((document as { operationName: string }).operationName === 'HebGetShoppingList') {
        reads += 1;
        if (reads > 1) throw new Error('connection reset'); // the refresh read
      }
      return real(document);
    };

    await expect(ops.addItem({ productId: 'p-turkey', weight: 1 })).rejects.toThrow();
    expect(weightUpdates(sent)).toHaveLength(0);
  });
});
