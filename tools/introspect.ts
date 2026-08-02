/**
 * Schema introspection probe.
 *
 * Writing our own GraphQL queries (viable because APQ is non-strict) requires declaring
 * variable types, e.g. `query GetList($input: ShoppingListInput!)`. The captures give us
 * variable *shapes* but not their *type names*, so either introspection is available and we
 * read them off the schema, or we inline literals into the query text instead.
 *
 *   npx tsx tools/introspect.ts                 # is introspection on? list list-related types
 *   npx tsx tools/introspect.ts TypeName        # dump one type's fields
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEB_GRAPHQL_URL, HEB_ORIGIN, cookieMatchesHost } from '@heb/core';

interface StorageState {
  cookies: Array<{ name: string; value: string; domain: string }>;
}

const state: StorageState = JSON.parse(
  readFileSync(resolve('captures/storage-state.json'), 'utf8'),
);

// Storefront cookies only. Sending the whole jar would hand `accounts.heb.com` identity
// cookies to a different origin, which no browser would do and which discloses the
// identity-session credential for no benefit — this probe only needs www.heb.com.
const cookieHeader = state.cookies
  .filter((cookie) => cookieMatchesHost(cookie, 'www.heb.com'))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

async function graphql(query: string, variables: unknown = {}): Promise<any> {
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
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: text.slice(0, 300) };
  }
}

function describeType(type: any): string {
  if (!type) return '?';
  if (type.kind === 'NON_NULL') return `${describeType(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${describeType(type.ofType)}]`;
  return type.name ?? '?';
}

const typeName = process.argv[2];

if (typeName) {
  const result = await graphql(
    `query D($n: String!) {
      __type(name: $n) {
        name kind
        inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
    }`,
    { n: typeName },
  );
  const t = result?.data?.__type;
  if (!t) {
    console.log(JSON.stringify(result, null, 2).slice(0, 600));
  } else {
    console.log(`${t.kind} ${t.name}`);
    for (const f of t.inputFields ?? t.fields ?? []) {
      console.log(`  ${f.name.padEnd(28)} ${describeType(f.type)}`);
    }
  }
} else {
  const probe = await graphql('{ __schema { queryType { name } mutationType { name } } }');
  if (!probe?.data?.__schema) {
    console.log('❌ Introspection appears DISABLED:');
    console.log(JSON.stringify(probe, null, 2).slice(0, 500));
    console.log('\n→ Fall back to inlining literals into query text.');
    process.exit(0);
  }

  console.log('✅ Introspection ENABLED');
  console.log(`   Query: ${probe.data.__schema.queryType?.name}`);
  console.log(`   Mutation: ${probe.data.__schema.mutationType?.name}\n`);

  // Pull the argument types for exactly the operations we depend on.
  const ops = await graphql(`{
    __schema {
      queryType { fields { name args { name type { kind name ofType { kind name } } } } }
      mutationType { fields { name args { name type { kind name ofType { kind name } } } } }
    }
  }`);

  const wanted = [
    'getShoppingListsV2',
    'getShoppingListV2',
    'addToShoppingListV2',
    'updateShoppingListItem',
    'deleteShoppingListItems',
    'productSearchItems',
  ];

  for (const [label, holder] of [
    ['QUERY', ops?.data?.__schema?.queryType],
    ['MUTATION', ops?.data?.__schema?.mutationType],
  ] as const) {
    for (const field of holder?.fields ?? []) {
      if (!wanted.includes(field.name)) continue;
      const args = field.args
        .map((a: any) => `${a.name}: ${describeType(a.type)}`)
        .join(', ');
      console.log(`${label.padEnd(9)} ${field.name}(${args})`);
    }
  }

  writeFileSync('captures/schema-ops.json', JSON.stringify(ops, null, 2));
  console.log('\nFull operation list written to captures/schema-ops.json');
}
