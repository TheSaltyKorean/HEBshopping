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
 * Owner-read/write only.
 *
 * The session file contains live authentication cookies for an account with a saved
 * payment method. Default umask would often make it world-readable, which on a shared or
 * multi-user machine is a real exposure, so the mode is set explicitly rather than assumed.
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
      return JSON.parse(raw) as SessionState;
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
