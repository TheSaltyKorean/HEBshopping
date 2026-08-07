/**
 * Shared Playwright wiring for the discovery and login tools.
 *
 * The GraphQL parsing itself lives in @heb/core (`capture.ts`) so the refresher can reuse
 * it without depending on Playwright. Besides that plumbing — launch a browser that keeps
 * its login, and pipe its GraphQL traffic into that parser — this is also where the
 * Windows/WSL owner-only checks live, since every tool that writes a live credential
 * (`login.ts`, `capture.ts`, `drive.ts`) needs them.
 */

import { chromium, type BrowserContext } from 'playwright';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { filterHebStorageState, isGraphqlUrl, parseGraphqlPost } from '@heb/core';

/** Owner-only: these files carry live cookies and raw request bodies. */
const SECRET_FILE_MODE = 0o600;

/**
 * Write a file that only its owner can read, even if it already existed.
 *
 * `writeFile`'s `mode` applies only when the file is *created*. Rewriting an existing inode
 * leaves whatever permissions it already had — so a capture restored from elsewhere, or
 * created before this rule existed, keeps a live H-E-B cookie jar world-readable while the
 * code claims otherwise. The chmod is the part that actually holds the guarantee.
 *
 * On Windows it holds nothing: Node maps `chmod` onto the read-only attribute alone, so
 * these files get whatever ACL their directory hands them. The name of this function is a
 * POSIX promise, and saying so here is cheaper than someone trusting it on the wrong
 * platform — see docs/setup.md.
 */
export async function writeSecret(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: SECRET_FILE_MODE });
  await chmod(path, SECRET_FILE_MODE);
}


export const PROFILE_DIR = resolve('.playwright-profile');
export const CAPTURE_DIR = resolve('captures');

/** Owner-only: these directories hold a live, already-authenticated H-E-B session. */
const OWNER_ONLY_DIR_MODE = 0o700;

/**
 * Create a directory, or lock down its permissions if it already exists.
 *
 * `mkdir` only applies a mode on creation, and leaves an existing directory's permissions
 * untouched — same reason `writeSecret` chmods after writing, not just on creation. Default
 * umask would often leave it group/other-readable, so set it explicitly rather than assume;
 * on Windows this is a no-op (see `writeSecret`'s own note).
 */
export async function ensureOwnerOnlyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, OWNER_ONLY_DIR_MODE);
}

