/**
 * W0 discovery: capture HEB's shopping-list GraphQL operations.
 *
 * Opens a real, headed browser. The account owner logs in and performs list actions by hand; this
 * tool only watches. It never clicks add or remove itself — real account writes stay
 * with the account owner, and the app fires exactly the traffic it fires for a human.
 *
 * Why Playwright rather than injecting into an existing tab: `page.on('response')` sees
 * request bodies natively, with nothing to be wiped by the login bounce across
 * accounts.heb.com -> www.heb.com. It also doubles as the prototype for tools/login.ts
 * and the refresher's capture logic.
 *
 *   npm run capture
 *
 * Everything it writes is gitignored. The raw output contains cookies and auth headers,
 * so treat captures/ as a secret until scrubbed into fixtures/.
 */

import type { BrowserContext } from 'playwright';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filterHebStorageState, isGraphqlUrl, type StorageStateLike } from '@heb/core';
import { launchBrowser } from './lib/browser.js';

/**
 * Owner-only. These files hold the live H-E-B cookie jar and raw request/response bodies
 * for an account with a saved payment method; the default umask would commonly make them
 * world-readable, which on a shared machine is a real exposure regardless of .gitignore.
 */
const SECRET_FILE_MODE = 0o600;

/**
 * Write a file that only its owner can read, even if it already existed.
 *
 * `writeFile`'s `mode` applies only when the file is *created*. Rewriting an existing inode
 * leaves whatever permissions it already had — so a capture restored from elsewhere, or
 * created before this rule existed, keeps a live H-E-B cookie jar world-readable while the
 * code claims otherwise. The chmod is the part that actually holds the guarantee.
 *
 * On Windows it holds nothing: Node maps `chmod` onto the read-only attribute alone, so
 * these files get whatever ACL their directory hands them. The name of this function is a
 * POSIX promise, and saying so here is cheaper than someone trusting it on the wrong
 * platform — see docs/setup.md.
 */
async function writeSecret(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: SECRET_FILE_MODE });
  await chmod(path, SECRET_FILE_MODE);
}


const CAPTURE_DIR = resolve('captures');
const START_URL = 'https://www.heb.com/shopping-list';

interface CapturedOperation {
  operationName: string;
  sha256Hash: string | null;
  /** Present only when the client sent the full query text — see the non-strict APQ experiment. */
  hasFullQuery: boolean;
  /** The document itself, when the client sent one. Captures are gitignored. */
  query?: string;
  variables: unknown;
  responseStatus: number;
  responseBody: unknown;
  capturedAt: number;
}

/** operationName -> most recent capture. Later captures win; they're the freshest hashes. */
const operations = new Map<string, CapturedOperation>();
/** Everything, in order, so a mutation's before/after pair survives for fixtures. */
const timeline: CapturedOperation[] = [];

function summarise(): string {
  const rows = [...operations.values()].sort((a, b) =>
    a.operationName.localeCompare(b.operationName),
  );
  if (rows.length === 0) return '  (nothing captured yet)';
  return rows
    .map((op) => {
      const hash = op.sha256Hash ? op.sha256Hash.slice(0, 16) + '…' : '(no hash — full query sent)';
      return `  ${op.operationName.padEnd(34)} ${hash}`;
    })
    .join('\n');
}

/**
 * The most recent storage state we were able to read.
 *
 * `context.storageState()` fails once the context is closing, and closing the browser
 * window is a documented way to end a capture — so reading it only during shutdown loses
 * the cookie jar exactly when the user did the thing the instructions suggested. Snapshot
 * it while the context is alive and fall back to that.
 */
let lastStorageState: unknown;

/**
 * Response handlers still reading their bodies.
 *
 * `page.on('response')` fires synchronously but `response.json()` is async, so a Ctrl+C
 * timed between the two would serialise the maps while the final mutation — the one the
 * user just performed, and most likely the reason they ran this — was still being parsed.
 */
const pending = new Set<Promise<void>>();

