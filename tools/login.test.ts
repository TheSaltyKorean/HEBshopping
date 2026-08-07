import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

const { clearDirectoryContents, isSessionTrusted, untrustedProfileNote, untrustedSessionNote, windowsPathFor } =
  await import('./login.js');

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
    expect(untrustedSessionNote(true, null, '/whatever', true, '/whatever/dir')).toBeNull();
    expect(untrustedSessionNote(null, null, '/whatever', true, '/whatever/dir')).toBeNull();
  });

  it('warns about the browser profile too when stuck on a permissionless mount', () => {
    const note = untrustedSessionNote(false, null, '/mnt/share/.session/session.json', true, '/mnt/share/.session');
    expect(note).toContain('.playwright-profile');
    expect(note).toContain('there is no command this tool can print here');
  });

  it('still prints the icacls remediation when stat() failed to verify the mode — the prior regression', () => {
    const note = untrustedSessionNote(null, 'powershell', 'C:\\repo\\.session\\session.json', true, 'C:\\repo\\.session');
    expect(note).toContain('icacls');
    expect(note).toContain('could not be verified');
  });

  it('flags the WSL metadata caveat when the mode reports owner-only but the mount cannot be trusted', () => {
    const note = untrustedSessionNote(true, 'wsl-powershell', 'C:\\repo\\.session\\session.json', true, 'C:\\repo\\.session');
    expect(note).toContain('metadata');
    expect(note).toContain('(not this WSL shell)');
  });

  it('warns plainly on native Windows when the mode was never restricted', () => {
    const note = untrustedSessionNote(false, 'powershell', 'C:\\repo\\.session\\session.json', true, 'C:\\repo\\.session');
    expect(note).toContain("didn't enforce the owner-only permission");
    expect(note).not.toContain('(not this WSL shell)');
  });

  it('points to the default .session directory note only when the path actually is the default', () => {
    const atDefault = untrustedSessionNote(false, 'powershell', 'C:\\repo\\.session\\session.json', true, 'C:\\repo\\.session');
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds');
    expect(atDefault).toContain('the default .session directory');
    expect(atCustom).not.toContain('the default .session directory');
  });

  it('still warns about .playwright-profile on Windows/WSL for a custom --session path', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds');
    expect(atCustom).toContain('.playwright-profile');
    expect(atCustom).toContain("isn't relocated by --session");
  });

  it('requires locking the parent directory for a custom --session path, not a recurring per-file fix', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds');
    expect(atCustom).toContain("icacls 'C:\\creds' /inheritance:r /grant:r");
    expect(atCustom).toContain('(OI)(CI)F');
    expect(atCustom).not.toContain('re-run that command after every login');
    // The file this run already wrote still needs its own one-time fix.
    expect(atCustom).toContain("icacls 'C:\\creds\\foo.json' /reset");
  });

  it('still tells the default .session path to re-run the per-file fix after every login', () => {
    const atDefault = untrustedSessionNote(false, 'powershell', 'C:\\repo\\.session\\session.json', true, 'C:\\repo\\.session');
    expect(atDefault).toContain('re-run that command after every login');
  });

  it('requires the custom --session parent to be a dedicated directory before locking it', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared');
    expect(atCustom).not.toContain('safe even if it holds other files');
    expect(atCustom).toContain("strips every other account's access");
    expect(atCustom).toContain('create a new,\n   dedicated directory and lock it down first');
  });

  it('locks the new dedicated directory before telling the user to move the file in and rerun', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\shared\\foo.json', false, 'C:\\shared');
    const lockIndex = atCustom!.indexOf('lock it down first');
    const moveIndex = atCustom!.indexOf('move this file into it and point --session there');
    expect(lockIndex).toBeGreaterThan(-1);
    expect(moveIndex).toBeGreaterThan(lockIndex);
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
