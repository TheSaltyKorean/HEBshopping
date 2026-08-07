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

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
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

/**
 * `icacls` is a Windows tool and only understands Windows-style paths. On WSL,
 * `options.sessionPath` is POSIX-style (e.g. `/mnt/c/repo/.session/session.json`), so
 * translate it via `wslpath` before printing a command meant to run in PowerShell.
 *
 * `wslpath` succeeds for *any* path, including one on WSL's own native filesystem — there it
 * translates to a `\\wsl.localhost\...` (or the older `\\wsl$\...`) UNC alias rather than a
 * drive letter. That's not a DrvFS/NTFS mount, so it isn't Windows-backed and `icacls`
 * doesn't apply; treat it the same as a `wslpath` failure. Any other UNC path — e.g. a
 * Windows-backed network share mounted through DrvFS — is a real `icacls` target and should
 * be accepted, same as a drive letter.
 *
 * `shell` says where that command has to be run: `'powershell'` on native Windows,
 * `'wsl-powershell'` on WSL when the path actually resolves onto a Windows drive, or `null`
 * on a platform (or WSL path) `icacls` can't help — native Linux/macOS, permissionless mounts
 * like CIFS or FAT, or a WSL-native path — where the caller should not print an `icacls`
 * command at all.
 */
export function windowsPathFor(path: string): { path: string; shell: 'powershell' | 'wsl-powershell' | null } {
  if (process.platform === 'win32') return { path, shell: 'powershell' };
  if (process.platform !== 'linux') return { path, shell: null };
  try {
    const winPath = execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
    if (/^\\\\wsl(\.localhost|\$)\\/i.test(winPath)) return { path, shell: null };
    if (!/^([A-Za-z]:\\|\\\\)/.test(winPath)) return { path, shell: null };
    return { path: winPath, shell: 'wsl-powershell' };
  } catch {
    return { path, shell: null };
  }
}

/**
 * On WSL, `chmod`/`stat` reporting 0600 isn't proof either: a DrvFS mount with the `metadata`
 * option can round-trip that mode bit while the underlying NTFS ACL still grants every account
 * on the machine access, so WSL can never fully trust the mode.
 */