/**
 * `icacls` is a Windows tool and only understands Windows-style paths. On WSL, a path here
 * is POSIX-style (e.g. `/mnt/c/repo/.session/session.json`), so translate it via `wslpath`
 * before printing a command meant to run in PowerShell.
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

/** Owner-only mode on POSIX, or `null` when it can't be determined (missing, or stat failed). */
export async function checkOwnerOnly(path: string): Promise<boolean | null> {
  try {
    return ((await stat(path)).mode & 0o077) === 0;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` is the current user's own home directory, or sits inside it — checked with
 * `home` passed in (like `isSessionTrusted` takes `shell`) rather than calling `os.homedir()`
 * internally, so this stays a plain comparison a test can drive without mocking. This is the
 * one case docs/setup.md already calls out as needing no icacls fix at all ("Under your own
 * profile … the inherited ACL is already user-only and there is nothing to do"), so a
 * directory there is safe to write into even when it holds other files this tool doesn't own
 * — `node:fs`'s `mode` can't tell us that on Windows (chmod there only toggles the read-only
 * attribute, so `stat().mode` never reflects the real ACL either way), but this can.
 *
 * `shell` — like `isDedicatedDirectory`'s (login.ts) — decides both the path style to parse
 * `dir`/`home` with and whether the comparison is case-insensitive: `'powershell'`/
 * `'wsl-powershell'` mean both strings are Windows-style (backslash-separated, possibly
 * translated from a WSL path via `windowsPathFor`), so they must be parsed with `path.win32`,
 * not the host's own `path.resolve` — under WSL that's POSIX and would mangle a `C:\...`
 * string instead of recognizing it as absolute. `null` means both are plain POSIX paths on
 * the host's own filesystem.
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
 * Resolves `dir` through any symlinks/junctions to its real on-disk location, so a directory
 * that merely *looks* like it's under the user's home profile — because a junction planted
 * there points somewhere else entirely — isn't mistaken by `isUnderOwnHomeDirectory` for one
 * that genuinely is. `dir` (or a deeper descendant of it a caller may run this against before
 * `mkdir` creates it) may not exist yet, so `realpath` can fail on the full path even though an
 * ancestor — the junction itself — does exist and would still redirect it: walk up to the
 * nearest ancestor `realpath` can resolve and reapply the unresolved tail on top of that,
 * instead of giving up and handing back the lexical path a junction earlier in it could still
 * make misleading. Stops at the root once there's no further ancestor to try.
 */
export async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    return join(await realDir(parent), basename(dir));
  }
}

/**
 * The remediation note for a directory holding a live credential whose owner-only mode
 * couldn't be confirmed — null when `checkOwnerOnly` + `isSessionTrusted` already call it
 * trusted, or when `alreadySafe` (the directory is under the user's own home profile, per
 * `isUnderOwnHomeDirectory` — the same "nothing to do" exemption `login.ts` already applies
 * to the session file and its own custom `--session` parent) already covers it. Generic
 * sibling of login.ts's `untrustedSessionNote`/`untrustedProfileNote` for callers (capture.ts,
 * drive.ts) that have no --session-style custom path, or check "above", to fold into the
 * message — so it only ever reports what was measured, not a generated remediation command.
 */
export function untrustedDirNote(
  dir: string,
  ownerOnly: boolean | null,
  shell: ReturnType<typeof windowsPathFor>['shell'],
  alreadySafe: boolean,
): string | null {
  if (alreadySafe) return null;
  if (ownerOnly !== null && isSessionTrusted(ownerOnly, shell)) return null;
  if (shell === null) {
    if (ownerOnly !== false) return null;
    return (
      `⚠ ${dir} holds a live credential and this filesystem did not enforce the\n` +
      '   owner-only permission. Restrict it manually before trusting it.'
    );
  }
  return (
    `⚠ ${dir} holds a live credential and its owner-only permission could not be\n` +
    '   confirmed on Windows/WSL. See the Windows note above Step 5 in docs/setup.md\n' +
    '   to check and, if needed, restrict it.'
  );
}

/** Checks `dir` and prints `untrustedDirNote`'s remediation, if any. */
export async function warnIfUntrustedDir(dir: string): Promise<void> {
  // Resolved through realDir first: a junction/symlink lexically under the home directory but
  // redirecting elsewhere would otherwise pass isUnderOwnHomeDirectory's plain string comparison
  // even though PROFILE_DIR/CAPTURE_DIR actually land on the junction's (possibly broader) ACL.
  const { path: dirIcaclsPath, shell } = windowsPathFor(await realDir(dir));
  const home = shell === null ? null : homeDirFor(shell);
  const alreadySafe = home !== null && isUnderOwnHomeDirectory(dirIcaclsPath, home, shell);
  const note = untrustedDirNote(dir, await checkOwnerOnly(dir), shell, alreadySafe);
  if (note !== null) console.warn(note);
}

export interface CapturedCall {
  operationName: string;
  sha256Hash: string | null;
  hasFullQuery: boolean;
  /** The document itself, when the client sent one. Captures are gitignored. */
  query?: string;
  variables: unknown;
  responseStatus: number;
  responseBody: unknown;
  capturedAt: number;
}

export interface Capture {
  /** operationName -> most recent call. Later wins; it has the freshest hash. */
  readonly operations: Map<string, CapturedCall>;
  /** Every call in order, so a mutation's before/after pair survives for fixtures. */
  readonly timeline: CapturedCall[];
  /** Calls seen since the last `since()` reset — makes "what did that click do?" answerable. */
  since(): CapturedCall[];
  mark(): void;
  /**
   * Response handlers still reading their bodies.
   *
   * `page.on('response')` fires synchronously but `response.json()` is not, so saving
   * immediately can omit the very last call — typically the mutation the run was
   * investigating, and disproportionately the slow or failing ones.
   */
  readonly pending: ReadonlySet<Promise<void>>;
}

/**
 * Launch a browser that remembers its login.
 *
 * Headed by design: login needs a human (HEB offers passkey and emailed OTP, neither of
 * which can be replayed headlessly), and a stock visible Chromium is also what Imperva
 * expects to see.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  await ensureOwnerOnlyDir(PROFILE_DIR);
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export function attachCapture(context: BrowserContext): Capture {
  const operations = new Map<string, CapturedCall>();
  const timeline: CapturedCall[] = [];
  const pending = new Set<Promise<void>>();
  let markIndex = 0;

  context.on('response', (response) => {
    const handled = (async () => {
      const request = response.request();
      if (!isGraphqlUrl(request.url())) return;

      const postData = request.postData();
      if (!postData) return;

      const parsed = parseGraphqlPost(postData);
      if (parsed.length === 0) return;

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = '(unparseable response body)';
      }

      // A batched POST carries several operations and the response is an array in the
      // same order. Storing the whole array on every call would attribute one operation's
      // data — and its errors — to all of its neighbours, which is exactly the kind of
      // quiet mis-association that sends fixture-driven debugging down a blind alley.
      const bodies = Array.isArray(responseBody) ? responseBody : null;

      for (const [index, operation] of parsed.entries()) {
        const own = bodies === null ? responseBody : bodies[index];
        const call: CapturedCall = {
          ...operation,
          responseStatus: response.status(),
          responseBody: own,
          capturedAt: Date.now(),
        };
        const isNew = !operations.has(operation.operationName);
        operations.set(operation.operationName, call);
        timeline.push(call);

        const errors =
          own && typeof own === 'object' && 'errors' in own ? '  ⚠ errors' : '';
        console.log(`${isNew ? 'NEW ' : '    '}${operation.operationName}${errors}`);
      }
    })();
    pending.add(handled);
    void handled.finally(() => pending.delete(handled));
  });

  return {
    operations,
    timeline,
    pending,
    since: () => timeline.slice(markIndex),
    mark: () => {
      markIndex = timeline.length;
    },
  };
}

/**
 * Persist a capture.
 *
 * Storage state is written first and independently: it is the expensive thing to
 * reacquire (it needs a human login), so it must not be lost to a later failure.
 */
export async function saveCapture(
  context: BrowserContext,
  capture: Capture,
  label = 'capture',
): Promise<void> {
  if (capture.pending.size > 0) {
    console.log(`Waiting for ${capture.pending.size} response(s) still being read …`);
    await Promise.allSettled([...capture.pending]);
  }

  await ensureOwnerOnlyDir(CAPTURE_DIR);

  // `label` reaches here from a raw CLI argument (see `drive.ts`). Without stripping path
  // separators, a label like `../debug` writes `debug-operations.json` and
  // `debug-timeline.json` outside `captures/` — files that hold raw GraphQL variables and
  // response bodies with shopping data and account identifiers, and are only gitignored
  // inside `captures/`.
  label = label.replace(/[\\/]/g, '');

  try {
    const storageState = filterHebStorageState(await context.storageState());
    await writeSecret(resolve(CAPTURE_DIR, 'storage-state.json'),
      JSON.stringify(storageState, null, 2));
    const hosts = [...new Set(storageState.cookies.map((c) => c.domain))].sort();
    console.log(`\nSession saved. Cookie domains: ${hosts.join(', ')}`);
  } catch (error) {
    console.warn('Could not save storage state (browser may already be closing):', error);
  }

  await writeSecret(resolve(CAPTURE_DIR, `${label}-operations.json`),
    JSON.stringify(Object.fromEntries(capture.operations), null, 2));
  await writeSecret(resolve(CAPTURE_DIR, `${label}-timeline.json`),
    JSON.stringify(capture.timeline, null, 2));

  console.log(
    `Wrote ${capture.operations.size} operations (${capture.timeline.length} calls) to captures/${label}-*.json`,
  );
  console.log('⚠ captures/ holds live cookies. Gitignored; scrub before committing.');
}
