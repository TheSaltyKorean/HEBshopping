import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat), statfs: vi.fn(actual.statfs) };
});

const {
  checkOwnerOnly,
  ensureOwnerOnlyDir,
  homeDirFor,
  isSessionTrusted,
  isUnderOwnHomeDirectory,
  realDir,
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

  // stat/statfs are mocked rather than driven off a real file so this runs on every platform:
  // the case it describes is a Linux CIFS mount, which no CI host has to hand.
  it('does not trust an owner-only mode a CIFS mount synthesized from its mount options', async () => {
    vi.mocked(stat).mockResolvedValueOnce({ mode: 0o600 } as never);
    vi.mocked(statfs).mockResolvedValueOnce({ type: 0xff534d42 } as never); // CIFS_SUPER_MAGIC
    expect(await checkOwnerOnly('/mnt/share/session.json')).toBe(false);

    vi.mocked(stat).mockResolvedValueOnce({ mode: 0o600 } as never);
    vi.mocked(statfs).mockResolvedValueOnce({ type: 0x01021994 } as never); // tmpfs
    expect(await checkOwnerOnly('/tmp/session.json')).toBe(true);
  });
});

describe('isUnderOwnHomeDirectory', () => {
  it('treats the home directory itself as under the home directory', () => {
    expect(isUnderOwnHomeDirectory('C:\\Users\\randy', 'C:\\Users\\randy', 'powershell')).toBe(true);
  });

  it('treats a subdirectory of home as under the home directory', () => {
    expect(isUnderOwnHomeDirectory('C:\\Users\\randy\\creds', 'C:\\Users\\randy', 'powershell')).toBe(true);
  });

  it('is case-insensitive on native Windows, where a drive letter or name may be typed differently', () => {
    expect(isUnderOwnHomeDirectory('c:\\users\\RANDY\\creds', 'C:\\Users\\randy', 'powershell')).toBe(true);
  });

  it('is case-insensitive on WSL too, comparing the Windows-translated forms of both paths', () => {
    expect(isUnderOwnHomeDirectory('C:\\Users\\randy\\creds', 'c:\\users\\RANDY', 'wsl-powershell')).toBe(true);
  });

  it('rejects a sibling directory that merely shares a prefix', () => {
    expect(isUnderOwnHomeDirectory('C:\\Users\\randy-other', 'C:\\Users\\randy', 'powershell')).toBe(false);
  });

  it('rejects a directory outside the home directory entirely', () => {
    expect(isUnderOwnHomeDirectory('C:\\shared', 'C:\\Users\\randy', 'powershell')).toBe(false);
  });

  it('parses both paths as plain, case-sensitive POSIX paths when icacls cannot help', () => {
    expect(isUnderOwnHomeDirectory('/srv/randy/creds', '/srv/randy', null)).toBe(true);
    expect(isUnderOwnHomeDirectory('/srv/RANDY/creds', '/srv/randy', null)).toBe(false);
  });
});

describe('homeDirFor', () => {
  it('uses os.homedir() directly on native Windows and native POSIX, no shell-out needed', () => {
    expect(homeDirFor('powershell')).toBe(homedir());
    expect(homeDirFor(null)).toBe(homedir());
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('asks cmd.exe for %USERPROFILE% on WSL instead of the Linux home os.homedir() would return', () => {
    execFileSyncMock.mockReturnValue('C:\\Users\\randy\r\n');
    expect(homeDirFor('wsl-powershell')).toBe('C:\\Users\\randy');
    expect(execFileSyncMock).toHaveBeenCalledWith('cmd.exe', ['/c', 'echo %USERPROFILE%'], { encoding: 'utf8' });
  });

  it('returns null when the cmd.exe interop call fails, instead of falling back to the Linux home', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('cmd.exe: command not found');
    });
    expect(homeDirFor('wsl-powershell')).toBeNull();
  });
});

describe('realDir', () => {
  it('resolves an existing directory to its real, canonical path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-realdir-'));
    try {
      expect(await realDir(dir)).toBe(await realpath(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('joins the unresolved name onto the resolved parent, when the directory itself does not exist yet', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'heb-realdir-'));
    try {
      const missing = join(parent, 'does-not-exist');
      expect(await realDir(missing)).toBe(join(await realpath(parent), 'does-not-exist'));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('resolves through a junction even when a not-yet-created directory sits beneath it', async () => {
    const link = join(tmpdir(), 'heb-realdir-link');
    const target = join(tmpdir(), 'heb-realdir-target');
    const missing = join(link, 'new');
    vi.mocked(realpath)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' })) // realpath(missing)
      .mockResolvedValueOnce(target); // realpath(link) — the junction's real target

    expect(await realDir(missing)).toBe(join(target, 'new'));
  });
});

describe('untrustedDirNote', () => {
  it('has nothing to add when the directory mode is trusted', () => {
    expect(untrustedDirNote('captures', true, 'powershell', false)).toBeNull();
    expect(untrustedDirNote('captures', true, null, false)).toBeNull();
  });

  it('warns when the mode could not be verified on Windows/WSL', () => {
    const note = untrustedDirNote('captures', null, 'powershell', false);
    expect(note).toContain('captures');
    expect(note).toContain('the Windows note above Step 5');
  });

  it('warns when the mode was never restricted', () => {
    expect(untrustedDirNote('captures', false, 'powershell', false)).toContain('captures');
  });

  it('never trusts the mode bit alone on WSL, even when it reports owner-only', () => {
    expect(untrustedDirNote('captures', true, 'wsl-powershell', false)).not.toBeNull();
  });

  it('gives a POSIX remediation instead of the Windows note on a permissionless mount', () => {
    const note = untrustedDirNote('captures', false, null, false);
    expect(note).toContain('Restrict it manually');
    expect(note).not.toContain('the Windows note above Step 5');
  });

  it('has nothing to add on native POSIX when the mode could not be verified', () => {
    expect(untrustedDirNote('captures', null, null, false)).toBeNull();
  });

  it('has nothing to add when the directory is under the home directory, regardless of its measured mode', () => {
    expect(untrustedDirNote('captures', false, 'powershell', true)).toBeNull();
    expect(untrustedDirNote('captures', null, 'powershell', true)).toBeNull();
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

  it('does not grant the home-directory exemption when a junction lexically under home redirects elsewhere', async () => {
    setPlatform('win32');
    const dir = join(homedir(), 'heb-fake-linked-profile');
    const target = join(dirname(homedir()), 'heb-fake-junction-target');
    vi.mocked(realpath).mockResolvedValueOnce(target);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfUntrustedDir(dir);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
