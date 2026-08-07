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
  /**
   * Total budget for every call this client makes, from construction.
   *
   * The per-call timeout bounds one request; it does not bound a *sequence*. An add of
   * two units is search + add + set-quantity, and a broadened search makes it four calls —
   * 12 seconds at the 3s per-call limit, against Alexa's ~8s ceiling. Exceeding it is
   * worse than failing: the list is mutated, Alexa drops the response, and the user
   * retries into a second increment.
   *
   * Instances are per-invocation, so "since construction" is the right origin.
   */
  budgetMs?: number;
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
  private readonly budgetMs: number | undefined;
  private readonly createdAt: number;

  /**
   * Callers waiting for a concurrency slot.
   *
   * A single "await the most recent request" promise is not equivalent: with two requests
   * in flight, the *earlier* one finishing frees a slot that nobody is watching, so a
   * queued caller idles until the slower request also completes. On the shared stdio
   * client that delays one MCP tool behind an unrelated slow one for no reason.
   */
  private waiters: Array<() => void> = [];
  private active = 0;
  /** When the most recent request *started*, so spacing is measured start-to-start. */
  private lastStart = Number.NEGATIVE_INFINITY;
  /** Serialises acquisition so concurrency and spacing are decided together, not racily. */
  private gate: Promise<void> = Promise.resolve();

  constructor(options: HebClientOptions) {
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? HEB_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.minDelayMs = options.minDelayMs ?? MIN_REQUEST_DELAY_MS;
    this.budgetMs = options.budgetMs;
    this.createdAt = this.now();
  }

  /**
   * Fail a promise that outlives the remaining budget.
   *
   * The work itself keeps running — there is no way to cancel an in-flight SDK call from
   * here — but the caller stops waiting, which is what the deadline is actually for.
   */
  private async withinBudget<T>(work: Promise<T>, description: string): Promise<T> {
    const remaining = Math.min(this.remainingBudget(), this.timeoutMs);
    if (remaining <= 0) {
      throw new HebError('UPSTREAM_ERROR', `Ran out of time before we could ${description}.`, {
        retryable: false,
      });
    }
    if (!Number.isFinite(remaining)) return work;

    let timer: ReturnType<typeof setTimeout>;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new HebError('UPSTREAM_ERROR', `Timed out trying to ${description}.`, {
              retryable: true,
            }),
          ),
        remaining,
      );
    });

    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Milliseconds left in the invocation budget, or Infinity when none was set. */
  private remainingBudget(): number {
    if (this.budgetMs === undefined) return Number.POSITIVE_INFINITY;
    return this.createdAt + this.budgetMs - this.now();
  }

  async execute<T>(document: GraphqlDocument): Promise<T> {
    // The store read counts against the budget too. In production this is a DynamoDB call
    // that can stall or spend seconds retrying, and it happens *before* `send()` checks
    // the remaining budget — so an unbounded await here lets Alexa hit its hard timeout
    // with no spoken response at all, while this class claims every call is bounded.
    const session = await this.withinBudget(
      this.store.getSession(),
      'read the stored session',
    );
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
    // Refuse rather than start a call that cannot finish inside the budget. Failing fast
    // leaves time to say something; overrunning says nothing at all.
    const remaining = this.remainingBudget();
    if (remaining <= 0) {
      throw new HebError('UPSTREAM_ERROR', 'Ran out of time before HEB could be called.', {
        retryable: false,
        details: { operation: document.operationName },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, remaining));

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
      // HEB sometimes serves a GraphQL error envelope (e.g. GRAPHQL_VALIDATION_FAILED for
      // schema drift) with a non-2xx status instead of the usual 200. Route it through the
      // same classifier a 200 envelope would use rather than reporting it as a generic HTTP
      // error — otherwise it loses `schemaDrift`, is marked retryable purely by status, and a
      // mutation caller can misread a definitively pre-execution validation failure as an
      // indeterminate write.
      let parsedEnvelope: GraphqlEnvelope<T> | undefined;
      try {
        parsedEnvelope = JSON.parse(body) as GraphqlEnvelope<T>;
      } catch {
        parsedEnvelope = undefined;
      }
      if (parsedEnvelope?.errors?.length) {
        throw toGraphqlError(document, parsedEnvelope.errors);
      }

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
    await this.acquire();

    try {
      return await task();
    } finally {
      this.active -= 1;
      this.wake();
    }
  }

  /** Release everyone waiting; whoever the scheduler resumes first takes the slot. */
  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  /**
   * Wait until this request may begin, holding both invariants at once.
   *
   * Concurrency and spacing cannot be enforced independently. Taking a slot and *then*
   * computing a start time looks right and is not: when both slots are held by slow
   * requests, every waiting caller resumes with `lastStart` far in the past, so
   * `max(now, lastStart + delay)` yields `now` for all of them and they start together —
   * a burst aimed at Imperva at exactly the moment the upstream is already struggling.
   * Measured before this change: six requests at a 200ms floor started at 2, 201, 1703,
   * 1703, 1714, 1714ms.
   *
   * So the whole acquisition is serialised through `gate`. Only one caller can be between
   * "a slot is free" and "my start time is reserved", which makes the reservations chain
   * strictly. The delay is awaited while still holding the gate, because start-to-start
   * spacing is precisely the guarantee that the *next* caller must not begin during it.
   */
  private async acquire(): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      while (this.active >= MAX_CONCURRENT_REQUESTS) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
      this.active += 1;

      const startAt = Math.max(this.now(), this.lastStart + this.minDelayMs);
      this.lastStart = startAt;

      const wait = startAt - this.now();
      if (wait > 0) await delay(wait);
    } finally {
      release();
    }
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
