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

/**
 * Seconds between probes, validated before anything is scheduled.
 *
 * `Number('')`, `Number('abc')` and a negative argument all yield values Node schedules as
 * a ~1ms timer, and `tick()` is detached — so a CLI typo would launch unbounded
 * overlapping authenticated requests at HEB and quite plausibly earn an Imperva block.
 * The floor is generous because this measures session longevity over hours, not load.
 */
const MIN_INTERVAL_SECONDS = 10;

/** No probe may outlive this; see the note in `probe`. */
const PROBE_TIMEOUT_MS = 20_000;

const INTERVAL_SECONDS = Number(process.argv[2] ?? 120);
if (!Number.isFinite(INTERVAL_SECONDS) || INTERVAL_SECONDS < MIN_INTERVAL_SECONDS) {
  console.error(
    `⛔ Interval must be a number of seconds >= ${MIN_INTERVAL_SECONDS}. ` +
      `Got: ${JSON.stringify(process.argv[2])}`,
  );
  process.exit(1);
}
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
    // Bounded: an unbounded probe would hang the loop rather than record a failure, and a
    // soak that stops reporting looks identical to a soak that is going fine.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const response = await fetch(HEB_GRAPHQL_URL, {
      signal: controller.signal,
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
    clearTimeout(timer);
    if (response.status !== 200) return `FAIL http=${response.status}`;
    if (text.toLowerCase().includes('pardon our interruption')) return 'FAIL imperva-challenge';

    // Parse rather than substring-match. An expired session returns
    // `{"data":{"getShoppingListsV2":null},"errors":[…]}` — which *contains* the field
    // name, so a substring check reports OK and the whole longevity experiment keeps
    // recording successes long after authentication stopped working. That would be a
    // measurement saying the opposite of the truth, which is worse than no measurement.
    let envelope: {
      data?: { getShoppingListsV2?: { __typename?: string } | null };
      errors?: Array<{ message?: string }>;
    };
    try {
      envelope = JSON.parse(text) as typeof envelope;
    } catch {
      return `FAIL non-json=${text.slice(0, 80).replace(/\s+/g, ' ')}`;
    }

    if (envelope.errors?.length) {
      return `FAIL graphql=${(envelope.errors[0]?.message ?? 'unknown').slice(0, 80)}`;
    }
    // Non-null is not success. A rejected session comes back as a *different* union
    // member carrying only a __typename and no errors, so accepting any object would let
    // the soak record OK indefinitely after authentication failed — a longevity
    // measurement asserting the opposite of the truth.
    const typename = (envelope.data?.getShoppingListsV2 as { __typename?: string } | null)
      ?.__typename;
    if (typename !== 'ShoppingListsWithHeaderPageV2') {
      return `FAIL rejected=${typename ?? 'null'}`;
    }
    return 'OK';
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return aborted
      ? `FAIL timeout after ${PROBE_TIMEOUT_MS}ms`
      : `FAIL error=${error instanceof Error ? error.message : String(error)}`;
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
/**
 * Self-scheduling rather than `setInterval`.
 *
 * A detached interval starts a new authenticated request every tick regardless of whether
 * the previous one finished. If a probe stalls — which is exactly what a soak is watching
 * for — pending requests pile up without bound and hammer HEB precisely when it is already
 * unhappy. Waiting for each probe also makes the recorded cadence honest.
 */
async function loop(): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_SECONDS * 1_000));
    await tick();
  }
}

void loop();
