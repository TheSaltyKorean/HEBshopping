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

import { chromium, type BrowserContext } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PROFILE_DIR = resolve('.playwright-profile');
const CAPTURE_DIR = resolve('captures');
const START_URL = 'https://www.heb.com/shopping-list';

interface CapturedOperation {
  operationName: string;
  sha256Hash: string | null;
  /** Present only when the client sent the full query text — see the non-strict APQ experiment. */
  hasFullQuery: boolean;
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

async function recordGraphqlTraffic(context: BrowserContext): Promise<void> {
  context.on('response', (response) => {
    void (async () => {
      const request = response.request();
      if (!request.url().includes('/graphql')) return;

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

      for (const body of bodies) {
        if (typeof body !== 'object' || body === null) continue;
        const record = body as Record<string, unknown>;

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
          variables: record['variables'] ?? null,
          responseStatus: response.status(),
          responseBody,
          capturedAt: Date.now(),
        };

        const isNew = !operations.has(operationName);
        operations.set(operationName, captured);
        timeline.push(captured);

        const marker = isNew ? 'NEW ' : '    ';
        const errorFlag =
          responseBody &&
          typeof responseBody === 'object' &&
          'errors' in (responseBody as Record<string, unknown>)
            ? '  ⚠ errors in response'
            : '';
        console.log(`${marker}${operationName}${errorFlag}`);
      }
    })();
  });
}

async function flush(context: BrowserContext): Promise<void> {
  await mkdir(CAPTURE_DIR, { recursive: true });

  await writeFile(
    resolve(CAPTURE_DIR, 'operations.json'),
    JSON.stringify(Object.fromEntries(operations), null, 2),
  );
  await writeFile(resolve(CAPTURE_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));

  // Session state spans BOTH hosts — auth lives on accounts.heb.com. Capturing only the
  // storefront looks fine and then fails on renewal.
  const storageState = await context.storageState();
  await writeFile(
    resolve(CAPTURE_DIR, 'storage-state.json'),
    JSON.stringify(storageState, null, 2),
  );

  const hosts = new Set(storageState.cookies.map((c) => c.domain));
  console.log(`\nWrote ${operations.size} operations (${timeline.length} calls) to captures/`);
  console.log(`Cookie domains captured: ${[...hosts].sort().join(', ')}`);
  console.log('\nOperations seen:\n' + summarise());
  console.log('\n⚠ captures/ holds live cookies. It is gitignored; scrub before committing.');
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    // A stock Chromium fingerprint is what Imperva expects to see; don't get clever.
    args: ['--disable-blink-features=AutomationControlled'],
  });

  await recordGraphqlTraffic(context);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

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
    try {
      await flush(context);
    } catch (error) {
      console.error('Failed while writing captures:', error);
    } finally {
      await context.close().catch(() => {});
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Closing the browser window should also produce a capture file.
  context.on('close', () => void shutdown());

  // Periodic autosave, so a crash or an accidental window close doesn't lose the session.
  setInterval(() => {
    void mkdir(CAPTURE_DIR, { recursive: true }).then(() =>
      writeFile(
        resolve(CAPTURE_DIR, 'operations.json'),
        JSON.stringify(Object.fromEntries(operations), null, 2),
      ),
    );
  }, 15_000);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
