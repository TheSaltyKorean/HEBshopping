import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const {
  clearDirectoryContents,
  customSessionParentAction,
  isDedicatedDirectory,
  isSessionTrusted,
  untrustedProfileNote,
  untrustedSessionNote,
  windowsPathFor,
} = await import('./login.js');

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  execFileSyncMock.mockReset();
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

describe('untrustedSessionNote', () => {
  it('has nothing to add when icacls cannot help and the mode is already owner-only or unverified', () => {
    expect(untrustedSessionNote(true, null, '/whatever', true, '/whatever/dir', true)).toBeNull();
    expect(untrustedSessionNote(null, null, '/whatever', true, '/whatever/dir', true)).toBeNull();
  });

  it('warns about the browser profile too when stuck on a permissionless mount', () => {
    const note = untrustedSessionNote(
      false,
      null,
      '/mnt/share/.session/session.json',
      true,
      '/mnt/share/.session',
      true,
    );
    expect(note).toContain('.playwright-profile');
    expect(note).toContain('there is no command this tool can print here');
    expect(note).toContain('exposed on the mount');
  });

  it('does not claim the browser profile shares a custom --session path\'s permissionless mount', () => {
    const note = untrustedSessionNote(false, null, '/mnt/share/creds/foo.json', false, '/mnt/share/creds', true);
    expect(note).toContain('.playwright-profile');
    expect(note).toContain('need not share\n   this mount at all');
    expect(note).not.toContain('exposed on the mount');
  });

  it('still prints the icacls remediation when stat() failed to verify the mode — the prior regression', () => {
    const note = untrustedSessionNote(
      null,
      'powershell',
      'C:\\repo\\.session\\session.json',
      true,
      'C:\\repo\\.session',
      true,
    );
    expect(note).toContain('icacls');
    expect(note).toContain('could not be verified');
  });

  it('flags the WSL metadata caveat when the mode reports owner-only but the mount cannot be trusted', () => {
    const note = untrustedSessionNote(
      true,
      'wsl-powershell',
      'C:\\repo\\.session\\session.json',
      true,
      'C:\\repo\\.session',
      true,
    );
    expect(note).toContain('metadata');
    expect(note).toContain('(not this WSL shell)');
  });

  it('warns plainly on native Windows when the mode was never restricted', () => {
    const note = untrustedSessionNote(
      false,
      'powershell',
      'C:\\repo\\.session\\session.json',
      true,
      'C:\\repo\\.session',
      true,
    );
    expect(note).toContain("didn't enforce the owner-only permission");
    expect(note).not.toContain('(not this WSL shell)');
  });

  it('points to the default .session directory note only when the path actually is the default', () => {
    const atDefault = untrustedSessionNote(
      false,
      'powershell',
      'C:\\repo\\.session\\session.json',
      true,
      'C:\\repo\\.session',
      true,
    );
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds', true);
    expect(atDefault).toContain('the default .session directory');
    expect(atCustom).not.toContain('the default .session directory');
  });

  it('still warns about .playwright-profile on Windows/WSL for a custom --session path', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds', true);
    expect(atCustom).toContain('.playwright-profile');
    expect(atCustom).toContain("isn't relocated by --session");
  });

  it('locks the parent directory for a custom --session path, and does not claim the file fix is a one-time thing', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds', true);
    expect(atCustom).toContain("icacls 'C:\\creds' /inheritance:r /grant:r");
    expect(atCustom).toContain('(OI)(CI)F');
    // Windows mode bits can never confirm the directory-level fix from a prior run already
    // took effect, so the note must not assert this run's write is still under the old ACL.
    expect(atCustom).not.toContain('already wrote the file under the old ACL');
    expect(atCustom).toContain("icacls 'C:\\creds\\foo.json' /reset");
  });

  it('still tells the default .session path to re-run the per-file fix after every login', () => {
    const atDefault = untrustedSessionNote(
      false,
      'powershell',
      'C:\\repo\\.session\\session.json',
      true,
      'C:\\repo\\.session',
      true,
    );
    expect(atDefault).toContain('re-run that command after every login');
  });

  it('locks the directory that already holds the file when it is dedicated to it', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared', true);
    expect(atCustom).not.toContain('safe even if it holds other files');
    expect(atCustom).toContain("strips every other account's access");
    // Without /T the directory-level fix never reaches files already inside it — only the
    // directory itself and what's created afterward — so it must not claim otherwise.
    expect(atCustom).not.toContain('anything already in it');
    expect(atCustom).not.toContain('dedicated directory of your own choosing');
    expect(atCustom).toContain("mkdir -Force 'C:\\shared'");
    expect(atCustom).toContain("icacls 'C:\\shared' /inheritance:r /grant:r");
  });

  it('requires the custom --session parent to be a dedicated directory before locking it', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared', false);
    expect(atCustom).not.toContain('safe even if it holds other files');
    expect(atCustom).toContain("strips every other account's access");
    expect(atCustom).not.toContain('anything already in it');
    expect(atCustom).toContain('dedicated directory of your own choosing');
  });

  it('tells the user to relocate to a directory of their own choosing when this one is not dedicated', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared', false);
    expect(atCustom).toContain('dedicated directory of your own choosing and lock that new directory first');
    expect(atCustom).toContain('move this file into that new directory, point --session there, and run again');
    // dirIcaclsPath is the file's *existing*, non-dedicated parent — it must never be
    // printed as a literal command to lock, since that directory holds other files.
    expect(atCustom).not.toContain("icacls 'C:\\shared' /inheritance:r /grant:r");
  });

  it('locks the new directory before moving the file into it, not after', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared', false);
    const lockFirstIndex = atCustom!.indexOf('lock that new directory first');
    const moveIndex = atCustom!.indexOf('move this file into that new directory');
    expect(lockFirstIndex).toBeGreaterThan(-1);
    expect(moveIndex).toBeGreaterThan(lockFirstIndex);
  });

  it('does not print a stale per-file fix for the old location once the file is meant to move', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared', false);
    // The file at C:\shared\foo.json stops existing once the reader moves it into the new,
    // dedicated directory — a fix command targeting that old path would just fail to find it.
    expect(atCustom).not.toContain("icacls 'C:\\shared\\foo.json'");
    expect(atCustom).not.toContain('already wrote the file under the old ACL');
  });
});

