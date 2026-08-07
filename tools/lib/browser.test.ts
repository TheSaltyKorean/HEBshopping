import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOwnerOnlyDir } from './browser.js';

// Whether this filesystem actually enforces the mode `chmod` requests. False on Windows
// (`chmod` there only toggles the read-only attribute) — see `ensureOwnerOnlyDir`'s own doc
// comment and packages/heb-core/src/store/file-store.test.ts, which checks the same way.
const honorsOwnerOnlyMode = await (async () => {
  try {
    const probeDir = await mkdtemp(join(tmpdir(), 'heb-mode-probe-'));
    try {
      const probePath = join(probeDir, 'probe');
      await writeFile(probePath, 'x', { mode: 0o600 });
      await chmod(probePath, 0o600);
      return ((await stat(probePath)).mode & 0o777) === 0o600;
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
})();

describe('ensureOwnerOnlyDir', () => {
  it.skipIf(!honorsOwnerOnlyMode)('locks a freshly created directory to owner-only', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-browser-dir-'));
    const dir = join(parent, 'nested', 'profile');
    try {
      await ensureOwnerOnlyDir(dir);
      const mode = (await stat(dir)).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(!honorsOwnerOnlyMode)('locks down a directory that already existed with looser permissions', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-browser-dir-'));
    const dir = join(parent, 'profile');
    try {
      await mkdir(dir, { mode: 0o755 });
      await ensureOwnerOnlyDir(dir);
      const mode = (await stat(dir)).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
