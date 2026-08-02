import { describe, expect, it, vi } from 'vitest';
import { HebClient } from './client.js';
import { addItemsDocument, getShoppingListsDocument } from './operations.js';
import { HebError, hasCode } from '../errors.js';
import { HebListOps } from '../lists.js';
import type { SessionState, Store } from '../types.js';

const NOW = 1_800_000_000_000; // fixed clock; no wall-clock dependence in tests

function session(overrides: Partial<SessionState> = {}): SessionState {
  const farFuture = NOW / 1_000 + 30 * 24 * 3600;
  const cookie = (name: string, domain: string, expires = farFuture) => ({
    name,
    value: `fixture-${name}`,
    domain,
    path: '/',
    expires,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
  });

  return {
    cookies: [
      cookie('sat', 'www.heb.com'),
      cookie('sst', 'www.heb.com'),
      // The signature over `sst`, and independently required — see REQUIRED_REQUEST_COOKIES.
      cookie('sst.sig', 'www.heb.com'),
      cookie('reese84', '.heb.com'),
      cookie('_session', 'accounts.heb.com'),
    ],
    capturedAt: NOW,
    buildId: 'fixture',
    ...overrides,
  };
}

function storeWith(state: SessionState | null): Store {
  return {
    getSession: async () => state,
    putSession: async () => undefined,
  };
}

function client(fetchImpl: typeof fetch, state: SessionState | null = session()) {
  return new HebClient({
    store: storeWith(state),
    fetchImpl,
    now: () => NOW,
    minDelayMs: 0, // don't pay the politeness delay in tests
  });
}

const respond = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

