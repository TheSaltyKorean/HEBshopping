import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

const { isSessionTrusted, windowsPathFor } = await import('./login.js');

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

  it('falls back to no icacls command when wslpath is unavailable on Linux', () => {
    setPlatform('linux');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('wslpath: command not found');
    });
    expect(windowsPathFor('/home/user/repo/.session/session.json')).toEqual({
      path: '/home/user/repo/.session/session.json',
      shell: null,
    });
  });

  it('leaves other platforms (e.g. macOS) unable to run icacls', () => {
    setPlatform('darwin');
    expect(windowsPathFor('/Users/me/repo/.session/session.json')).toEqual({
      path: '/Users/me/repo/.session/session.json',
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
