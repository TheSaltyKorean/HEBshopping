/**
 * End-to-end check of the real client against the real API.
 *
 * Unit tests prove the client behaves correctly against fixtures; only this proves the
 * fixtures resemble HEB.
 *
 *   npm run verify:session
 *
 * Read-only in both senses: it lists rather than mutates, and it reads the stored session
 * rather than writing one. Obtaining a session is `npm run login`'s job, and only its job —
 * this tool used to re-seed from a W0 capture, which would now clobber a fresh login.
 */

import { resolve } from 'node:path';
import { FileStore, HebClient, getShoppingListsDocument, checkSession, isHebError } from '@heb/core';

const SESSION_PATH = resolve('.session/session.json');

async function main(): Promise<void> {
  console.log(`Reading ${SESSION_PATH} …`);
  const session = await new FileStore(SESSION_PATH).getSession();

  if (session === null) {
    console.error('\n⛔ No session stored. Run `npm run login` first.');
    process.exit(1);
  }

  const hosts = [...new Set(session.cookies.map((c) => c.domain))].sort();
  console.log(`  ${session.cookies.length} cookies across: ${hosts.join(', ')}`);

  const health = checkSession(session, Date.now());
  console.log(
    `  session usable: ${health.usable}${health.reason ? ` (${health.reason})` : ''}` +
      (health.expiresAt ? `, expires ${new Date(health.expiresAt).toISOString()}` : ''),
  );
  if (!health.usable) {
    console.error('\n⛔ Session unusable. Run `npm run login` and log in again.');
    process.exit(1);
  }

  const store = new FileStore(SESSION_PATH);
  const client = new HebClient({ store });

  console.log('\nCalling getShoppingListsV2 through HebClient …');
  const started = Date.now();

  try {
    const data = await client.execute<{
      getShoppingListsV2?: {
        __typename?: string;
        lists?: Array<{ id: string; name: string; totalItemCount: number }>;
      } | null;
    }>(getShoppingListsDocument());

    const elapsed = Date.now() - started;

    // Almost every H-E-B return type is a union, and a server-side rejection comes back as a
    // *different member* with no `lists` field at all — cookies that pass the local expiry
    // check can still be refused. Dereferencing `.lists` there threw a TypeError and printed
    // "Unexpected", which defeats the one job this command has: telling the operator to run
    // `npm run login`.
    const payload = data.getShoppingListsV2;
    const lists = payload?.lists;
    if (!Array.isArray(lists)) {
      console.error(
        `\n⛔ H-E-B did not return a list page (${payload?.__typename ?? 'no payload'}).\n` +
          '   The cookies are present and unexpired locally but the server refused them.\n' +
          '   Run `npm run login` and log in again.',
      );
      process.exit(1);
    }

    console.log(`✅ ${elapsed}ms — ${lists.length} list(s)`);
    for (const list of lists) {
      // Names and counts only: list ids identify the account, so they stay out of logs.
      console.log(`   "${list.name}" — ${list.totalItemCount} item(s)`);
    }

    // The latency budget (plan §3.2) allows ~3s per HEB call.
    console.log(
      elapsed <= 3_000
        ? `\n   Within the 3s per-call budget.`
        : `\n   ⚠ ${elapsed}ms exceeds the 3s per-call budget — revisit §3.2.`,
    );
  } catch (error) {
    if (isHebError(error)) {
      console.error(`\n⛔ ${error.code}: ${error.message}`);
      if (error.details) console.error(`   ${JSON.stringify(error.details)}`);
    } else {
      console.error('\n⛔ Unexpected:', error);
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
