/**
 * Copy the local session into DynamoDB, where the deployed Lambda reads it.
 *
 *   npm run push:session                       # uses HEB_SESSION_TABLE
 *   npm run push:session -- --table heb-session --region us-east-1
 *
 * `npm run login` writes to `.session/session.json` on this machine. The Lambda cannot see
 * that file, so this is the bridge — and it is the step people forget after a re-login,
 * producing a skill that says "my HEB login has expired" while the laptop works fine.
 *
 * Uploads a live credential to your AWS account. The table should be encrypted at rest and
 * readable only by the Lambda role; the Terraform in `infra/` does both.
 */

import { resolve } from 'node:path';
import { FileStore, checkSession } from '@heb/core';
import { DynamoDbStore } from '@heb/lambda-api/store';

interface Options {
  table: string;
  region: string | undefined;
  sessionPath: string;
  sessionId: string | undefined;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) {
      console.error(`⛔ ${flag} needs a value.`);
      process.exit(1);
    }
    return next;
  };

  const table = value('--table') ?? process.env['HEB_SESSION_TABLE'];
  if (table === undefined) {
    console.error('⛔ No table. Pass --table <name> or set HEB_SESSION_TABLE.');
    process.exit(1);
  }

  return {
    table,
    region: value('--region') ?? process.env['AWS_REGION'],
    sessionPath: resolve(value('--session') ?? '.session/session.json'),
    sessionId: value('--session-id'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.region !== undefined) process.env['AWS_REGION'] = options.region;

  const local = await new FileStore(options.sessionPath).getSession();
  if (local === null) {
    console.error(`⛔ No session at ${options.sessionPath}. Run \`npm run login\` first.`);
    process.exit(1);
  }

  // Refuse to upload a jar that is already dead. Pushing one produces a skill that fails
  // in a way pointing at AWS rather than at the login, which is a long walk to the wrong
  // conclusion.
  const health = checkSession(local, Date.now());
  if (!health.usable) {
    console.error(`⛔ The local session is not usable (${health.reason ?? 'unknown'}).`);
    console.error('   Run `npm run login` and try again.');
    process.exit(1);
  }

  const remote = new DynamoDbStore({
    tableName: options.table,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });

  await remote.putSession(local);

  // Read back through the same path the Lambda uses. "Put succeeded" is not "the Lambda
  // can read it" — wrong table, wrong region, and IAM problems all look identical until
  // something actually reads.
  const stored = await remote.getSession();
  if (stored === null) {
    console.error('⛔ Wrote the session but could not read it back. Check table and region.');
    process.exit(1);
  }

  const days =
    health.expiresAt === undefined
      ? null
      : Math.round((health.expiresAt - Date.now()) / 86_400_000);

  // Cookie names and expiries only — never a value.
  console.log(`✅ Session in ${options.table} (${stored.cookies.length} cookies).`);
  if (days !== null) console.log(`   Good for about ${days} more day(s).`);
  console.log('   Re-run this after every `npm run login`.');
}

main().catch((error: unknown) => {
  console.error('\n⛔', error instanceof Error ? error.message : error);
  process.exit(1);
});
