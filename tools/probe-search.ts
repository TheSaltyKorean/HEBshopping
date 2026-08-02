/**
 * Discover the real signature of `productSearchItems`.
 *
 * The captured request sent eight top-level GraphQL *variables*, but variables are not
 * field arguments — HEB's own query consumed some of them elsewhere. Introspection is
 * disabled, so the validator's error messages are the schema documentation available to
 * us: ask for nothing and it names what is required.
 *
 *   npx tsx tools/probe-search.ts
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HEB_GRAPHQL_URL, HEB_ORIGIN, type Cookie } from '@heb/core';

const raw = JSON.parse(
  await readFile(resolve('captures/storage-state.json'), 'utf8'),
) as { cookies: Cookie[] };

const cookieHeader = raw.cookies
  .filter((c) => c.domain === 'www.heb.com' || c.domain === '.heb.com')
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

async function probe(label: string, query: string): Promise<void> {
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
    body: JSON.stringify({ operationName: 'Probe', query, variables: {} }),
  });

  const text = await response.text();
  console.log(`\n══ ${label} (HTTP ${response.status})`);
  try {
    const parsed = JSON.parse(text) as {
      errors?: Array<{ message: string }>;
      data?: unknown;
    };
    if (parsed.errors) {
      for (const error of parsed.errors.slice(0, 6)) console.log(`   • ${error.message}`);
    } else {
      console.log(`   ✅ ${JSON.stringify(parsed.data).slice(0, 300)}`);
    }
  } catch {
    console.log(`   ${text.slice(0, 200)}`);
  }
}

// 1. No arguments at all — the validator lists whatever is required.
await probe('no args', `query Probe { productSearchItems { __typename } }`);

// 2. Just params — is that the sole required argument?
await probe(
  'params only',
  `query Probe {
    productSearchItems(params: { query: "oat milk", storeId: 269 }) { __typename }
  }`,
);

// 3. Wrong scalar for params, to make the validator name the input type.
await probe(
  'params type reveal',
  `query Probe { productSearchItems(params: 1) { __typename } }`,
);
