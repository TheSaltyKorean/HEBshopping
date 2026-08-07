/**
 * One contract suite, run against every `Store` implementation.
 *
 * The point is that `FileStore` and `DynamoDbStore` are interchangeable — the whole local
 * development story depends on it. Testing them separately would let them drift in ways
 * that only surface after deploy, which is exactly the wrong time to find out.
 *
 * Exported from the package so an implementation living in another package can run it.
 */

import { describe, expect, it } from 'vitest';
import type { SessionState, Store } from '../types.js';

export interface StoreHarness {
  store: Store;
  cleanup: () => Promise<void>;
}

export function sampleSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    cookies: [
      {
        name: 'sat',
        value: 'fixture-val',
        domain: 'www.heb.com',
        path: '/',
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: '_session',
        value: 'fixture-val',
        domain: 'accounts.heb.com',
        path: '/',
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    capturedAt: 1_700_000_000_000,
    buildId: 'fixture-build-id',
    ...overrides,
  };
}

export function runStoreContract(name: string, createHarness: () => Promise<StoreHarness>): void {
  describe(`Store contract: ${name}`, () => {
    it('returns null when no session has been stored', async () => {
      const { store, cleanup } = await createHarness();
      try {
        expect(await store.getSession()).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('round-trips a session unchanged', async () => {
      const { store, cleanup } = await createHarness();
      try {
        const session = sampleSession();
        await store.putSession(session);
        expect(await store.getSession()).toEqual(session);
      } finally {
        await cleanup();
      }
    });

    it('preserves cookies for both heb.com hosts', async () => {
      // Auth spans www.heb.com and accounts.heb.com. A store that silently dropped one
      // host would look fine until the session needed renewing.
      const { store, cleanup } = await createHarness();
      try {
        await store.putSession(sampleSession());
        const loaded = await store.getSession();
        const domains = loaded?.cookies.map((c) => c.domain).sort();
        expect(domains).toEqual(['accounts.heb.com', 'www.heb.com']);
      } finally {
        await cleanup();
      }
    });

    it('overwrites rather than merges on a second put', async () => {
      const { store, cleanup } = await createHarness();
      try {
        await store.putSession(sampleSession({ capturedAt: 1 }));
        await store.putSession(sampleSession({ capturedAt: 2 }));
        expect((await store.getSession())?.capturedAt).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it('accepts a null buildId', async () => {
      // accounts.heb.com is not a Next.js app, so a session captured mid-login legitimately
      // has no buildId.
      const { store, cleanup } = await createHarness();
      try {
        await store.putSession(sampleSession({ buildId: null }));
        expect((await store.getSession())?.buildId).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });
}
