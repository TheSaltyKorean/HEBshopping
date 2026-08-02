/**
 * W3: obtain a HEB session and write it to the `Store`.
 *
 *   npm run login              # log in, or top up an existing session
 *   npm run login -- --switch  # forget the current account first, then log in
 *   npm run login -- --session /path/to/session.json
 *
 * This replaces the W0 capture-file dance (`npm run capture` then `tools/verify.ts`):
 * it watches the live cookie jar, waits for the human to finish, and writes straight to
 * the `Store`. Nothing is stored anywhere else.
 *
 * Headed and human-driven by necessity, not preference. HEB offers password, emailed OTP,
 * and passkey; the latter two cannot be replayed headlessly, so a person has to be here.
 * This tool never types a credential — it only watches for the session to become valid.
 *
 * What it writes is a live credential. See the Security section of the README.
 */

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  FileStore,
  HebClient,
  HEB_ACCOUNTS_ORIGIN,
  checkSession,
  cookieMatchesHost,
  getShoppingListsDocument,
  isHebError,
  type Cookie,
  type SessionState,
  type Store,
} from '@heb/core';
import { launchBrowser, PROFILE_DIR } from './lib/browser.js';

const START_URL = 'https://www.heb.com/shopping-list';
const DEFAULT_SESSION_PATH = '.session/session.json';

/** How long to wait for a human. Generous: OTP means checking an email client. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_000;

interface Options {
  switchAccount: boolean;
  sessionPath: string;
}

function parseArgs(argv: string[]): Options {
  const sessionFlag = argv.indexOf('--session');
  let sessionPath = DEFAULT_SESSION_PATH;

  if (sessionFlag !== -1) {
    const value = argv[sessionFlag + 1];
    // `npm run login -- --session --switch` would otherwise write the live cookie jar to a
    // committable file literally named "--switch" in the repo root — and `--switch` is
    // still recognised as an option, so the profile is wiped too. A plausible typo with a
    // credential-shaped consequence.
    if (value === undefined || value.startsWith('-')) {
      console.error('⛔ --session needs a file path, e.g. --session .session/other.json');
      process.exit(1);
    }
    sessionPath = value;
  }

  return { switchAccount: argv.includes('--switch'), sessionPath: resolve(sessionPath) };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Days until a cookie dies, or null for a session cookie. */
function daysUntil(expiresSeconds: number, nowMs: number): number | null {
  if (expiresSeconds === -1) return null;
  return Math.round((expiresSeconds * 1_000 - nowMs) / 86_400_000);
}

/**
 * Report on the session without ever printing a cookie value.
 *
 * Names and expiries are safe and are what a human needs to judge the result; values are
 * the credential itself and must not reach a terminal, a log, or a scrollback buffer.
 */
function describe(session: SessionState): void {
  const now = Date.now();
  const domains = [...new Set(session.cookies.map((cookie) => cookie.domain))].sort();
  console.log(`\n  ${session.cookies.length} cookies across: ${domains.join(', ')}`);

  const health = checkSession(session, now);
  if (health.expiresAt !== undefined) {
    const days = Math.round((health.expiresAt - now) / 86_400_000);
    console.log(`  Usable for about ${days} day(s) — soonest required cookie to expire.`);
  }

  for (const name of ['sat', 'sst', 'reese84']) {
    const cookie = session.cookies.find(
      (candidate) => candidate.name === name && cookieMatchesHost(candidate, 'www.heb.com'),
    );
    if (cookie === undefined) continue;
    const days = daysUntil(cookie.expires, now);
    console.log(`    ${name.padEnd(8)} ${days === null ? 'session cookie' : `${days}d`}`);
  }

  // Storefront cookies are what authenticate a request; accounts.heb.com cookies are what
  // let a renewal skip a full login. Missing ones are a warning, not a failure.
  const accountsHost = new URL(HEB_ACCOUNTS_ORIGIN).hostname;
  const hasAccounts = session.cookies.some((cookie) => cookieMatchesHost(cookie, accountsHost));
  if (!hasAccounts) {
    console.warn(
      `\n  ⚠ No ${accountsHost} cookies captured. The session will work, but the next\n` +
        `    login may be a full one. Visiting the account page before quitting usually fixes it.`,
    );
  }
}

