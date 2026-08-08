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

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FileStore,
  HebClient,
  HEB_ACCOUNTS_ORIGIN,
  HEB_SESSION_HOSTS,
  checkSession,
  cookieMatchesHost,
  getShoppingListsDocument,
  isHebError,
  type Cookie,
  type SessionState,
  type Store,
} from '@heb/core';
import {
  checkOwnerOnly,
  homeDirFor,
  isSessionTrusted,
  isUnderOwnHomeDirectory,
  launchBrowser,
  PROFILE_DIR,
  realDir,
  windowsPathFor,
} from './lib/browser.js';

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

const quotePowerShell = (path: string): string => `'${path.replace(/'/g, "''")}'`;

/**
 * The `mkdir` + `icacls` lines that lock a directory down for the current user only, so
 * anything written into it afterward inherits a safe ACL. Shared between `untrustedSessionNote`
 * (told to a reader after a write already landed under the old ACL) and the `main()` preflight
 * for a custom `--session` parent (told *before* anything is written) — both need the exact
 * same command, and a second, drifted copy is how a typo in one goes unnoticed in the other.
 */
function lockDirectoryCommand(dirIcaclsPath: string): string {
  return (
    `   mkdir -Force ${quotePowerShell(dirIcaclsPath)}\n` +
    `   icacls ${quotePowerShell(dirIcaclsPath)} /reset\n` +
    `   icacls ${quotePowerShell(dirIcaclsPath)} /inheritance:r /grant:r "\${env:USERDOMAIN}\\\${env:USERNAME}:(OI)(CI)F"\n`
  );
}

/**
 * The remediation note to print for an untrusted session write, or null when there's nothing
 * to add. Pulled out as a pure function — like `windowsPathFor` and `isSessionTrusted` — so
 * this branching is unit-tested rather than only reasoned about by hand: the prior inline
 * version used `else if (!trusted)`, which meant a stat() failure (`ownerOnly === null`) never
 * printed the icacls hint even on Windows/WSL, a real regression a test would have caught.
 *
 * `isDefaultSessionPath` scopes the ".session directory" pointer to readers who are actually
 * using it. A `--session <custom path>` user isn't covered by that directory-wide fix, and a
 * fix applied only to their file wouldn't last anyway — the next login replaces it with a
 * fresh temp file that inherits the *directory's* ACL, not the file's — so `dirIcaclsPath`
 * (the icacls-ready form of that file's parent directory) lets the custom-path case be told
 * to lock the directory instead, the same durable fix the default `.session` path already
 * gets from docs/setup.md.
 *
 * `dedicated` (whether that directory holds nothing but this file, checked by the caller via
 * a directory listing) decides which of two mutually exclusive instructions to give for a
 * custom path: locking a *shared* directory would strip every other account's access to
 * files this tool has no business touching, so that case must be told to relocate to a new
 * directory instead — and, critically, must not also print a fix for the file at its old
 * location, since that location stops existing once the reader moves it.
 *
 * Deliberately silent about PROFILE_DIR: it can sit on a different mount than the session
 * file, so this note asserting it either way (safe or exposed) without checking it would
 * often be wrong. The caller always runs `untrustedProfileNote` separately, regardless of
 * what this function returns.
 */
