/**
 * Shared Playwright wiring for the discovery and login tools.
 *
 * The GraphQL parsing itself lives in @heb/core (`capture.ts`) so the refresher can reuse
 * it without depending on Playwright. This module is only the plumbing: launch a browser
 * that keeps its login, and pipe its GraphQL traffic into that parser.
 */

import { chromium, type BrowserContext } from 'playwright';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filterHebStorageState, isGraphqlUrl, parseGraphqlPost } from '@heb/core';

/** Owner-only: these files carry live cookies and raw request bodies. */
const SECRET_FILE_MODE = 0o600;

/**
 * Write a file that only its owner can read, even if it already existed.
 *
 * `writeFile`'s `mode` applies only when the file is *created*. Rewriting an existing inode
 * leaves whatever permissions it already had — so a capture restored from elsewhere, or
 * created before this rule existed, keeps a live H-E-B cookie jar world-readable while the
 * code claims otherwise. The chmod is the part that actually holds the guarantee.
 */
export async function writeSecret(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: SECRET_FILE_MODE });
  await chmod(path, SECRET_FILE_MODE);
}


export const PROFILE_DIR = resolve('.playwright-profile');
export const CAPTURE_DIR = resolve('captures');

export interface CapturedCall {
  operationName: string;
  sha256Hash: string | null;
  hasFullQuery: boolean;
  /** The document itself, when the client sent one. Captures are gitignored. */
  query?: string;
  variables: unknown;
  responseStatus: number;
  responseBody: unknown;
  capturedAt: number;
}

export interface Capture {
  /** operationName -> most recent call. Later wins; it has the freshest hash. */
  readonly operations: Map<string, CapturedCall>;
  /** Every call in order, so a mutation's before/after pair survives for fixtures. */
  readonly timeline: CapturedCall[];
  /** Calls seen since the last `since()` reset — makes "what did that click do?" answerable. */
  since(): CapturedCall[];
  mark(): void;
  /**
   * Response handlers still reading their bodies.
   *
   * `page.on('response')` fires synchronously but `response.json()` is not, so saving
   * immediately can omit the very last call — typically the mutation the run was
   * investigating, and disproportionately the slow or failing ones.
   */
  readonly pending: ReadonlySet<Promise<void>>;
}

/**
 * Launch a browser that remembers its login.
 *
 * Headed by design: login needs a human (HEB offers passkey and emailed OTP, neither of
 * which can be replayed headlessly), and a stock visible Chromium is also what Imperva
 * expects to see.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export function attachCapture(context: BrowserContext): Capture {
  const operations = new Map<string, CapturedCall>();
  const timeline: CapturedCall[] = [];
  const pending = new Set<Promise<void>>();
  let markIndex = 0;

  context.on('response', (response) => {
    const handled = (async () => {
      const request = response.request();
      if (!isGraphqlUrl(request.url())) return;

      const postData = request.postData();
      if (!postData) return;

      const parsed = parseGraphqlPost(postData);
      if (parsed.length === 0) return;

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = '(unparseable response body)';
      }

      // A batched POST carries several operations and the response is an array in the
      // same order. Storing the whole array on every call would attribute one operation's
      // data — and its errors — to all of its neighbours, which is exactly the kind of
      // quiet mis-association that sends fixture-driven debugging down a blind alley.
      const bodies = Array.isArray(responseBody) ? responseBody : null;

      for (const [index, operation] of parsed.entries()) {
        const own = bodies === null ? responseBody : bodies[index];
        const call: CapturedCall = {
          ...operation,
          responseStatus: response.status(),
          responseBody: own,
          capturedAt: Date.now(),
        };
        const isNew = !operations.has(operation.operationName);
        operations.set(operation.operationName, call);
        timeline.push(call);

        const errors =
          own && typeof own === 'object' && 'errors' in own ? '  ⚠ errors' : '';
        console.log(`${isNew ? 'NEW ' : '    '}${operation.operationName}${errors}`);
      }
    })();
    pending.add(handled);
    void handled.finally(() => pending.delete(handled));
  });

  return {
    operations,
    timeline,
    pending,
    since: () => timeline.slice(markIndex),
    mark: () => {
      markIndex = timeline.length;
    },
  };
}

/**
 * Persist a capture.
 *
 * Storage state is written first and independently: it is the expensive thing to
 * reacquire (it needs a human login), so it must not be lost to a later failure.
 */
export async function saveCapture(
  context: BrowserContext,
  capture: Capture,
  label = 'capture',
): Promise<void> {
  if (capture.pending.size > 0) {
    console.log(`Waiting for ${capture.pending.size} response(s) still being read …`);
    await Promise.allSettled([...capture.pending]);
  }

  await mkdir(CAPTURE_DIR, { recursive: true });

  // `label` reaches here from a raw CLI argument (see `drive.ts`). Without stripping path
  // separators, a label like `../debug` writes `debug-operations.json` and
  // `debug-timeline.json` outside `captures/` — files that hold raw GraphQL variables and
  // response bodies with shopping data and account identifiers, and are only gitignored
  // inside `captures/`.
  label = label.replace(/[\\/]/g, '');

  try {
    const storageState = filterHebStorageState(await context.storageState());
    await writeSecret(resolve(CAPTURE_DIR, 'storage-state.json'),
      JSON.stringify(storageState, null, 2));
    const hosts = [...new Set(storageState.cookies.map((c) => c.domain))].sort();
    console.log(`\nSession saved. Cookie domains: ${hosts.join(', ')}`);
  } catch (error) {
    console.warn('Could not save storage state (browser may already be closing):', error);
  }

  await writeSecret(resolve(CAPTURE_DIR, `${label}-operations.json`),
    JSON.stringify(Object.fromEntries(capture.operations), null, 2));
  await writeSecret(resolve(CAPTURE_DIR, `${label}-timeline.json`),
    JSON.stringify(capture.timeline, null, 2));

  console.log(
    `Wrote ${capture.operations.size} operations (${capture.timeline.length} calls) to captures/${label}-*.json`,
  );
  console.log('⚠ captures/ holds live cookies. Gitignored; scrub before committing.');
}
