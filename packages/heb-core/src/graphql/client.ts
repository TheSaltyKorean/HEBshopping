/**
 * HEB GraphQL client.
 *
 * Sends the same persisted queries the site sends, authenticated with the stored cookie
 * jar. No browser involved: W0 established that Imperva gates *obtaining* a session, not
 * using one.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **Every call is bounded.** Alexa allows ~8s total and an add is search + mutate, so
 *     an unbounded await is a guaranteed timeout with no spoken response at all.
 *  2. **Failures map onto the error taxonomy**, so both surfaces can say something useful
 *     instead of leaking an HTTP status at a voice user.
 */

import {
  HEB_GRAPHQL_URL,
  HEB_ORIGIN,
  HEB_REQUEST_TIMEOUT_MS,
  MAX_CONCURRENT_REQUESTS,
  MIN_REQUEST_DELAY_MS,
} from '../constants.js';
import { HebError } from '../errors.js';
import { checkSession, cookieHeaderFor } from '../session.js';
import type { Store } from '../types.js';
import type { GraphqlDocument } from './operations.js';

export type FetchLike = typeof fetch;

export interface HebClientOptions {
  store: Store;
  /** Injectable so tests need no network. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Inter-request spacing. Overridable so tests don't pay the politeness delay. */
  minDelayMs?: number;
}