export function untrustedSessionNote(
  ownerOnly: boolean | null,
  shell: ReturnType<typeof windowsPathFor>['shell'],
  icaclsPath: string,
  isDefaultSessionPath: boolean,
  dirIcaclsPath: string,
  dedicated: boolean,
): string | null {
  if (shell === null) {
    if (ownerOnly !== false) return null;
    return (
      "   This filesystem didn't enforce the owner-only permission, and it isn't a Windows\n" +
      "   filesystem `icacls` can secure either — for example a CIFS, FAT, or other\n" +
      '   permissionless mount. Move the credential to a permission-capable filesystem, or\n' +
      "   restrict that mount's ACLs directly; there is no command this tool can print here."
    );
  }

  const reason =
    ownerOnly === true
      ? "   This filesystem reports the owner-only permission, but a WSL mount of a Windows\n" +
        '   drive can accept that chmod as metadata while the underlying NTFS ACL still\n' +
        "   grants other accounts access — the mode bit alone isn't proof here."
      : ownerOnly === false
      ? "   This filesystem didn't enforce the owner-only permission, so the file is only as\n" +
        "   protected as the OS ACL it inherits — commonly the case on Windows, and on some\n" +
        '   WSL mounts of a Windows drive.'
      : "   This file's permissions could not be verified, so treat it as unprotected until\n" +
        '   you confirm otherwise.';
  const wslSuffix = shell === 'wsl-powershell' ? ' (not this WSL shell)' : '';
  const fileFix =
    `   icacls ${quotePowerShell(icaclsPath)} /reset\n` +
    `   icacls ${quotePowerShell(icaclsPath)} /inheritance:r /grant:r "\${env:USERDOMAIN}\\\${env:USERNAME}:F"\n`;

  if (isDefaultSessionPath) {
    return (
      reason +
      ' Restrict just this file (safe even if its\n' +
      "   directory holds other files you don't want touched), from a Windows PowerShell\n" +
      `   prompt${wslSuffix}:\n` +
      fileFix +
      '   Every login replaces this file (writes a temp file, then renames it over the\n' +
      "   old one), and the replacement inherits the directory's ACL rather than the file\n" +
      '   you just locked — so re-run that command after every login, not just the first.\n' +
      '   For the default .session directory, see the Windows note above Step 5 in\n' +
      '   docs/setup.md instead: locking the directory protects every future login\n' +
      '   automatically.'
    );
  }

  // A per-file fix here would be undone by the very next login (the replacement temp file
  // inherits the directory's ACL, not the file's) before the user ever gets a chance to
  // re-run it — presenting that as the remedy leaves the file briefly exposed on every
  // single login. Lock the directory instead, so future writes inherit safety for free —
  // but only a directory dedicated to this file: unlike the file-level fix above,
  // `/inheritance:r` on a directory removes every inherited ACE and `/grant:r` leaves only
  // the named account, so it strips every other account's access to the directory itself
  // and to files created in it later. Without `/T` it does not touch files already inside
  // it, so a directory with other content in it isn't retroactively protected.
  const cautionary =
    reason +
    ' A fix on just this file would not last — the next\n' +
    "   login replaces it with a fresh temp file that inherits its directory's ACL, not\n" +
    "   the file's. Lock the directory that holds it instead — but only if it's dedicated\n" +
    "   to this file: without `/T` this only strips every other account's access to the\n" +
    "   directory itself and to files created in it later, not to files already inside it,\n" +
    "   so it isn't safe to rely on for a directory anything else depends on.\n";

  // `dirIcaclsPath` is always the file's *existing* parent (it's already writing there), and
  // a directory that isn't dedicated to this file must never be locked directly — nor can a
  // fix for the file at its *old* location be offered, because that location stops existing
  // the moment the reader moves it there. The rerun's own write (temp-file-then-rename inside
  // the new, already-locked directory) picks up the safe ACL on its own, so no separate
  // per-file command is needed once the reader relocates.
  if (!dedicated) {
    return (
      cautionary +
      "   This directory isn't confirmed to be dedicated to this file — it may hold\n" +
      "   other files, or its contents couldn't be listed — so don't lock it: create a\n" +
      "   new, empty,\n" +
      "   dedicated directory of your own choosing and lock that new directory first —\n" +
      '   the same mkdir + icacls /reset + icacls /inheritance:r /grant:r pattern this\n' +
      "   tool uses to lock a dedicated directory, just against its own path — then\n" +
      "   move this file into that new directory, point --session there, and run again;\n" +
      "   locking first means that write inherits the safe ACL from the moment it\n" +
      "   happens, instead of landing under an unlocked directory again, and that same\n" +
      "   write is what secures the file — no separate per-file fix is needed for it."
    );
  }

  return (
    cautionary +
    `   Lock this one now, from a Windows PowerShell prompt${wslSuffix}:\n` +
    lockDirectoryCommand(dirIcaclsPath) +
    "   Windows can't confirm from here whether this file already picked up that ACL\n" +
    '   or still carries whatever it inherited before the directory was locked, so lock\n' +
    '   the file itself too, every time you see this:\n' +
    fileFix
  );
}

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