/**
 * Does this cookie jar actually authenticate, right now?
 *
 * Deliberately checked against an in-memory store so nothing is persisted until it is
 * known good — the stored session is the valuable artifact and must not be clobbered by a
 * candidate that turns out to be dead.
 */
async function worksAgainstHeb(candidate: SessionState): Promise<boolean> {
  const memory: Store = {
    getSession: async () => candidate,
    putSession: async () => undefined,
  };
  try {
    const data = await new HebClient({ store: memory }).execute<{
      getShoppingListsV2?: { __typename?: string };
    }>(getShoppingListsDocument());

    // A data envelope is not proof. A refused read returns a different union member with
    // only a `__typename` and no envelope-level error, so accepting any envelope would let
    // stale cookies end the poll and overwrite the stored session — the exact failure this
    // probe exists to prevent.
    return data.getShoppingListsV2?.__typename === 'ShoppingListsWithHeaderPageV2';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.switchAccount) {
    console.log(`Forgetting the current account (removing ${PROFILE_DIR}) …`);
    await rm(PROFILE_DIR, { recursive: true, force: true });
  }

  const store = new FileStore(options.sessionPath);
  const context = await launchBrowser();
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log(`
────────────────────────────────────────────────────────────────────────
 HEB login

 A browser window is open. Log in there if prompted — password, emailed
 OTP, or passkey all work; this tool only watches for the session to
 become valid, and never types a credential for you.

 The profile persists, so you are often already logged in and this
 finishes immediately.

 Waiting for a usable session … (Ctrl+C to abort)
────────────────────────────────────────────────────────────────────────
`);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let session: SessionState | null = null;
  let lastReason = '';

  while (Date.now() < deadline) {
    const cookies = (await context.cookies()) as Cookie[];
    const candidate: SessionState = { cookies, capturedAt: Date.now(), buildId: null };
    const health = checkSession(candidate, Date.now());

    if (health.usable) {
      // Cookie expiry is a client-side claim, not proof. A profile can hold every required
      // cookie, all unexpired, while HEB or Imperva has already invalidated the session
      // server-side — and then this poll would exit instantly, overwrite the stored
      // session with the dead jar, fail verification, and exit. Re-running would repeat
      // that forever, never giving the human a chance to log in.
      //
      // So prove the jar works *before* keeping it, and keep waiting when it does not.
      if (await worksAgainstHeb(candidate)) {
        session = candidate;
        break;
      }
      if (lastReason !== 'stale') {
        console.log('  … cookies look complete but HEB rejects them — please log in again');
        lastReason = 'stale';
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (health.reason !== undefined && health.reason !== lastReason) {
      console.log(`  … ${health.reason}`);
      lastReason = health.reason;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (session === null) {
    console.error('\n⛔ Timed out waiting for a usable session. Nothing was written.');
    await context.close().catch(() => {});
    process.exit(1);
  }

  await store.putSession(session);
  console.log(`\n✅ Session written to ${options.sessionPath} (mode 0600).`);
  describe(session);

  // Writing a session that cannot actually authenticate would be a silent failure that
  // only surfaces later, on a voice command. Prove it works before declaring success.
  console.log('\nVerifying against the live API …');
  try {
    const data = await new HebClient({ store }).execute<{
      getShoppingListsV2: { lists: Array<{ name: string; totalItemCount: number }> };
    }>(getShoppingListsDocument());

    // Names and counts only: list ids identify the account, so they stay out of logs.
    for (const list of data.getShoppingListsV2.lists) {
      console.log(`  ✅ "${list.name}" — ${list.totalItemCount} item(s)`);
    }
    // No restart needed: the client reads the session through the `Store` on every
    // request, and `FileStore` reads from disk each time, so a running MCP server or
    // Lambda picks this up on its next call.
    console.log('\nDone. Running clients pick this up on their next call — no restart needed.');
  } catch (error) {
    if (isHebError(error)) {
      console.error(`\n⛔ Session written but unusable — ${error.code}: ${error.message}`);
    } else {
      console.error('\n⛔ Session written but the verification call failed:', error);
    }
    await context.close().catch(() => {});
    process.exit(1);
  }

  await context.close().catch(() => {});
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