export function isSessionTrusted(ownerOnly: boolean, shell: ReturnType<typeof windowsPathFor>['shell']): boolean {
  return ownerOnly && shell !== 'wsl-powershell';
}

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
    const profileNote = isDefaultSessionPath
      ? `   The same applies to ${PROFILE_DIR} — the logged-in browser profile from this\n` +
        "   same login. It isn't relocated by --session, so moving only this file still\n" +
        '   leaves that credential exposed on the mount.'
      : `   ${PROFILE_DIR} holds a live logged-in browser profile from this same login.\n` +
        "   It isn't relocated by --session, and a custom --session path need not share\n" +
        '   this mount at all — check it separately.';
    return (
      "   This filesystem didn't enforce the owner-only permission, and it isn't a Windows\n" +
      "   filesystem `icacls` can secure either — for example a CIFS, FAT, or other\n" +
      '   permissionless mount. Move the credential to a permission-capable filesystem, or\n' +
      "   restrict that mount's ACLs directly; there is no command this tool can print here.\n" +
      profileNote
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
      "   automatically. The same applies to .playwright-profile — `--switch` only clears\n" +
      "   its contents, not the directory itself, so that lock survives a switch too."
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
  const profileNote =
    `   ${PROFILE_DIR} holds a live logged-in browser profile from this same login.\n` +
    "   It isn't relocated by --session, so it stays exposed under its inherited ACL\n" +
    '   even after you lock this file — see the Windows note above Step 5 in\n' +
    '   docs/setup.md to restrict it too.';
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
      "   write is what secures the file — no separate per-file fix is needed for it.\n" +
      profileNote
    );
  }

  return (
    cautionary +
    `   Lock this one now, from a Windows PowerShell prompt${wslSuffix}:\n` +
    lockDirectoryCommand(dirIcaclsPath) +
    "   Windows can't confirm from here whether this file already picked up that ACL\n" +
    '   or still carries whatever it inherited before the directory was locked, so lock\n' +
    '   the file itself too, every time you see this:\n' +
    fileFix +
    profileNote
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

/** Owner-only mode on POSIX, or `null` when it can't be determined (missing, or stat failed). */
async function checkOwnerOnly(path: string): Promise<boolean | null> {
  try {
    return ((await stat(path)).mode & 0o077) === 0;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` holds nothing but `expectedEntry` (and, when `dir` is the default `.session`
 * directory, the default session file too) — or doesn't exist yet at all. Gates the custom-
 * `--session` icacls remediation: locking a directory that holds anything else would strip
 * every other account's access to files this tool has no business touching, so that fix must
 * only ever be offered for a directory the session file has entirely to itself. The default
 * `.session` directory is the one exception: `docs/setup.md` already has the reader lock it
 * down before Step 5, covering every file this tool writes there, so a custom `--session` path
 * pointed inside it (e.g. `.session/second.json`, alongside the default `session.json`) isn't
 * sharing the directory with a foreign file. A directory that doesn't exist yet — or exists
 * but is empty — is trivially dedicated, since it will be created with nothing else in it;
 * that's what lets the preflight in `main()` call this *before* `store.putSession()` has
 * written anything. Any other read failure (e.g. permission denied) is treated as "not
 * dedicated" — the safer assumption when it can't be verified.
 *
 * `shell` decides whether the default-directory comparison, and the entry-name comparison
 * against `allowed`, are case-insensitive: both native Windows (`'powershell'`) and WSL on a
 * Windows drive (`'wsl-powershell'`) sit on a case-insensitive filesystem, so `.Session` and
 * `.session` are the same directory on disk either way, and a `Session.json` written by one
 * run is the same file a later run names `session.json` — deriving this from `process.platform`
 * alone missed the WSL case, since WSL reports `linux` even when `windowsPathFor` has already
 * confirmed it's on a DrvFS mount.
 */
export async function isDedicatedDirectory(
  dir: string,
  expectedEntry: string,
  shell: ReturnType<typeof windowsPathFor>['shell'],
): Promise<boolean> {
  const allowed = new Set([expectedEntry]);
  const resolvedDir = resolve(dir);
  const resolvedDefaultDir = dirname(resolve(DEFAULT_SESSION_PATH));
  const caseInsensitive = shell === 'powershell' || shell === 'wsl-powershell';
  const sameAsDefaultDir = caseInsensitive
    ? resolvedDir.toLowerCase() === resolvedDefaultDir.toLowerCase()
    : resolvedDir === resolvedDefaultDir;
  if (sameAsDefaultDir) allowed.add(basename(DEFAULT_SESSION_PATH));
  const allowedForComparison = caseInsensitive
    ? new Set([...allowed].map((entry) => entry.toLowerCase()))
    : allowed;
  try {
    const entries = await readdir(dir);
    return entries.every((entry) =>
      allowedForComparison.has(caseInsensitive ? entry.toLowerCase() : entry),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * The remediation note for PROFILE_DIR when a trusted --session path doesn't also vouch for
 * it — pulled out as a pure function, like `untrustedSessionNote`, so this boolean-composed
 * gate on a security-relevant message is unit-tested rather than only reasoned about by hand.
 */
export function untrustedProfileNote(
  profileOwnerOnly: boolean | null,
  profileShell: ReturnType<typeof windowsPathFor>['shell'],
): string | null {
  if (profileOwnerOnly !== null && isSessionTrusted(profileOwnerOnly, profileShell)) return null;
  const intro =
    `\n   ${PROFILE_DIR} is a separate live credential (the logged-in browser profile)\n` +
    "   and wasn't covered by the check above";
  // A permissionless mount (CIFS, FAT, ...) with no Windows/WSL shell to run icacls from
  // isn't fixed by the Windows note this otherwise points to — same case `untrustedSessionNote`
  // handles for the session file itself. When the mode couldn't even be verified there either,
  // there's no Windows remediation to point to and nothing more useful to say than the intro.
  if (profileShell === null) {
    if (profileOwnerOnly !== false) return null;
    return (
      intro +
      " — this filesystem didn't enforce the owner-only\n" +
      "   permission either, and it isn't a Windows filesystem `icacls` can secure. Move\n" +
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
 */
export async function clearDirectoryContents(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
}

/**
 * Whether `dir` is the current user's own home directory, or sits inside it — checked with
 * `home` passed in (like `isSessionTrusted` takes `shell`) rather than calling `os.homedir()`
 * internally, so this stays a plain comparison a test can drive without mocking. This is the
 * one case docs/setup.md already calls out as needing no icacls fix at all ("Under your own
 * profile … the inherited ACL is already user-only and there is nothing to do"), so a custom
 * `--session` directory there is safe to write into even when it holds other files this tool
 * doesn't own — `node:fs`'s `mode` can't tell us that on Windows (chmod there only toggles the
 * read-only attribute, so `stat().mode` never reflects the real ACL either way), but this can.
 *
 * `shell` — like `isDedicatedDirectory`'s — decides both the path style to parse `dir`/`home`
 * with and whether the comparison is case-insensitive: `'powershell'`/`'wsl-powershell'` mean
 * both strings are Windows-style (backslash-separated, possibly translated from a WSL path via
 * `windowsPathFor`), so they must be parsed with `path.win32`, not the host's own `path.resolve`
 * — under WSL that's POSIX and would mangle a `C:\...` string instead of recognizing it as
 * absolute. `null` means both are plain POSIX paths on the host's own filesystem.
 */
export function isUnderOwnHomeDirectory(
  dir: string,
  home: string,
  shell: ReturnType<typeof windowsPathFor>['shell'],
): boolean {
  const { resolve: resolvePath, sep: pathSep } = shell === null ? posix : win32;
  const resolvedHome = resolvePath(home);
  const resolvedDir = resolvePath(dir);
  const [target, base] =
    shell === null ? [resolvedDir, resolvedHome] : [resolvedDir.toLowerCase(), resolvedHome.toLowerCase()];
  return target === base || target.startsWith(base + pathSep);
}

/**
 * The home directory to compare `isUnderOwnHomeDirectory` against, in whatever path style
 * `shell` implies. Native Windows and native POSIX already have `os.homedir()` in the right
 * style. WSL is the odd one out: `os.homedir()` there returns the *Linux* home directory
 * (somewhere under /home), which lives on WSL's own filesystem and has nothing to do with the
 * Windows user profile (`C:\Users\randy`) that docs/setup.md's "nothing to do" exemption is
 * actually about — so ask Windows directly, via `cmd.exe`'s environment, the same way
 * `windowsPathFor` asks it to translate a path. Returns null when that can't be determined, so
 * the caller falls back to "not confirmed safe" instead of guessing.
 */
export function homeDirFor(shell: ReturnType<typeof windowsPathFor>['shell']): string | null {
  if (shell !== 'wsl-powershell') return homedir();
  try {
    return execFileSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether a custom `--session` directory needs no icacls fix because it is the user's own home
 * directory (or under it) — the "nothing to do" exemption docs/setup.md already describes. The
 * exemption is specifically about Windows ACL inheritance, so it never applies to the default
 * `.session` path (which gets its own directory-level fix instead) or when `shell === null`
 * (native POSIX, or a WSL mount `windowsPathFor` couldn't translate) — there, a directly measured
 * permission failure is real evidence, not something a location heuristic should override. Pulled
 * out as a pure function, like `isUnderOwnHomeDirectory` itself, so this composition is
 * unit-tested instead of only reachable through `main()`.
 */
export function sessionAlreadySafe(
  isDefaultSessionPath: boolean,
  shell: ReturnType<typeof windowsPathFor>['shell'],
  dirIcaclsPath: string,
  home: string | null,
): boolean {
  if (isDefaultSessionPath || shell === null || home === null) return false;
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
  const dir = dirname(sessionPath);
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
  const { path: icaclsPath, shell } = windowsPathFor(options.sessionPath);
  const trusted = ownerOnly !== null && isSessionTrusted(ownerOnly, shell);
  // A custom --session path under the user's own home profile needs no icacls fix at all — the
  // same exemption the preflight (`ensureCustomSessionParentReady`) already grants via
  // `sessionAlreadySafe` — so it must not be told afterward to lock a directory that was already
  // judged safe moments earlier.
  const dirIcaclsPath = windowsPathFor(dirname(options.sessionPath)).path;
  const home = isDefaultSessionPath || shell === null ? null : homeDirFor(shell);
  const alreadySafe = sessionAlreadySafe(isDefaultSessionPath, shell, dirIcaclsPath, home);
  console.log(`\n✅ Session written to ${options.sessionPath}` + (trusted ? ' (mode 0600).' : '.'));
  if (ownerOnly === null) {
    console.log(
      "   Could not verify this file's permissions after writing it (e.g. antivirus briefly\n" +
        '   locking the freshly-renamed file). Treat it as unverified and check manually that\n' +
        "   it isn't readable by other accounts before trusting it.",
    );
  }
  if (trusted || alreadySafe) {
    // A trusted (or already-safe) --session path only proves that file's own filesystem is
    // safe. PROFILE_DIR is a second live credential (the logged-in browser profile) that
    // always lives in the repo and can sit on a different, less-trusted mount than a custom
    // session path — so this must not silently vouch for it too.
    const profileOwnerOnly = await checkOwnerOnly(PROFILE_DIR);
    const profileShell = windowsPathFor(PROFILE_DIR).shell;
    const profileNote = untrustedProfileNote(profileOwnerOnly, profileShell);
    if (profileNote !== null) console.log(profileNote);
  } else {
    const dedicated =
      isDefaultSessionPath ||
      (await isDedicatedDirectory(dirname(options.sessionPath), basename(options.sessionPath), shell));
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

// Guarded so the test suite can import the pure helpers above (`windowsPathFor`,
// `isSessionTrusted`) without launching a real browser and waiting on a human to log in.
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