describe('HebClient', () => {
  it('returns the data envelope on success', async () => {
    const fetchImpl = respond(JSON.stringify({ data: { getShoppingListsV2: { lists: [] } } }));
    const result = await client(fetchImpl).execute(getShoppingListsDocument());
    expect(result).toEqual({ getShoppingListsV2: { lists: [] } });
  });

  it('sends our own query text, not a persisted hash, plus storefront cookies', async () => {
    const fetchImpl = respond(JSON.stringify({ data: {} }));
    await client(fetchImpl).execute(getShoppingListsDocument());

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.operationName).toBe('HebGetShoppingLists');
    expect(body.query).toContain('getShoppingListsV2');
    // HEB's persisted-query store is a cache that evicts rare operations, so depending on
    // a hash would make delete the least reliable operation. Send the text every time.
    expect(body.extensions).toBeUndefined();

    // accounts.heb.com cookies must NOT be sent to www.heb.com — they don't belong to that
    // host, and including them would be a needless credential leak across origins.
    const cookies = (init.headers as Record<string, string>).Cookie;
    expect(cookies).toContain('sat=');
    expect(cookies).toContain('reese84=');
    expect(cookies).not.toContain('_session=');
  });

  it('refuses to call at all when no session is stored', async () => {
    const fetchImpl = respond('{}');
    await expect(client(fetchImpl, null).execute(getShoppingListsDocument())).rejects.toSatisfy(
      (error: unknown) => hasCode(error, 'SESSION_EXPIRED'),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a session whose required cookies have expired', async () => {
    const past = NOW / 1_000 - 3600;
    const expired = session({
      cookies: session().cookies.map((c) => (c.name === 'sat' ? { ...c, expires: past } : c)),
    });
    const fetchImpl = respond('{}');
    await expect(
      client(fetchImpl, expired).execute(getShoppingListsDocument()),
    ).rejects.toSatisfy((error: unknown) => hasCode(error, 'SESSION_EXPIRED'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('detects the Imperva interstitial before trying to parse JSON', async () => {
    // Imperva replies with HTML and often a 200, so a naive JSON.parse would report a
    // confusing syntax error instead of the real cause.
    const fetchImpl = respond('<html><title>Pardon Our Interruption</title></html>');
    await expect(client(fetchImpl).execute(getShoppingListsDocument())).rejects.toSatisfy(
      (error: unknown) => hasCode(error, 'BOT_CHALLENGE'),
    );
  });

  it('maps 403 to an expired session', async () => {
    const fetchImpl = respond('{}', 403);
    await expect(client(fetchImpl).execute(getShoppingListsDocument())).rejects.toSatisfy(
      (error: unknown) => hasCode(error, 'SESSION_EXPIRED'),
    );
  });

  it('explains schema drift and how to fix it', async () => {
    const fetchImpl = respond(
      JSON.stringify({
        errors: [
          {
            message: 'Cannot query field "totalItemCount" on type "ShoppingListResponseV2".',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          },
        ],
      }),
    );

    const error = await client(fetchImpl)
      .execute(addItemsDocument('list-1', ['p-1']))
      .catch((e: unknown) => e as HebError);

    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.details?.schemaDrift).toBe(true);
    // The message must name the remedy: this failure is a chore, not a mystery.
    expect(error.message).toContain('operations.ts');
    // Retrying an unchanged request cannot help.
    expect(error.retryable).toBe(false);
  });

  it('times out rather than awaiting indefinitely', async () => {
    // An unbounded await would blow Alexa's ~8s budget and produce no spoken response.
    const fetchImpl = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;

    const timed = new HebClient({
      store: storeWith(session()),
      fetchImpl,
      now: () => NOW,
      minDelayMs: 0,
      timeoutMs: 20,
    });

    const error = await timed
      .execute(getShoppingListsDocument())
      .catch((e: unknown) => e as HebError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toContain('did not respond');
    expect(error.retryable).toBe(true);
  });

  it('surfaces generic GraphQL errors without leaking internals into the message', async () => {
    const fetchImpl = respond(JSON.stringify({ errors: [{ message: 'Internal server error' }] }));
    const error = await client(fetchImpl)
      .execute(getShoppingListsDocument())
      .catch((e: unknown) => e as HebError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.retryable).toBe(true);
  });
});

describe('politeness throttle', () => {
  it('spaces concurrent request STARTS, not just completions', async () => {
    // The bug this guards: every concurrent caller reads the same `lastStart`, waits the
    // same interval, and starts together — spacing nothing, and presenting HEB's bot
    // protection with exactly the burst the delay exists to avoid.
    const starts: number[] = [];
    const client = new HebClient({
      // Real clock here: this test is about elapsed time between starts.
      store: storeWith(session({ capturedAt: Date.now() })),
      minDelayMs: 50,
      fetchImpl: (async () => {
        starts.push(Date.now());
        return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await Promise.all([1, 2, 3, 4].map(() => client.execute(getShoppingListsDocument())));

    const gaps = starts.slice(1).map((start, index) => start - starts[index]!);
    expect(starts).toHaveLength(4);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(45);
  });
});

describe('union rejection is not an empty result', () => {
  it('does not report "no lists" when HEB refuses the read', async () => {
    // The refusal arrives as a different union member carrying only __typename, which is a
    // structurally valid data envelope. Mapping it would produce a confident, wrong, and
    // unactionable "this account has no shopping lists".
    const fetchImpl = respond(
      JSON.stringify({ data: { getShoppingListsV2: { __typename: 'ShoppingListErrorV2' } } }),
    );
    const ops = new HebListOps({ client: client(fetchImpl) });
    await expect(ops.getLists()).rejects.toSatisfy((error: unknown) =>
      hasCode(error, 'UPSTREAM_ERROR'),
    );
  });

  it('does not report "no products" when HEB refuses the search', async () => {
    const fetchImpl = respond(
      JSON.stringify({
        data: {
          getShoppingListV2: {
            __typename: 'ShoppingListV2',
            id: 'l',
            name: 'Shopping',
            fulfillment: { store: { storeNumber: 1 } },
            itemPage: { items: [] },
          },
        },
      }),
    );
    const ops = new HebListOps({ client: client(fetchImpl), listId: 'l' });
    await ops.getList();

    const refused = respond(
      JSON.stringify({ data: { productSearchItems: { __typename: 'SearchErrorV2' } } }),
    );
    const ops2 = new HebListOps({ client: client(refused), listId: 'l' });
    await expect(ops2.searchProducts('milk')).rejects.toThrow();
  });
});

describe('throttle under upstream slowdown', () => {
  it('does not burst when occupied slots free up', async () => {
    // The failure this guards, measured before the fix: with both slots held by slow
    // requests, every waiter resumed with `lastStart` far in the past, so each computed
    // "start now" and they went together — 2, 201, 1703, 1703, 1714, 1714ms at a 200ms
    // floor. A burst aimed at Imperva exactly when the upstream is already struggling.
    const starts: number[] = [];
    let served = 0;

    const client = new HebClient({
      store: storeWith(session({ capturedAt: Date.now() })),
      minDelayMs: 60,
      fetchImpl: (async () => {
        starts.push(Date.now());
        const slow = served++ < 2; // occupy both slots for far longer than the interval
        await new Promise((resolve) => setTimeout(resolve, slow ? 400 : 5));
        return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await Promise.all(
      Array.from({ length: 6 }, () => client.execute(getShoppingListsDocument())),
    );

    expect(starts).toHaveLength(6);
    for (const [index, start] of starts.slice(1).entries()) {
      expect(start - starts[index]!).toBeGreaterThanOrEqual(55);
    }
  });
});

describe('session health with duplicate cookies', () => {
  it('accepts a live copy even when an expired one comes first', async () => {
    // Browser jars legitimately hold the same name for .heb.com and www.heb.com. Using
    // `find` made health depend on array order, forcing a login while valid credentials
    // sat further down the array.
    const past = NOW / 1_000 - 3_600;
    const base = session();
    const stale = { ...base.cookies.find((c) => c.name === 'sat')!, domain: '.heb.com', expires: past };

    const withDuplicate = session({ cookies: [stale, ...base.cookies] });
    const fetchImpl = respond(JSON.stringify({ data: { ok: 1 } }));

    await expect(client(fetchImpl, withDuplicate).execute(getShoppingListsDocument())).resolves
      .toBeDefined();
  });
});

describe('session health prefers the longest-lived duplicate', () => {
  it('is usable when a near-expiry copy sits ahead of a long-lived one', async () => {
    // Otherwise a duplicate expiring inside the safety margin, merely because it comes
    // first in the array, condemns a jar that is good for weeks.
    const soon = NOW / 1_000 + 60; // inside the one-hour margin
    const base = session();
    const nearlyDead = { ...base.cookies.find((c) => c.name === 'sat')!, domain: '.heb.com', expires: soon };

    const jar = session({ cookies: [nearlyDead, ...base.cookies] });
    const fetchImpl = respond(JSON.stringify({ data: { ok: 1 } }));

    await expect(client(fetchImpl, jar).execute(getShoppingListsDocument())).resolves.toBeDefined();
  });
});

describe('outgoing cookie header', () => {
  it('omits an expired duplicate and keeps the live one', async () => {
    // checkSession accepts the jar on the strength of the live copy; if the header still
    // led with the dead one, a server resolving the first duplicate would reject a session
    // we had just declared usable.
    const past = NOW / 1_000 - 3_600;
    const base = session();
    const dead = { ...base.cookies.find((c) => c.name === 'sat')!, domain: '.heb.com', expires: past };

    const fetchImpl = respond(JSON.stringify({ data: { ok: 1 } }));
    await client(fetchImpl, session({ cookies: [dead, ...base.cookies] })).execute(
      getShoppingListsDocument(),
    );

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const header = (init.headers as Record<string, string>).Cookie;
    expect(header).toContain('sat=fixture-sat');
    expect(header.match(/sat=/g)).toHaveLength(1);
  });
});
