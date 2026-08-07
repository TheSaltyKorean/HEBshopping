import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

const {
  checkOwnerOnly,
  ensureOwnerOnlyDir,
  isSessionTrusted,
  untrustedDirNote,
  warnIfUntrustedDir,
  windowsPathFor,
} = await import('./browser.js');

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  execFileSyncMock.mockReset();
});

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

describe('windowsPathFor', () => {
  it('targets native Windows directly, no translation needed', () => {
    setPlatform('win32');
    expect(windowsPathFor('C:\\repo\\.session\\session.json')).toEqual({
      path: 'C:\\repo\\.session\\session.json',
      shell: 'powershell',
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('translates a WSL path via wslpath when it succeeds', () => {
    setPlatform('linux');
    execFileSyncMock.mockReturnValue('C:\\repo\\.session\\session.json\r\n');
    expect(windowsPathFor('/mnt/c/repo/.session/session.json')).toEqual({
      path: 'C:\\repo\\.session\\session.json',
      shell: 'wsl-powershell',
    });
    expect(execFileSyncMock).toHaveBeenCalledWith('wslpath', ['-w', '/mnt/c/repo/.session/session.json'], {
      encoding: 'utf8',
    });
  });

  it('treats a wslpath translation onto its own WSL-native filesystem as not Windows-backed', () => {
    setPlatform('linux');
    execFileSyncMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\path\\to\\HEBshopping\\.session\\session.json\r\n');
    expect(windowsPathFor('/path/to/HEBshopping/.session/session.json')).toEqual({
      path: '/path/to/HEBshopping/.session/session.json',
      shell: null,
    });
  });

  it('treats the older \\\\wsl$\\ alias the same as \\\\wsl.localhost\\', () => {
    setPlatform('linux');
    execFileSyncMock.mockReturnValue('\\\\wsl$\\Ubuntu\\path\\to\\HEBshopping\\.session\\session.json\r\n');
    expect(windowsPathFor('/path/to/HEBshopping/.session/session.json')).toEqual({
      path: '/path/to/HEBshopping/.session/session.json',
      shell: null,
    });
  });

  it('accepts a Windows-backed UNC translation, e.g. a network share mounted through DrvFS', () => {
    setPlatform('linux');
    execFileSyncMock.mockReturnValue('\\\\server\\share\\repo\\.session\\session.json\r\n');
    expect(windowsPathFor('/mnt/z/repo/.session/session.json')).toEqual({
      path: '\\\\server\\share\\repo\\.session\\session.json',
      shell: 'wsl-powershell',
    });
  });

  it('falls back to no icacls command when wslpath is unavailable on Linux', () => {
    setPlatform('linux');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('wslpath: command not found');
    });
    expect(windowsPathFor('/path/to/HEBshopping/.session/session.json')).toEqual({
      path: '/path/to/HEBshopping/.session/session.json',
      shell: null,
    });
  });

  it('leaves other platforms (e.g. macOS) unable to run icacls', () => {
    setPlatform('darwin');
    expect(windowsPathFor('/path/to/HEBshopping/.session/session.json')).toEqual({
      path: '/path/to/HEBshopping/.session/session.json',
      shell: null,
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('isSessionTrusted', () => {
  it('trusts an owner-only mode enforced by a real OS ACL', () => {
    expect(isSessionTrusted(true, 'powershell')).toBe(true);
    expect(isSessionTrusted(true, null)).toBe(true);
  });

  it('never trusts the mode bit alone on WSL, even when it reports owner-only', () => {
    expect(isSessionTrusted(true, 'wsl-powershell')).toBe(false);
  });

  it('does not trust a file whose mode was never restricted', () => {
    expect(isSessionTrusted(false, 'powershell')).toBe(false);
    expect(isSessionTrusted(false, 'wsl-powershell')).toBe(false);
    expect(isSessionTrusted(false, null)).toBe(false);
  });
});

describe('checkOwnerOnly', () => {
  it.skipIf(!honorsOwnerOnlyMode)('is true for a path actually restricted to its owner', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-check-owner-'));
    const target = join(parent, 'file');
    try {
      await writeFile(target, 'x', { mode: 0o600 });
      await chmod(target, 0o600);
      expect(await checkOwnerOnly(target)).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(!honorsOwnerOnlyMode)('is false for a path that is not owner-only', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-check-owner-'));
    const target = join(parent, 'file');
    try {
      await writeFile(target, 'x', { mode: 0o644 });
      expect(await checkOwnerOnly(target)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('is null for a path that does not exist', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-check-owner-'));
    try {
      expect(await checkOwnerOnly(join(parent, 'nope'))).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('untrustedDirNote', () => {
  it('has nothing to add when the directory mode is trusted', () => {
    expect(untrustedDirNote('captures', true, 'powershell')).toBeNull();
    expect(untrustedDirNote('captures', true, null)).toBeNull();
  });

  it('warns when the mode could not be verified on Windows/WSL', () => {
    const note = untrustedDirNote('captures', null, 'powershell');
    expect(note).toContain('captures');
    expect(note).toContain('the Windows note above Step 5');
  });

  it('warns when the mode was never restricted', () => {
    expect(untrustedDirNote('captures', false, 'powershell')).toContain('captures');
  });

  it('never trusts the mode bit alone on WSL, even when it reports owner-only', () => {
    expect(untrustedDirNote('captures', true, 'wsl-powershell')).not.toBeNull();
  });

  it('gives a POSIX remediation instead of the Windows note on a permissionless mount', () => {
    const note = untrustedDirNote('captures', false, null);
    expect(note).toContain('Restrict it manually');
    expect(note).not.toContain('the Windows note above Step 5');
  });

  it('has nothing to add on native POSIX when the mode could not be verified', () => {
    expect(untrustedDirNote('captures', null, null)).toBeNull();
  });
});

describe('warnIfUntrustedDir', () => {
  it.skipIf(!honorsOwnerOnlyMode)('does not warn about a directory that is verifiably owner-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-untrusted-dir-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await chmod(dir, 0o700);
      await warnIfUntrustedDir(dir);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!honorsOwnerOnlyMode)('warns about a directory whose owner-only mode was never restricted', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-untrusted-dir-'));
    const dir = join(parent, 'loose');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mkdir(dir, { mode: 0o755 });
      await warnIfUntrustedDir(dir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(dir);
    } finally {
      warn.mockRestore();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