/** Mimics the site's own request headers; anything less gets challenged. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Content-Type': 'application/json',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: HEB_ORIGIN,
  Referer: `${HEB_ORIGIN}/shopping-list`,
};

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

export class HebClient {
  private readonly store: Store;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly minDelayMs: number;

  /** Serialises bursts so we stay a polite guest on an API that never invited us. */
  private queue: Promise<unknown> = Promise.resolve();
  private active = 0;
  /** When the most recent request *started*, so spacing is measured start-to-start. */
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(options: HebClientOptions) {
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? HEB_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.minDelayMs = options.minDelayMs ?? MIN_REQUEST_DELAY_MS;
  }

  async execute<T>(document: GraphqlDocument): Promise<T> {
    const session = await this.store.getSession();
    const health = checkSession(session, this.now());

    if (!health.usable || session === null) {
      throw new HebError('SESSION_EXPIRED', `HEB session unusable: ${health.reason}`, {
        details: { reason: health.reason },
      });
    }

    return this.throttled(() =>
      this.send<T>(document, cookieHeaderFor(session, 'www.heb.com')),
    );
  }

  private async send<T>(document: GraphqlDocument, cookieHeader: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(HEB_GRAPHQL_URL, {
        method: 'POST',
        headers: { ...BASE_HEADERS, Cookie: cookieHeader },
        // Our own query text, not a persisted hash: HEB's APQ store is a cache that
        // evicts rarely-used operations (see operations.ts).
        body: JSON.stringify({
          operationName: document.operationName,
          query: document.query,
          variables: {},
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new HebError(
        'UPSTREAM_ERROR',
        aborted ? `HEB did not respond within ${this.timeoutMs}ms` : 'HEB request failed',
        { cause: error, retryable: true, details: { operation: document.operationName } },
      );
    }

    // The timer stays armed across the body read on purpose. `fetch` resolves on *headers*,
    // so clearing it here would leave an upstream that trickles or stalls the body entirely
    // unbounded — which is the failure the per-call timeout exists to prevent, and the one
    // that would blow through Alexa's response ceiling.
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new HebError(
        'UPSTREAM_ERROR',
        aborted
          ? `HEB did not send a complete response within ${this.timeoutMs}ms`
          : 'HEB response body could not be read',
        { cause: error, retryable: true, details: { operation: document.operationName } },
      );
    } finally {
      clearTimeout(timer);
    }

    // Imperva serves an HTML interstitial rather than a GraphQL error, so this check must
    // come before any JSON parsing.
    if (/pardon our interruption|_incapsula_resource/i.test(body)) {
      throw new HebError('BOT_CHALLENGE', 'HEB served a bot-protection challenge', {
        retryable: true,
        details: { operation: document.operationName, status: response.status },
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new HebError('SESSION_EXPIRED', `HEB rejected the session (${response.status})`, {
        details: { operation: document.operationName, status: response.status },
      });
    }

    if (!response.ok) {
      // Include a snippet on 4xx: those are our fault (a malformed document) and the
      // body names the reason, which is otherwise invisible. 5xx bodies are HEB's
      // internals and are deliberately not echoed. GraphQL validation errors carry no
      // credentials, but keep this truncated so nothing large lands in a log.
      const hint = response.status < 500 ? body.replace(/\s+/g, ' ').slice(0, 300) : undefined;
      throw new HebError('UPSTREAM_ERROR', `HEB returned HTTP ${response.status}`, {
        retryable: response.status >= 500,
        details: {
          operation: document.operationName,
          status: response.status,
          ...(hint === undefined ? {} : { hint }),
        },
      });
    }

    let envelope: GraphqlEnvelope<T>;
    try {
      envelope = JSON.parse(body) as GraphqlEnvelope<T>;
    } catch (error) {
      throw new HebError('UPSTREAM_ERROR', 'HEB returned a non-JSON response', {
        cause: error,
        retryable: true,
        details: { operation: document.operationName },
      });
    }

    if (envelope.errors?.length) {
      throw toGraphqlError(document, envelope.errors);
    }

    if (envelope.data === undefined) {
      throw new HebError('UPSTREAM_ERROR', 'HEB returned no data', {
        retryable: true,
        details: { operation: document.operationName },
      });
    }

    return envelope.data;
  }

  /**
   * Cap concurrency and space requests out.
   *
   * Hand-rolled rather than pulled from a dependency: the whole behaviour is a queue and a
   * delay, and it keeps `heb-core` dependency-free so the Lambda bundle stays small.
   */
  private async throttled<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT_REQUESTS) {
      await this.queue.catch(() => undefined);
    }

    // Space requests by *start* time, not by completion.
    //
    // Delaying after a task finishes spaces nothing: `active` has already been decremented
    // by then, so a waiting call starts during the delay rather than after it, and two
    // concurrent calls that both see a free slot start together. Since being a polite
    // client is the whole point — HEB never invited us, and Imperva is watching — the gate
    // has to be on when a request begins.
    // The slot is claimed *synchronously*, before any await. Computing a deadline and then
    // awaiting would let every concurrent caller read the same `lastStart`, all wait the
    // same interval, and all start together — spacing nothing. Reserving first works
    // because this read-modify-write cannot be interleaved on a single thread.
    const startAt = Math.max(this.now(), this.lastStart + this.minDelayMs);
    const wait = startAt - this.now();
    this.lastStart = startAt;
    if (wait > 0) await delay(wait);

    // Re-acquire the concurrency slot after sleeping. Several callers can clear the check
    // above before any of them sleeps, and each would otherwise wake and increment
    // `active` without looking again — putting more requests in flight than the cap allows
    // whenever a request outlasts the spacing interval.
    while (this.active >= MAX_CONCURRENT_REQUESTS) {
      await this.queue.catch(() => undefined);
    }

    this.active += 1;
    const run = (async () => {
      try {
        return await task();
      } finally {
        this.active -= 1;
      }
    })();

    this.queue = run.catch(() => undefined);
    return run;
  }
}

function toGraphqlError(
  document: GraphqlDocument,
  errors: NonNullable<GraphqlEnvelope<unknown>['errors']>,
): HebError {
  const codes = errors.map((error) => error.extensions?.code).filter(Boolean);
  const messages = errors.map((error) => error.message ?? 'unknown').join('; ');

  // Schema drift is operationally distinctive: retrying cannot help, and the fix is a
  // specific chore rather than a mystery. Say so instead of burying it in a generic error.
  if (codes.includes('GRAPHQL_VALIDATION_FAILED')) {
    return new HebError(
      'UPSTREAM_ERROR',
      `HEB rejected the shape of "${document.operationName}" — its schema changed. ` +
        `Re-capture and update graphql/operations.ts. (${messages})`,
      { retryable: false, details: { operation: document.operationName, schemaDrift: true } },
    );
  }

  if (codes.includes('UNAUTHENTICATED') || /not (logged in|authenticated)/i.test(messages)) {
    return new HebError('SESSION_EXPIRED', 'HEB reports the session is not authenticated', {
      details: { operation: document.operationName },
    });
  }

  return new HebError('UPSTREAM_ERROR', `HEB GraphQL error: ${messages}`, {
    retryable: true,
    details: { operation: document.operationName, codes },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