describe('isDedicatedDirectory', () => {
  it('treats a directory that does not exist yet as dedicated — it will be created fresh', async () => {
    const dir = join(tmpdir(), 'heb-dedicated-missing-does-not-exist');
    await expect(isDedicatedDirectory(dir, 'session.json')).resolves.toBe(true);
  });

  it('treats an empty existing directory as dedicated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-empty-'));
    try {
      await expect(isDedicatedDirectory(dir, 'session.json')).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a directory holding only the expected entry as dedicated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-solo-'));
    try {
      await writeFile(join(dir, 'session.json'), '{}');
      await expect(isDedicatedDirectory(dir, 'session.json')).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a directory holding other files as not dedicated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-shared-'));
    try {
      await writeFile(join(dir, 'session.json'), '{}');
      await writeFile(join(dir, 'other.txt'), 'x');
      await expect(isDedicatedDirectory(dir, 'session.json')).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats an unreadable directory as not dedicated, the safer assumption', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(readdir).mockRejectedValueOnce(error);
    await expect(isDedicatedDirectory('/some/dir', 'session.json')).resolves.toBe(false);
  });
});

describe('customSessionParentAction', () => {
  it('skips a path icacls cannot help with, regardless of whether it is dedicated', () => {
    expect(customSessionParentAction(null, true)).toBe('skip');
    expect(customSessionParentAction(null, false)).toBe('skip');
  });

  it('blocks a shared directory on native Windows', () => {
    expect(customSessionParentAction('powershell', false)).toBe('blocked');
  });

  it('blocks a shared directory on WSL', () => {
    expect(customSessionParentAction('wsl-powershell', false)).toBe('blocked');
  });

  it('only reminds about a dedicated directory on native Windows', () => {
    expect(customSessionParentAction('powershell', true)).toBe('reminder');
  });

  it('only reminds about a dedicated directory on WSL', () => {
    expect(customSessionParentAction('wsl-powershell', true)).toBe('reminder');
  });
});

describe('clearDirectoryContents', () => {
  it('removes every entry but keeps the directory itself (and its ACL) in place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-profile-'));
    try {
      await writeFile(join(dir, 'Cookies'), 'data');
      await mkdir(join(dir, 'Default'));
      await writeFile(join(dir, 'Default', 'Preferences'), '{}');

      await clearDirectoryContents(dir);

      await expect(readdir(dir)).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when the directory does not exist yet', async () => {
    const dir = join(tmpdir(), 'heb-profile-missing-does-not-exist');
    await expect(clearDirectoryContents(dir)).resolves.toBeUndefined();
  });

  it('propagates read failures other than "does not exist" instead of treating the directory as empty', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(readdir).mockRejectedValueOnce(error);
    await expect(clearDirectoryContents('/some/profile/dir')).rejects.toThrow('permission denied');
  });
});

describe('untrustedProfileNote', () => {
  it('has nothing to add when the profile mode is trusted', () => {
    expect(untrustedProfileNote(true, 'powershell')).toBeNull();
    expect(untrustedProfileNote(true, null)).toBeNull();
  });

  it('warns when the profile mode could not be verified', () => {
    const note = untrustedProfileNote(null, 'powershell');
    expect(note).toContain('.playwright-profile');
    expect(note).toContain("wasn't covered by the check above");
  });

  it('warns when the profile mode was never restricted', () => {
    expect(untrustedProfileNote(false, 'powershell')).toContain('.playwright-profile');
  });

  it('never trusts the mode bit alone on WSL, even when it reports owner-only', () => {
    expect(untrustedProfileNote(true, 'wsl-powershell')).not.toBeNull();
  });

  it('gives a POSIX remediation instead of the Windows note on a permissionless mount', () => {
    const note = untrustedProfileNote(false, null);
    expect(note).toContain('there is no command this tool can print here');
    expect(note).not.toContain('the Windows note above Step 5');
  });

  it('has nothing to add on native POSIX when the profile mode could not be verified', () => {
    expect(untrustedProfileNote(null, null)).toBeNull();
  });
});
