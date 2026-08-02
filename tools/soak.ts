/**
 * Session soak test.
 *
 * The OSS reference project claims HEB's `reese84` bot token "expires every ~11 minutes".
 * But the captured cookie carries a 30-day TTL, and a plain HTTP call works right now.
 * Those two facts cannot both be the whole story.
 *
 * The distinction matters enormously: if a captured session keeps working for hours, the
 * 10-minute Playwright refresh cycle — and the container Lambda, ECR image, and hash
 * self-healing subsystem built around it — is unnecessary.
 *
 * This settles it empirically rather than by argument. It calls a real authenticated
 * query on an interval and records exactly when (or whether) it starts failing.
 *
 *   npx tsx tools/soak.ts [intervalSeconds]
 *
 * Append-only log at captures/soak.log so a crash doesn't lose the history.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEB_GRAPHQL_URL, HEB_ORIGIN } from '@heb/core';

const INTERVAL_SECONDS = Number(process.argv[2] ?? 120);
const LOG_PATH = resolve('captures/soak.log');
const LIST_QUERY_HASH = '35da893a3476a098d44f8d6ac379db3129117b977d4df4dcbe48a5641eb9fdd5';

interface StorageState {
  cookies: Array<{ name: string; value: string; domain: string }>;
}

const state: StorageState = JSON.parse(
  readFileSync(resolve('captures/storage-state.json'), 'utf8'),
);

const cookieHeader = state.cookies
  .filter((c) => 'www.heb.com'.endsWith(c.domain.replace(/^\./, '')) || c.domain === 'www.heb.com')
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

const startedAt = Date.now();

async function probe(): Promise<string> {
  try {
    const response = await fetch(HEB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        Origin: HEB_ORIGIN,
        Referer: `${HEB_ORIGIN}/shopping-list`,
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        operationName: 'getShoppingListsV2',
        variables: {},
        extensions: { persistedQuery: { version: 1, sha256Hash: LIST_QUERY_HASH } },
      }),
    });

    const text = await response.text();
    if (response.status !== 200) return `FAIL http=${response.status}`;
    if (text.toLowerCase().includes('pardon our interruption')) return 'FAIL imperva-challenge';
    if (text.includes('"getShoppingListsV2"')) return 'OK';
    return `FAIL unexpected=${text.slice(0, 120).replace(/\s+/g, ' ')}`;
  } catch (error) {
    return `FAIL error=${error instanceof Error ? error.message : String(error)}`;
  }
}

async function tick(): Promise<void> {
  const result = await probe();
  const elapsedMinutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  const line = `${new Date().toISOString()}  +${elapsedMinutes}m  ${result}`;
  console.log(line);
  appendFileSync(LOG_PATH, line + '\n');
}

console.log(
  `Soaking every ${INTERVAL_SECONDS}s. If this stays OK past ~15 minutes, the "~11 minute\n` +
    `expiry" claim does not apply to a cookie-only HTTP client, and the refresher can be\n` +
    `radically simplified. Logging to captures/soak.log — Ctrl+C to stop.\n`,
);

await tick();
setInterval(() => void tick(), INTERVAL_SECONDS * 1_000);