async function recordGraphqlTraffic(context: BrowserContext): Promise<void> {
  context.on('response', (response) => {
    const handled = (async () => {
      const request = response.request();
      if (!isGraphqlUrl(request.url())) return;

      const postData = request.postData();
      if (!postData) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(postData);
      } catch {
        return; // not JSON; not an APQ call we care about
      }

      // A GraphQL POST body may be a single operation or an array (batched).
      const bodies = Array.isArray(parsed) ? parsed : [parsed];

      let responseBody: unknown = null;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = '(unparseable response body)';
      }

      // A batched POST's response is an array in request order. Storing the whole array
      // on every operation attributes each one's data — and its errors — to all of its
      // neighbours, which quietly misleads exactly the fixture-driven debugging this
      // capture exists to support.
      const responseBodies = Array.isArray(responseBody) ? responseBody : null;

      for (const [index, body] of bodies.entries()) {
        if (typeof body !== 'object' || body === null) continue;
        const record = body as Record<string, unknown>;
        const ownResponse = responseBodies === null ? responseBody : responseBodies[index];

        const operationName =
          typeof record['operationName'] === 'string' ? record['operationName'] : '(anonymous)';
        const extensions = record['extensions'] as Record<string, unknown> | undefined;
        const persisted = extensions?.['persistedQuery'] as Record<string, unknown> | undefined;
        const sha256Hash =
          typeof persisted?.['sha256Hash'] === 'string' ? persisted['sha256Hash'] : null;

        const captured: CapturedOperation = {
          operationName,
          sha256Hash,
          hasFullQuery: typeof record['query'] === 'string',
          // Retained so a schema-drift repair has the document to work from.
          ...(typeof record['query'] === 'string' ? { query: record['query'] } : {}),
          variables: record['variables'] ?? null,
          responseStatus: response.status(),
          responseBody: ownResponse,
          capturedAt: Date.now(),
        };

        const isNew = !operations.has(operationName);
        operations.set(operationName, captured);
        timeline.push(captured);

        // Refresh on *every* GraphQL response, not only unfamiliar operations. The
        // request that matters most is usually a repeat: the same list query, retried
        // after logging in. Gating on `isNew` meant the pre-login attempt claimed the
        // operation name and the successful one never refreshed the jar, so closing the
        // browser before the timer saved a pre-login session.
        //
        // Awaited, not fire-and-forget: this call is part of `handled`, which `pending`
        // tracks. A `void`ed refresh could still be in flight after `handled` resolves and
        // leaves `pending`, so `flush` could close the context and read `lastStorageState`
        // before this write ever landed — saving the stale pre-login jar despite having
        // just observed an authenticated request.
        try {
          lastStorageState = await context.storageState();
        } catch {
          // ignore
        }

        const marker = isNew ? 'NEW ' : '    ';
        const errorFlag =
          ownResponse &&
          typeof ownResponse === 'object' &&
          'errors' in (ownResponse as Record<string, unknown>)
            ? '  ⚠ errors in response'
            : '';
        console.log(`${marker}${operationName}${errorFlag}`);
      }
    })();
    pending.add(handled);
    void handled.finally(() => pending.delete(handled));
  });
}

/** The autosave currently in flight, and its timer, so shutdown can settle both. */
let autosave: Promise<void> | undefined;
let autosaveTimer: ReturnType<typeof setInterval> | undefined;

