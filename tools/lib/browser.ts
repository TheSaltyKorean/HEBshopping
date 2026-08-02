/**
 * Shared Playwright wiring for the discovery and login tools.
 *
 * The GraphQL parsing itself lives in @heb/core (`capture.ts`) so the refresher can reuse
 * it without depending on Playwright. This module is only the plumbing: launch a browser
 * that keeps its login, and pipe its GraphQL traffic into that parser.
 */

import { chromium, type BrowserContext } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isGraphqlUrl, parseGraphqlPost } from '@heb/core';

/** Owner-only: these files carry live cookies and raw request bodies. */
const SECRET_FILE_MODE = 0o600;

export const PROFILE_DIR = resolve('.playwright-profile');
export const CAPTURE_DIR = resolve('captures');

export interface CapturedCall {
  operationName: string;
  sha256Hash: string | null;
  hasFullQuery: boolean;
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
  let markIndex = 0;

  context.on('response', (response) => {
    void (async () => {
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
  });

  return {
    operations,
    timeline,
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
  await mkdir(CAPTURE_DIR, { recursive: true });

  try {
    const storageState = await context.storageState();
    await writeFile(
      resolve(CAPTURE_DIR, 'storage-state.json'),
      JSON.stringify(storageState, null, 2),
      { mode: SECRET_FILE_MODE },
    );
    const hosts = [...new Set(storageState.cookies.map((c) => c.domain))].sort();
    console.log(`\nSession saved. Cookie domains: ${hosts.join(', ')}`);
  } catch (error) {
    console.warn('Could not save storage state (browser may already be closing):', error);
  }

  await writeFile(
    resolve(CAPTURE_DIR, `${label}-operations.json`),
    JSON.stringify(Object.fromEntries(capture.operations), null, 2),
    { mode: SECRET_FILE_MODE },
  );
  await writeFile(
    resolve(CAPTURE_DIR, `${label}-timeline.json`),
    JSON.stringify(capture.timeline, null, 2),
    { mode: SECRET_FILE_MODE },
  );

  console.log(
    `Wrote ${capture.operations.size} operations (${capture.timeline.length} calls) to captures/${label}-*.json`,
  );
  console.log('⚠ captures/ holds live cookies. Gitignored; scrub before committing.');
}
