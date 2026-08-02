import { describe, expect, it, vi } from 'vitest';
import { HebClient } from './client.js';
import { addItemsDocument, getShoppingListsDocument } from './operations.js';
import { HebError, hasCode } from '../errors.js';
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
