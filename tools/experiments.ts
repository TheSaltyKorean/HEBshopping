/**
 * W0 experiments. Each one can delete or invalidate a whole subsystem, so they run before
 * any of the real code gets written.
 *
 *   npx tsx tools/experiments.ts
 *
 * Requires captures/storage-state.json from `npm run capture` or `tools/drive.ts`.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { HEB_GRAPHQL_URL, HEB_ORIGIN } from '@heb/core';

interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
  }>;
}

const state: StorageState = JSON.parse(
  readFileSync(resolve('captures/storage-state.json'), 'utf8'),
);

/** Cookies a request to www.heb.com would send, per normal domain-matching rules. */
function cookieHeaderFor(host: string): string {
  return state.cookies
    .filter((c) => host === c.domain || host.endsWith(c.domain.replace(/^\./, '.')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Content-Type': 'application/json',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: HEB_ORIGIN,
  Referer: `${HEB_ORIGIN}/shopping-list`,
};

async function graphql(body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(HEB_GRAPHQL_URL, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, Cookie: cookieHeaderFor('www.heb.com') },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: (await response.text()).slice(0, 400) };
}

// ---------------------------------------------------------------------------

async function experimentHeadlessHttp(): Promise<void> {
  console.log('\n══ EXPERIMENT 1 — can a plain HTTP client use the captured cookies? ══');
  console.log('   This is the load-bearing assumption of the whole fast-Lambda design.');
  console.log('   If Imperva rejects non-browser clients, the architecture needs rethinking.\n');

  const result = await graphql({
    operationName: 'getShoppingListsV2',
    variables: {},
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '35da893a3476a098d44f8d6ac379db3129117b977d4df4dcbe48a5641eb9fdd5',
      },
    },
  });

  console.log(`   HTTP ${result.status}`);
  console.log(`   ${result.text.replace(/\n/g, ' ').slice(0, 300)}`);

  // This experiment's answer is load-bearing for the whole architecture, so it must not
  // rest on a substring. A rejected session returns
  // {"data":{"getShoppingListsV2":null},"errors":[…]} — which *contains* the field name,
  // and would have printed the definitive "cookies alone are enough" for a dead jar.
  let succeeded = false;
  try {
    const envelope = JSON.parse(result.text) as {
      data?: { getShoppingListsV2?: { __typename?: string } | null };
      errors?: unknown[];
    };
    succeeded =
      !envelope.errors?.length &&
      envelope.data?.getShoppingListsV2?.__typename === 'ShoppingListsWithHeaderPageV2';
  } catch {
    succeeded = false;
  }

  if (result.status === 200 && succeeded) {
    console.log('\n   ✅ YES — cookies alone are enough. The browser-free request path works.');
  } else if (result.text.toLowerCase().includes('pardon our interruption')) {
    console.log('\n   ❌ NO — Imperva blocked it. The request path cannot be browser-free.');
  } else {
    console.log('\n   ⚠  Inconclusive — inspect the body above.');
  }
}

async function experimentNonStrictApq(): Promise<void> {
  console.log('\n══ EXPERIMENT 2 — is APQ non-strict (does it accept arbitrary queries)? ══');
  console.log('   If yes, hash rot self-heals instantly with no browser involved.\n');

  const query = 'query ProbeTypename { __typename }';
  const sha256Hash = createHash('sha256').update(query).digest('hex');

  const result = await graphql({
    operationName: 'ProbeTypename',
    query,
    variables: {},
    extensions: { persistedQuery: { version: 1, sha256Hash } },
  });

  console.log(`   HTTP ${result.status}`);
  console.log(`   ${result.text.replace(/\n/g, ' ').slice(0, 300)}`);

  if (result.text.includes('PersistedQueryNotFound')) {
    console.log('\n   ❌ NO — safelisted. Hash relearning must come from browser capture.');
  } else if (result.text.includes('__typename') || result.text.includes('"data"')) {
    console.log('\n   ✅ YES — arbitrary queries accepted. Self-heal can be browser-free.');
  } else {
    console.log('\n   ⚠  Inconclusive — inspect the body above.');
  }
}

function experimentOidcSession(): void {
  console.log('\n══ EXPERIMENT 3 — is the identity session renewable without a browser? ══');
  console.log('   Looking for long-lived refresh material on accounts.heb.com.\n');

  const now = Date.now() / 1000;
  const interesting = state.cookies
    .filter((c) => c.domain.includes('heb.com'))
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));

  console.log('   name                              domain                   expires in');
  console.log('   ' + '-'.repeat(74));
  for (const cookie of interesting) {
    const ttl =
      cookie.expires === -1
        ? 'session'
        : cookie.expires < now
          ? 'EXPIRED'
          : `${((cookie.expires - now) / 3600).toFixed(1)}h`;
    console.log(
      `   ${cookie.name.slice(0, 33).padEnd(34)}${cookie.domain.padEnd(25)}${ttl}`,
    );
  }

  const longLived = interesting.filter(
    (c) => c.expires > 0 && (c.expires - now) / 86400 > 7,
  );
  console.log(
    `\n   ${longLived.length} cookie(s) live longer than 7 days: ${
      longLived.map((c) => c.name).join(', ') || '(none)'
    }`,
  );
  console.log('   Long-lived + httpOnly on accounts.heb.com would suggest a refresh path.');
}

async function main(): Promise<void> {
  console.log(`Loaded ${state.cookies.length} cookies from captures/storage-state.json`);
  await experimentHeadlessHttp();
  await experimentNonStrictApq();
  experimentOidcSession();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