/**
 * Whether `dir` holds nothing but `expectedEntry` — or doesn't exist yet at all. Gates the
 * custom-`--session` icacls remediation: locking a directory that holds anything else would
 * strip every other account's access to files this tool has no business touching, so that fix
 * must only ever be offered for a directory the session file has entirely to itself. The
 * default `.session` directory relaxes this to any `*.json`/`*.json.tmp` entry, not just
 * `expectedEntry`: `docs/setup.md` already has the reader lock that whole directory down before
 * Step 5, and every file this tool itself would ever write there follows that naming, so a
 * second `--session .session/other.json` file left by an earlier run isn't evidence of sharing
 * with something outside this tool's business — but a genuinely foreign entry (a stray
 * `desktop.ini`, a note someone else left there) still is: locking the directory would strip
 * access to that file too, so it still has to fail the check, the same as in any other
 * directory.
 *
 * A directory that doesn't exist yet — or exists but is empty — is trivially dedicated, since it
 * will be created with nothing else in it; that's what lets the preflight in `main()` call this
 * *before* `store.putSession()` has written anything. Any other read failure (e.g. permission
 * denied) is treated as "not dedicated" — the safer assumption when it can't be verified.
 *
 * `shell` decides whether the default-directory comparison, and the non-default entry-name
 * comparisons below, are case-insensitive: both native Windows (`'powershell'`) and WSL on a
 * Windows drive (`'wsl-powershell'`) normally sit on a case-insensitive filesystem, so
 * `.Session` and `.session` are usually the same directory on disk — deriving this from
 * `process.platform` alone missed the WSL case, since WSL reports `linux` even when
 * `windowsPathFor` has already confirmed it's on a DrvFS mount. Neither the default-directory
 * comparison nor the non-default entry-name comparisons below trust the fold alone, though:
 * `sameDirectoryCaseFolded`/`sameFileCaseFolded` confirm inode identity too, because NTFS/DrvFS
 * can enable per-directory case sensitivity (a real WSL feature) — where `.Session` and
 * `.session`, or `Session.json` and `session.json`, are two distinct directories or files
 * despite sitting on an otherwise "case-insensitive" shell.
 */
