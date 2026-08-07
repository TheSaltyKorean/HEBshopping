import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat),
  };
});

const {
  clearDirectoryContents,
  customSessionParentAction,
  isDedicatedDirectory,
  sessionAlreadySafe,
  untrustedProfileNote,
  untrustedSessionNote,
} = await import('./login.js');

describe('untrustedSessionNote', () => {
  it('has nothing to add when icacls cannot help and the mode is already owner-only or unverified', () => {
    expect(untrustedSessionNote(true, null, '/whatever', true, '/whatever/dir', true)).toBeNull();
    expect(untrustedSessionNote(null, null, '/whatever', true, '/whatever/dir', true)).toBeNull();
  });

  it('gives a POSIX remediation with no command to run when stuck on a permissionless mount, and never mentions the browser profile', () => {
    const atDefault = untrustedSessionNote(
      false,
      null,
      '/mnt/share/.session/session.json',
      true,
      '/mnt/share/.session',
      true,
    );
    const atCustom = untrustedSessionNote(false, null, '/mnt/share/creds/foo.json', false, '/mnt/share/creds', true);
    for (const note of [atDefault, atCustom]) {
      expect(note).toContain('there is no command this tool can print here');
      // PROFILE_DIR is checked independently by the caller (untrustedProfileNote) — this note
      // must not assert anything about it either way, since it can sit on a different mount.
      expect(note).not.toContain('.playwright-profile');
    }
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

  it('never mentions the browser profile — the caller checks it independently via untrustedProfileNote', () => {
    const atCustom = untrustedSessionNote(false, 'powershell', 'C:\\creds\\foo.json', false, 'C:\\creds', true);
    expect(atCustom).not.toContain('.playwright-profile');
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
    // `dedicated: false` also covers an unreadable directory (e.g. EACCES), not just one
    // that genuinely holds other files — the message must not assert the wrong one as fact.
    expect(atCustom).not.toContain('This directory holds other files');
    expect(atCustom).toContain("isn't confirmed to be dedicated to this file");
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
    await expect(isDedicatedDirectory(dir, 'session.json', null)).resolves.toBe(true);
  });

  it('treats an empty existing directory as dedicated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-empty-'));
    try {
      await expect(isDedicatedDirectory(dir, 'session.json', null)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a directory holding only the expected entry as dedicated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-solo-'));
    try {
      await writeFile(join(dir, 'session.json'), '{}');
      await expect(isDedicatedDirectory(dir, 'session.json', null)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a directory holding other files as not dedicated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-shared-'));
    try {
      await writeFile(join(dir, 'session.json'), '{}');
      await writeFile(join(dir, 'other.txt'), 'x');
      await expect(isDedicatedDirectory(dir, 'session.json', null)).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats an unreadable directory as not dedicated, the safer assumption', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(readdir).mockRejectedValueOnce(error);
    await expect(isDedicatedDirectory('/some/dir', 'session.json', null)).resolves.toBe(false);
  });

  it('treats the default .session directory as dedicated to a second session file too', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['session.json'] as never);
    await expect(isDedicatedDirectory(resolve('.session'), 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('still rejects a directory holding an unrelated file, even if it is the default .session directory', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['session.json', 'other.txt'] as never);
    await expect(isDedicatedDirectory(resolve('.session'), 'second.json', 'powershell')).resolves.toBe(false);
  });

  it('recognizes the default .session directory case-insensitively on native Windows', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['session.json'] as never);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('recognizes the default .session directory case-insensitively on WSL over a Windows drive', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['session.json'] as never);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', 'wsl-powershell')).resolves.toBe(true);
  });

  it('does not case-fold the default-directory comparison on native POSIX', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['session.json'] as never);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', null)).resolves.toBe(false);
  });

  it('recognizes an existing entry that only differs in case on a case-insensitive filesystem', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['Session.json'] as never);
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 1, ino: 111 } as never) // Session.json
      .mockResolvedValueOnce({ dev: 1, ino: 111 } as never); // session.json — same file
    await expect(isDedicatedDirectory('/some/dir', 'session.json', 'powershell')).resolves.toBe(true);
  });

  it('does not conflate two distinct files that only differ in case, e.g. a directory with per-directory case sensitivity enabled', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['Session.json'] as never);
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 1, ino: 111 } as never) // Session.json
      .mockResolvedValueOnce({ dev: 1, ino: 222 } as never); // session.json — a different file
    await expect(isDedicatedDirectory('/some/dir', 'session.json', 'powershell')).resolves.toBe(false);
  });

  it('still recognizes a differently-cased entry as the same file when it genuinely is one, via inode identity', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['Session.json'] as never);
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 1, ino: 111 } as never)
      .mockResolvedValueOnce({ dev: 1, ino: 111 } as never);
    await expect(isDedicatedDirectory('/some/dir', 'session.json', 'powershell')).resolves.toBe(true);
  });

  it('does not case-fold entry names on native POSIX', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-case-posix-'));
    try {
      await writeFile(join(dir, 'Session.json'), '{}');
      await expect(isDedicatedDirectory(dir, 'session.json', null)).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not extend the default-session exception to an unrelated directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-not-default-'));
    try {
      await writeFile(join(dir, 'session.json'), '{}');
      await expect(isDedicatedDirectory(dir, 'second.json', null)).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a stray .tmp left by an interrupted write to the expected entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heb-dedicated-tmp-'));
    try {
      await writeFile(join(dir, 'session.json'), '{}');
      await writeFile(join(dir, 'session.json.tmp'), '{}');
      await expect(isDedicatedDirectory(dir, 'session.json', null)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a stray session.json.tmp in the default .session directory when checking a second file', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['session.json.tmp', 'second.json'] as never);
    await expect(isDedicatedDirectory(resolve('.session'), 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('still recognizes the default .session directory when the repo is reached through a junction', async () => {
    // Both callers pass a realDir-resolved `dir`, while DEFAULT_SESSION_PATH resolves against a
    // cwd that still holds the junction. Comparing those lexically made the default directory
    // look foreign, so `--session .session/other.json` was blocked outright. Every other
    // default-directory case here passes a lexical path, which is why none of them caught it.
    const realSessionDir = resolve('/real-target/HEBshopping/.session');
    vi.mocked(realpath).mockResolvedValueOnce(realSessionDir as never);
    vi.mocked(readdir).mockResolvedValueOnce(['session.json'] as never);
    await expect(isDedicatedDirectory(realSessionDir, 'second.json', 'powershell')).resolves.toBe(true);
  });
});

describe('customSessionParentAction', () => {
  it('skips a path icacls cannot help with, regardless of whether it is dedicated', () => {
    expect(customSessionParentAction(null, true, false)).toBe('skip');
    expect(customSessionParentAction(null, false, false)).toBe('skip');
  });

  it('skips an already-safe directory even if shared with other files', () => {
    expect(customSessionParentAction('powershell', false, true)).toBe('skip');
    expect(customSessionParentAction('wsl-powershell', false, true)).toBe('skip');
  });

  it('blocks a shared directory that is not already safe, on native Windows', () => {
    expect(customSessionParentAction('powershell', false, false)).toBe('blocked');
  });

  it('blocks a shared directory that is not already safe, on WSL', () => {
    expect(customSessionParentAction('wsl-powershell', false, false)).toBe('blocked');
  });

  it('requires locking a dedicated, not-already-safe directory on native Windows', () => {
    expect(customSessionParentAction('powershell', true, false)).toBe('lock');
  });

  it('requires locking a dedicated, not-already-safe directory on WSL', () => {
    expect(customSessionParentAction('wsl-powershell', true, false)).toBe('lock');
  });
});

describe('sessionAlreadySafe', () => {
  it('is safe for a custom directory under the home directory on native Windows', () => {
    expect(sessionAlreadySafe('powershell', 'C:\\Users\\randy\\creds', 'C:\\Users\\randy')).toBe(true);
  });

  it('is safe for a custom directory under the home directory on WSL', () => {
    expect(sessionAlreadySafe('wsl-powershell', 'C:\\Users\\randy\\creds', 'C:\\Users\\randy')).toBe(true);
  });

  it('is not safe for a custom directory outside the home directory', () => {
    expect(sessionAlreadySafe('powershell', 'C:\\shared', 'C:\\Users\\randy')).toBe(false);
  });

  it('is safe for the default .session path too, when it sits under home — docs/setup.md makes no distinction', () => {
    expect(sessionAlreadySafe('powershell', 'C:\\Users\\randy\\.session', 'C:\\Users\\randy')).toBe(true);
  });

  it('is never safe when icacls cannot help (native POSIX), even under the home directory — a directly measured permission failure must still warn', () => {
    expect(sessionAlreadySafe(null, '/srv/randy/creds', '/srv/randy')).toBe(false);
  });

  it('is not safe when the home directory could not be determined', () => {
    expect(sessionAlreadySafe('wsl-powershell', 'C:\\Users\\randy\\creds', null)).toBe(false);
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
    expect(untrustedProfileNote(true, 'powershell', false)).toBeNull();
    expect(untrustedProfileNote(true, null, false)).toBeNull();
  });

  it('warns when the profile mode could not be verified', () => {
    const note = untrustedProfileNote(null, 'powershell', false);
    expect(note).toContain('.playwright-profile');
    expect(note).toContain("wasn't covered by the check above");
  });

  it('warns when the profile mode was never restricted', () => {
    expect(untrustedProfileNote(false, 'powershell', false)).toContain('.playwright-profile');
  });

  it('never trusts the mode bit alone on WSL, even when it reports owner-only', () => {
    expect(untrustedProfileNote(true, 'wsl-powershell', false)).not.toBeNull();
  });

  it('gives a POSIX remediation instead of the Windows note on a permissionless mount', () => {
    const note = untrustedProfileNote(false, null, false);
    expect(note).toContain('there is no command this tool can print here');
    expect(note).not.toContain('the Windows note above Step 5');
  });

  it('has nothing to add on native POSIX when the profile mode could not be verified', () => {
    expect(untrustedProfileNote(null, null, false)).toBeNull();
  });

  it('has nothing to add when the profile directory is under the home directory, regardless of its measured mode', () => {
    expect(untrustedProfileNote(false, 'powershell', true)).toBeNull();
    expect(untrustedProfileNote(null, 'powershell', true)).toBeNull();
  });
});
