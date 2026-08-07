/**
 * Filesystem-backed `Store` for local development and tests.
 *
 * This is the implementation that makes W3–W8 runnable with no AWS account at all. It uses
 * only Node builtins, so `heb-core` stays free of cloud dependencies.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionState, Store } from '../types.js';

/**
 * Owner-read/write only — **on POSIX**.
 *
 * The session file contains live authentication cookies for an account with a saved
 * payment method. Default umask would often make it world-readable, which on a shared or
 * multi-user machine is a real exposure, so the mode is set explicitly rather than assumed.
 *
 * On Windows this constant does nothing. Node maps `chmod` onto the single read-only
 * attribute there and ignores the rest, so the file ends up with whatever ACL it inherits
 * from its directory — and a repo checked out under `C:\` inherits an ACL that grants local
 * `Users` read access. Stated here because silence would read as "protected everywhere":
 * the mitigation is where the file lives, not what this constant says, and docs/setup.md
 * carries the instruction.
 */
const SECRET_FILE_MODE = 0o600;

export class FileStore implements Store {
  constructor(private readonly path: string) {}

  async getSession(): Promise<SessionState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      // Valid JSON is not a valid session. `{}` or `{"cookies": null}` would parse and then
      // throw deep inside `checkSession` when it calls array methods — a generic crash
      // instead of the promised "log in again" path. Structurally invalid reads as absent.
      return isSessionState(parsed) ? parsed : null;
    } catch {
      // A truncated or hand-edited file is indistinguishable from no session as far as
      // callers are concerned: both mean "you need to log in again".
      return null;
    }
  }

  async putSession(session: SessionState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    // Write-then-rename so a crash mid-write can't leave a half-written session behind.
    // Reacquiring one costs a human login, so it is worth protecting properly.
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(session, null, 2), { mode: SECRET_FILE_MODE });
    await chmod(temporaryPath, SECRET_FILE_MODE);
    await rename(temporaryPath, this.path);
  }
}

/**
 * Structural check on a parsed session.
 *
 * Only the fields the rest of the code dereferences. A cookie needs a usable name, value
 * and domain to build a request header, and `expires` must be a number for the staleness
 * comparison — anything else is a jar that would fail later and less clearly.
 */
function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionState>;
  if (!Array.isArray(candidate.cookies)) return false;

  return candidate.cookies.every(
    (cookie) =>
      typeof cookie === 'object' &&
      cookie !== null &&
      typeof cookie.name === 'string' &&
      typeof cookie.value === 'string' &&
      typeof cookie.domain === 'string' &&
      typeof cookie.expires === 'number' &&
      // `path` is load-bearing now that cookies are matched by scope: without it
      // `cookiePathMatches` throws a bare TypeError instead of the login remedy.
      typeof cookie.path === 'string',
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