export async function isDedicatedDirectory(
  dir: string,
  expectedEntry: string,
  shell: ReturnType<typeof windowsPathFor>['shell'],
): Promise<boolean> {
  const resolvedDir = resolve(dir);
  // Canonicalized to match `dir`, which both callers resolve through `realDir` before passing
  // it here. `DEFAULT_SESSION_PATH` resolves against a `process.cwd()` that keeps whatever
  // junction the repo was reached through, so comparing it lexically against an already-resolved
  // `dir` makes the default directory look foreign and hard-blocks a plain
  // `--session .session/other.json` — in the very directory docs/setup.md says to lock.
  //
  // A failure resolving it (e.g. EACCES — a default directory left behind by a different
  // account) must not abort a check for a `dir` that may have nothing to do with it: caught and
  // treated as "not the default", the same safe-when-unverifiable fallback `readdir(dir)`'s own
  // catch below already uses.
  const resolvedDefaultDir = await realDir(dirname(resolve(DEFAULT_SESSION_PATH))).catch(() => null);
  const caseInsensitive = shell === 'powershell' || shell === 'wsl-powershell';
  const sameAsDefaultDir =
    resolvedDefaultDir !== null &&
    (caseInsensitive
      ? await sameDirectoryCaseFolded(resolvedDir, resolvedDefaultDir)
      : resolvedDir === resolvedDefaultDir);

  // FileStore.putSession writes `<path>.tmp` then renames it onto `<path>` (file-store.ts) —
  // an interrupted write leaves that `.tmp` sibling behind. It's this tool's own leftover,
  // not evidence of a shared directory, so it's allowed alongside the file it belongs to.
  const allowed = new Set([expectedEntry, `${expectedEntry}.tmp`]);
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (allowed.has(entry)) continue;
      // Only in the default directory: every file this tool would ever write there is a
      // *.json session file (or its *.json.tmp write-in-progress sibling), so another one is a
      // previous run's file, not a foreign entry — but something that isn't shaped like a
      // session file at all still has to pass the check below.
      if (sameAsDefaultDir && /\.json(\.tmp)?$/i.test(entry)) continue;
      if (!caseInsensitive || !(await sameFileCaseFolded(dir, entry, allowed))) return false;
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Whether `entry`, exactly as listed on disk, is really the same file as one of `allowed`'s
 * names once case is folded — confirmed by comparing inode identity, not just the folded
 * strings. On an ordinary case-insensitive Windows/DrvFS directory they're always the same
 * file, but a directory with per-directory case sensitivity turned on can hold `Session.json`
 * and `session.json` as two distinct files; trusting the string fold alone there would let a
 * directory that genuinely holds a foreign file pass as dedicated.
 */
async function sameFileCaseFolded(dir: string, entry: string, allowed: Set<string>): Promise<boolean> {
  const lower = entry.toLowerCase();
  const match = [...allowed].find((name) => name.toLowerCase() === lower);
  if (match === undefined) return false;
  try {
    const [a, b] = await Promise.all([stat(join(dir, entry)), stat(join(dir, match))]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Whether `a` and `b` are the same on-disk directory once case is folded — confirmed by
 * comparing inode identity, not just the folded strings, for the same reason
 * `sameFileCaseFolded` doesn't trust a folded filename match alone: per-directory case
 * sensitivity is a property of the *parent*, so a custom `--session .SESSION/other.json` can
 * sit next to, rather than be, the real default `.session` directory. Trusting the fold alone
 * here would extend the default directory's `*.json` exemption — and the "lock it" advice that
 * follows — to a directory that may hold a genuinely unrelated file.
 */
async function sameDirectoryCaseFolded(a: string, b: string): Promise<boolean> {
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  try {
    const [statA, statB] = await Promise.all([stat(a), stat(b)]);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

/**
 * The remediation note for PROFILE_DIR, printed before login starts — pulled out as a pure
 * function, like `untrustedSessionNote`, so this boolean-composed gate on a security-relevant
 * message is unit-tested rather than only reasoned about by hand.
 *
 * `profileAlreadySafe` is PROFILE_DIR's own home-directory exemption (`isUnderOwnHomeDirectory`)
 * — independent of whatever the `--session` file's directory computed, since PROFILE_DIR always
 * lives in the repo and can sit on a different mount than a custom session path. Without it, the
 * simplest, safest setup (everything under the user's own profile, which docs/setup.md already
 * says needs no fix) still printed this warning, because `checkOwnerOnly` alone is never `true`
 * on native Windows.
 */
export function untrustedProfileNote(
  profileOwnerOnly: boolean | null,
  profileShell: ReturnType<typeof windowsPathFor>['shell'],
  profileAlreadySafe: boolean,
): string | null {
  if (profileAlreadySafe) return null;
  if (profileOwnerOnly !== null && isSessionTrusted(profileOwnerOnly, profileShell)) return null;
  // Stands on its own — no back-reference to the session check, which now prints after this.
  const intro = `\n⚠ ${PROFILE_DIR} is a separate live credential (the logged-in browser profile)`;
  // A permissionless mount (CIFS, FAT, ...) with no Windows/WSL shell to run icacls from
  // isn't fixed by the Windows note this otherwise points to — same case `untrustedSessionNote`
  // handles for the session file itself. When the mode couldn't even be verified there either,
  // there's no Windows remediation to point to and nothing more useful to say than the intro.
  if (profileShell === null) {
    if (profileOwnerOnly !== false) return null;
    return (
      intro +
      " and this filesystem didn't enforce the\n" +
      "   owner-only permission, and it isn't a Windows filesystem `icacls` can secure. Move\n" +
      '   the repository, or just that profile, to a permission-capable filesystem, or\n' +
      "   restrict that mount's ACLs directly; there is no command this tool can print here."
    );
  }
  return intro + ' — see the Windows note above Step 5 in\n   docs/setup.md to check and, if needed, restrict it.';
}

/**
 * Empties `dir` without removing the directory itself. Used for `--switch`: removing
 * the directory would drop a Windows ACL locked onto it per the setup docs, and Playwright
 * would recreate it fresh under the parent's (often broader) inherited ACL. Clearing its
 * contents instead keeps that lock in place across a switch.
 *
 * Detaches `dir` with a single `rename()` before doing anything else, rather than checking
 * what it is (`lstat`) and separately reading it (`readdir`): those are two syscalls
 * resolving the same path independently, and another account with write access to the parent
 * could swap `dir` for a symlink/junction in the gap between them, which `readdir` would then
 * follow — recursively deleting the *target's* contents. `rename()` never follows a symlink at
 * its source (same guarantee as `unlink`/`lstat`), so the check and the move happen as one step
 * nothing can land in between. The random suffix means the detached name is one only this call
 * knows, so telling a link from a real directory and clearing it happens on a reference nobody
 * else can race. A second `rename()` puts the original directory object back under `dir`,
 * carrying its original ACL with it since it's the same object throughout — run from a `finally`
 * so a failure partway through clearing (e.g. a locked Chromium `LOCK` file) still restores it,
 * rather than leaving it orphaned under its `.clearing-<hex>` name for the next run to find
 * missing and silently recreate under the parent's broader inherited ACL. If something now
 * occupies `dir`, that rename fails instead of silently overwriting or merging into it.
 *
 * That `finally` covers the identity check (`lstat`) as well as the `readdir`/`rm` pass after
 * it, not just the latter — a transient failure there (e.g. antivirus holding `detached`
 * briefly) is exactly as capable of stranding it. The one path that intentionally leaves
 * `detached` gone — it turned out to be a symlink, and got removed as itself — skips the
 * restore via `restore`, since there is nothing left under that name to put back.
 */
export async function clearDirectoryContents(dir: string): Promise<void> {
  const detached = `${dir}.clearing-${randomBytes(6).toString('hex')}`;
  try {
    await rename(dir, detached);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  let restore = true;
  try {
    if ((await lstat(detached)).isSymbolicLink()) {
      await rm(detached, { force: true });
      restore = false;
      return;
    }

    const entries = await readdir(detached);
    await Promise.all(entries.map((entry) => rm(join(detached, entry), { recursive: true, force: true })));
  } finally {
    if (restore) await rename(detached, dir);
  }
}

/**
 * Whether a `--session` directory needs no icacls fix because it is the user's own home
 * directory (or under it) — the "nothing to do" exemption docs/setup.md already describes for
 * that placement, default `.session` path included. It never applies when `shell === null`
 * (native POSIX, or a WSL mount `windowsPathFor` couldn't translate) — there, a directly measured
 * permission failure is real evidence, not something a location heuristic should override. Pulled
 * out as a pure function, like `isUnderOwnHomeDirectory` itself, so this composition is
 * unit-tested instead of only reachable through `main()`.
 */
export function sessionAlreadySafe(
  shell: ReturnType<typeof windowsPathFor>['shell'],
  dirIcaclsPath: string,
  home: string | null,
): boolean {
  if (shell === null || home === null) return false;
  return isUnderOwnHomeDirectory(dirIcaclsPath, home, shell);
}

/**
 * The decision behind `ensureCustomSessionParentReady`: whether a custom `--session` parent
 * directory needs no action — either not a Windows/WSL path `icacls` can help, or already safe
 * because it's under the user's own home directory (`isUnderOwnHomeDirectory`) — must block the
 * login outright (shared with other files, and not already safe — there's no ACL fix to offer
 * without taking away access that isn't this tool's to take), or just gets a reminder (dedicated,
 * but `stat()` can never confirm from here that it's already locked down). `'lock'` can never
 * turn into a hard block: since Windows/WSL can't verify an ACL fix actually landed, no rerun
 * could ever prove it and clear a block, so blocking here would be a permanent dead end rather
 * than a real gate — unlike `'blocked'`, which the reader can escape by relocating to a
 * directory that genuinely is dedicated. Pulled out as a pure function — the same pattern as
 * `untrustedSessionNote`/`untrustedProfileNote` — so this choice is unit-tested instead of only
 * reachable through `main()`.
 */
export function customSessionParentAction(
  shell: ReturnType<typeof windowsPathFor>['shell'],
  dedicated: boolean,
  alreadySafe: boolean,
): 'skip' | 'blocked' | 'lock' {
  if (shell === null || alreadySafe) return 'skip';
  return dedicated ? 'lock' : 'blocked';
}

/**
 * Checked before login starts, not just after writing. `store.putSession()` persists the
 * credential as soon as a usable session shows up, so a check that only ran afterward — the
 * prior shape of this code — meant the very first write into a shared or unlocked Windows/WSL
 * directory was already exposed by the time the user ever saw an instruction about it.
 *
 * The "dedicated but not confirmed locked" case only warns and lets login continue, rather than
 * blocking: `stat()` can never confirm an ACL fix already ran (see `isSessionTrusted`), so no
 * rerun could ever earn its way past a hard block here — that would just be a permanent dead
 * end, not a real gate. The shared-directory case below can still block, because relocating to
 * a genuinely dedicated directory is a real, checkable way out.
 */
async function ensureCustomSessionParentReady(sessionPath: string): Promise<void> {
  const dir = await realDir(dirname(sessionPath));
  const { path: dirIcaclsPath, shell } = windowsPathFor(dir);
  if (shell === null) return;

  const home = homeDirFor(shell);
  const alreadySafe = home !== null && isUnderOwnHomeDirectory(dirIcaclsPath, home, shell);
  const dedicated = await isDedicatedDirectory(dir, basename(sessionPath), shell);
  const action = customSessionParentAction(shell, dedicated, alreadySafe);
  if (action === 'skip') return;

  if (action === 'blocked') {
    console.error(
      `\n⛔ ${dir} isn't confirmed to be dedicated to this file — it may hold other\n` +
        "   files, or its contents couldn't be listed — so this tool won't write a live\n" +
        "   credential there: locking a directory that turns out to be shared would strip\n" +
        "   access that isn't this tool's to take away. Point\n" +
        '   --session at a new, empty directory of your own choosing, lock that directory\n' +
        '   first (see the Windows note above Step 5 in docs/setup.md for the mkdir + icacls\n' +
        '   commands), then run again.',
    );
    process.exit(1);
  }

  const wslSuffix = shell === 'wsl-powershell' ? ' (not this WSL shell)' : '';
  console.log(
    `\nBefore logging in — ${dir} isn't yet known to be locked down for Windows access\n` +
      "   (stat() can't confirm an ACL fix already ran; see isSessionTrusted). If you haven't\n" +
      `   already, lock it now, from a Windows PowerShell prompt${wslSuffix}:\n` +
      lockDirectoryCommand(dirIcaclsPath) +
      "   Locking it first means this login's write inherits a safe ACL from the moment it\n" +
      '   happens, instead of landing under whatever this directory currently inherits.',
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const isDefaultSessionPath = options.sessionPath === resolve(DEFAULT_SESSION_PATH);

  if (!isDefaultSessionPath) {
    await ensureCustomSessionParentReady(options.sessionPath);
  }

  if (options.switchAccount) {
    console.log(`Forgetting the current account (clearing ${PROFILE_DIR}) …`);
    await clearDirectoryContents(PROFILE_DIR);
  }

  const store = new FileStore(options.sessionPath);

  const context = await launchBrowser();

  // PROFILE_DIR is a second live credential (the logged-in browser profile) that always lives
  // in the repo and can sit on a different, less-trusted mount than the --session path, so it
  // needs its own home-directory exemption check rather than inheriting the session file's
  // verdict. Placed exactly where capture.ts and drive.ts put their `warnIfUntrustedDir`: after
  // `launchBrowser`, because that is the call whose `ensureOwnerOnlyDir` chmods the profile —
  // reading the mode first reports a profile left at 0755 by an earlier release as a
  // permissionless mount, one statement before the chmod that fixes it. Still ahead of
  // `page.goto` and the poll loop, so it lands before the interactive login writes a fresh
  // credential in there.
  // Resolved through realDir first, for the same reason `warnIfUntrustedDir` does it: a junction
  // lexically under the home profile but redirecting elsewhere would otherwise be granted the
  // exemption and silence this warning, while capture.ts/drive.ts still warn about that same
  // directory.
  const profileOwnerOnly = await checkOwnerOnly(PROFILE_DIR);
  const { path: profileIcaclsPath, shell: profileShell } = windowsPathFor(await realDir(PROFILE_DIR));
  const profileHome = profileShell === null ? null : homeDirFor(profileShell);
  const profileAlreadySafe = sessionAlreadySafe(profileShell, profileIcaclsPath, profileHome);
  const profileNote = untrustedProfileNote(profileOwnerOnly, profileShell, profileAlreadySafe);
  if (profileNote !== null) console.log(profileNote);

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

  const hebHosts = HEB_SESSION_HOSTS.map((origin) => new URL(origin).hostname);

  while (Date.now() < deadline) {
    // The persistent profile's jar holds cookies for every site visited in it, not just
    // HEB — checking an emailed OTP in the same window brings the email provider's cookies
    // along. Keep only what authenticates www.heb.com/accounts.heb.com; anything else is a
    // stranger's cookie riding along in the session file and, later, in DynamoDB.
    const cookies = ((await context.cookies()) as Cookie[]).filter((cookie) =>
      hebHosts.some((host) => cookieMatchesHost(cookie, host)),
    );
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
  // Say what actually happened, not what the platform is expected to do. A WSL checkout on
  // a Windows drive reports `linux` but can silently drop the owner-only permission just
  // like Windows does, so check the mode `putSession` actually produced.
  //
  // The credential is already durably written by this point (temp-file-then-rename), so a
  // stat() failure here — e.g. AV briefly locking the freshly-renamed file — must not be
  // reported as a failed login; fall back to the plain success line instead.
  const ownerOnly = await checkOwnerOnly(options.sessionPath);
  // A --session path under the user's own home profile needs no icacls fix at all — the same
  // "nothing to do" exemption docs/setup.md gives that placement generally applies just as
  // much to the default .session path as to a custom one, so it must not be told afterward to
  // lock a directory judged safe moments earlier (the preflight grants the same exemption for
  // custom paths via `sessionAlreadySafe`; the default path skips the preflight entirely, since
  // it can never collide with another file).
  const dir = await realDir(dirname(options.sessionPath));
  // Classified from that canonical `dir`, not the lexical `options.sessionPath`: a WSL path that
  // looks native (no /mnt/... prefix) can still traverse a symlink onto a Windows/DrvFS drive,
  // and windowsPathFor only sees that once the parent has been resolved through realDir first —
  // the same reason the preflight (ensureCustomSessionParentReady) and isDedicatedDirectory both
  // classify off a realDir-resolved directory rather than the raw path.
  const { path: icaclsPath, shell } = windowsPathFor(join(dir, basename(options.sessionPath)));
  const trusted = ownerOnly !== null && isSessionTrusted(ownerOnly, shell);
  const dirIcaclsPath = windowsPathFor(dir).path;
  const home = shell === null ? null : homeDirFor(shell);
  const alreadySafe = sessionAlreadySafe(shell, dirIcaclsPath, home);
  console.log(`\n✅ Session written to ${options.sessionPath}` + (trusted ? ' (mode 0600).' : '.'));
  if (ownerOnly === null) {
    console.log(
      "   Could not verify this file's permissions after writing it (e.g. antivirus briefly\n" +
        '   locking the freshly-renamed file). Treat it as unverified and check manually that\n' +
        "   it isn't readable by other accounts before trusting it.",
    );
  }
  if (!trusted && !alreadySafe) {
    const dedicated =
      isDefaultSessionPath || (await isDedicatedDirectory(dir, basename(options.sessionPath), shell));
    const note = untrustedSessionNote(ownerOnly, shell, icaclsPath, isDefaultSessionPath, dirIcaclsPath, dedicated);
    if (note !== null) console.log(note);
  }
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

// Guarded so the test suite can import the pure helpers above (`isDedicatedDirectory`,
// `untrustedProfileNote`, ...) without launching a real browser and waiting on a human to
// log in.
// Resolved through realpathSync, not just resolve(): Node's loader already resolves
// import.meta.url through any symlink, but process.argv[1] keeps whatever path was typed,
// so a symlinked launcher would otherwise never match and main() would silently not run.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