async function flush(context: BrowserContext): Promise<void> {
  // Stop the interval and let any in-flight write finish before this one starts, so the
  // two cannot interleave on the same file.
  if (autosaveTimer !== undefined) clearInterval(autosaveTimer);
  if (autosave !== undefined) await autosave.catch(() => undefined);

  // Let in-flight body reads finish first, or the capture can omit the very last call.
  if (pending.size > 0) {
    console.log(`\nWaiting for ${pending.size} response(s) still being read …`);
    await Promise.allSettled([...pending]);
  }

  await mkdir(CAPTURE_DIR, { recursive: true });

  await writeSecret(resolve(CAPTURE_DIR, 'operations.json'),
    JSON.stringify(Object.fromEntries(operations), null, 2));
  await writeSecret(resolve(CAPTURE_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));

  // Session state spans BOTH hosts — auth lives on accounts.heb.com. Capturing only the
  // storefront looks fine and then fails on renewal.
  let storageState: { cookies: Array<{ domain: string }> };
  try {
    storageState = (await context.storageState()) as typeof storageState;
    lastStorageState = storageState;
  } catch (error) {
    if (lastStorageState === undefined) throw error;
    console.warn('Context already closing; writing the last good storage snapshot.');
    storageState = lastStorageState as typeof storageState;
  }
  storageState = filterHebStorageState(
    storageState as unknown as StorageStateLike,
  ) as unknown as typeof storageState;
  await writeSecret(resolve(CAPTURE_DIR, 'storage-state.json'),
    JSON.stringify(storageState, null, 2));

  const hosts = new Set(storageState.cookies.map((c) => c.domain));
  console.log(`\nWrote ${operations.size} operations (${timeline.length} calls) to captures/`);
  console.log(`Cookie domains captured: ${[...hosts].sort().join(', ')}`);
  console.log('\nOperations seen:\n' + summarise());
  console.log('\n⚠ captures/ holds live cookies. It is gitignored; scrub before committing.');
}

async function main(): Promise<void> {
  const context = await launchBrowser();

  await recordGraphqlTraffic(context);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  // Snapshot immediately, not on the first 15-second tick. Closing the browser is a
  // supported way to end a capture, and doing it before the first tick left `flush` with
  // nothing — so an early close, or a close right after logging in, either failed the run
  // or wrote a pre-login jar.
  lastStorageState = await context.storageState().catch(() => undefined);

  console.log(`
────────────────────────────────────────────────────────────────────────
 HEB list API capture — W0

 A browser window is open. In it, please:

   1. Log in (the profile persists, so this is usually only needed once)
   2. Open your shopping list          -> captures the READ query
   3. Add an item                      -> captures the ADD mutation
   4. Change an item's quantity        -> captures the UPDATE mutation
   5. Remove an item                   -> captures the REMOVE mutation

 If you have more than one list, please also switch between them so I can
 see how list identity is represented.

 Operations appear below as they're captured. Press Ctrl+C when done.
────────────────────────────────────────────────────────────────────────
`);

  let flushing = false;
  const shutdown = async () => {
    if (flushing) return;
    flushing = true;
    let failed = false;
    try {
      await flush(context);
    } catch (error) {
      console.error('Failed while writing captures:', error);
      failed = true;
    } finally {
      await context.close().catch(() => {});
      // A run that produced no usable capture is a failed run: exiting zero would let a
      // script — or a person skimming — treat an unwritable directory as success.
      process.exit(failed ? 1 : 0);
    }
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Closing the browser window should also produce a capture file.
  context.on('close', () => void shutdown());

  // Periodic autosave, so a crash or an accidental window close doesn't lose the session.
  autosaveTimer = setInterval(() => {
    // *Chained*, not merely tracked. Tracking one promise is enough only while writes
    // finish inside the interval: a write slower than 15 seconds gets its reference
    // overwritten by the next tick, so shutdown awaits only the newest one and the older
    // write can land after the final flush — overwriting the complete capture with an
    // earlier snapshot, and losing exactly the last operation, which is usually the one
    // the run was performed to see.
    const previous = autosave ?? Promise.resolve();
    autosave = previous
      .catch(() => undefined)
      .then(() => mkdir(CAPTURE_DIR, { recursive: true }))
      .then(() =>
        writeSecret(resolve(CAPTURE_DIR, 'operations.json'),
          JSON.stringify(Object.fromEntries(operations), null, 2)),
      );
    void autosave.catch(() => undefined);
    // Keep a live snapshot of the cookie jar: it is the expensive thing to reacquire, and
    // it cannot be read once the context starts closing.
    void context
      .storageState()
      .then((state) => {
        lastStorageState = state;
      })
      .catch(() => undefined);
  }, 15_000);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
