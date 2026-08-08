import { describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
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

  it('treats the default .session directory as dedicated when it holds other session-like files', async () => {
    // A previous `--session .session/work.json` run left work.json (and session.json from a
    // plain `npm run login`) behind. docs/setup.md already has the reader lock the whole
    // directory down before Step 5, and every file this tool itself would ever write there is
    // a *.json (or *.json.tmp) session file, so another one isn't evidence of sharing with
    // something outside this tool's business.
    //
    // `stat` is mocked to confirm identity (same dev/ino) since `dir` and the default directory
    // are the exact same path here — the case-fold pre-check alone would already say "same",
    // but the identity check runs regardless and must not spuriously fail it.
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 1, ino: 42 } as never)
      .mockResolvedValueOnce({ dev: 1, ino: 42 } as never);
    vi.mocked(readdir).mockResolvedValueOnce(['session.json', 'work.json'] as never);
    await expect(isDedicatedDirectory(resolve('.session'), 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('does not extend the default-.session exemption to a genuinely foreign file', async () => {
    // Locking the directory — the advice `ensureCustomSessionParentReady` gives once this
    // returns true — strips every other account's access to everything in it, which is only
    // safe when everything in it is this tool's own. A file that isn't shaped like a session
    // file at all is evidence it might not be, so it must still fail the check like it would
    // in any other directory, not be waved through by an unconditional default-directory pass.
    vi.mocked(readdir).mockResolvedValueOnce(['session.json', 'desktop.ini'] as never);
    await expect(isDedicatedDirectory(resolve('.session'), 'second.json', 'powershell')).resolves.toBe(false);
  });

  it('recognizes the default .session directory case-insensitively on native Windows', async () => {
    vi.mocked(readdir).mockResolvedValueOnce([]);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('recognizes the default .session directory case-insensitively on WSL over a Windows drive', async () => {
    vi.mocked(readdir).mockResolvedValueOnce([]);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', 'wsl-powershell')).resolves.toBe(true);
  });

  it('recognizes a differently-cased default .session directory as the same one, via inode identity', async () => {
    const defaultDir = resolve('.session');
    vi.mocked(realpath).mockResolvedValueOnce(defaultDir as never);
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 4, ino: 44 } as never) // resolvedDir (.SESSION)
      .mockResolvedValueOnce({ dev: 4, ino: 44 } as never); // resolvedDefaultDir (.session) — same directory
    // A non-expected `.json` entry so the assertion can only pass via the default-directory
    // relaxation, which is what actually consults the identity-verified comparison.
    vi.mocked(readdir).mockResolvedValueOnce(['work.json'] as never);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('does not conflate a differently-cased directory with the default one when per-directory case sensitivity makes them distinct', async () => {
    // Per-directory case sensitivity is a property of the *parent*, so `.SESSION` and `.session`
    // can be two separate directories despite an otherwise case-insensitive shell — the same
    // real feature `sameFileCaseFolded`'s tests below cover for file entries, one level up.
    const defaultDir = resolve('.session');
    vi.mocked(realpath).mockResolvedValueOnce(defaultDir as never);
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 4, ino: 44 } as never) // resolvedDir (.SESSION)
      .mockResolvedValueOnce({ dev: 4, ino: 55 } as never); // resolvedDefaultDir (.session) — a distinct directory
    vi.mocked(readdir).mockResolvedValueOnce(['work.json'] as never);
    await expect(isDedicatedDirectory(resolve('.SESSION'), 'second.json', 'powershell')).resolves.toBe(false);
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

  it('still recognizes the default .session directory when the repo is reached through a junction', async () => {
    // Both callers pass a realDir-resolved `dir`, while DEFAULT_SESSION_PATH resolves against a
    // cwd that still holds the junction. Comparing those lexically made the default directory
    // look foreign, so `--session .session/other.json` was blocked outright. Every other
    // default-directory case here passes a lexical path, which is why none of them caught it.
    //
    // `readdir` is mocked to return a second, non-expected `.json` entry so the assertion can
    // only pass via the default-directory relaxation loop, which is what actually consults the
    // junction-resolved comparison — a synthetic directory with no entries would return `true`
    // from the earlier "doesn't exist yet" branch regardless of whether that comparison ran.
    // `stat` is mocked to confirm identity (same dev/ino), since both sides resolve to the same
    // path here and the identity check runs regardless of the case-fold pre-check's outcome.
    const realSessionDir = resolve('/real-target/HEBshopping/.session');
    vi.mocked(realpath).mockResolvedValueOnce(realSessionDir as never);
    vi.mocked(stat)
      .mockResolvedValueOnce({ dev: 9, ino: 99 } as never)
      .mockResolvedValueOnce({ dev: 9, ino: 99 } as never);
    vi.mocked(readdir).mockResolvedValueOnce(['session.json'] as never);
    await expect(isDedicatedDirectory(realSessionDir, 'second.json', 'powershell')).resolves.toBe(true);
  });

  it('does not let a failure resolving the unrelated default .session directory block a custom one', async () => {
    // The default .session directory might be unreadable (e.g. left behind by a different
    // account) even though the caller chose a custom --session directory that has nothing to do
    // with it — that failure must not abort a check that doesn't need it. realDir only throws
    // for a non-ENOENT error, so mock realpath (which it wraps) to reject with one.
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(realpath).mockRejectedValueOnce(error);
    vi.mocked(readdir).mockResolvedValueOnce(['other.json'] as never);
    await expect(isDedicatedDirectory('/some/other/dir', 'other.json', 'powershell')).resolves.toBe(true);
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

  it('propagates rename failures other than "does not exist" instead of treating the directory as empty', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(clearDirectoryContents('/some/profile/dir')).rejects.toThrow('permission denied');
  });

  it('removes a junction standing in for the profile directory, instead of following it into its target', async () => {
    // Another account could have replaced .playwright-profile with a junction to somewhere it
    // can write; readdir() follows a junctioned path, so without the lstat check above this
    // would recursively delete the *target's* contents instead of just the link. A real
    // junction, not a mock: this is exactly the "does readdir follow it" question a mock of
    // readdir can't actually answer.
    const scratch = await mkdtemp(join(tmpdir(), 'heb-profile-link-'));
    const target = join(scratch, 'target');
    const link = join(scratch, 'link');
    try {
      await mkdir(target);
      await writeFile(join(target, 'outside-file.txt'), 'do not delete me');
      await symlink(target, link, 'junction');

      await clearDirectoryContents(link);

      await expect(readdir(scratch)).resolves.toEqual(['target']); // the link itself is gone
      await expect(readdir(target)).resolves.toEqual(['outside-file.txt']); // target untouched
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('detaches dir with one rename before touching anything else, so a link swapped into its name mid-clear is never followed and the restore fails closed', async () => {
    // The race this guards: a separate lstat then readdir are two syscalls resolving the same
    // path independently, so another account with write access to the parent could swap `dir`
    // for a link in the gap between them, which readdir would then follow. The fix detaches
    // `dir` with a single rename() before anything else runs, closing that gap. Proved here by
    // planting a junction at `dir`'s name from inside the mocked rename call itself — the
    // earliest any outside actor could possibly act — and confirming it changes nothing about
    // what gets cleared, and that the final restore fails instead of silently overwriting it.
    const { rename: realRename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const scratch = await mkdtemp(join(tmpdir(), 'heb-profile-race-'));
    const dir = join(scratch, 'profile');
    const plantedTarget = join(scratch, 'planted-target');
    try {
      await mkdir(dir);
      await writeFile(join(dir, 'Cookies'), 'data');
      await mkdir(plantedTarget);
      await writeFile(join(plantedTarget, 'secret.txt'), 'do not delete me');

      vi.mocked(rename).mockImplementationOnce(async (from, to) => {
        await realRename(from as string, to as string);
        await symlink(plantedTarget, dir, 'junction');
      });

      await expect(clearDirectoryContents(dir)).rejects.toThrow();

      await expect(readdir(plantedTarget)).resolves.toEqual(['secret.txt']); // never touched
      expect((await lstat(dir)).isSymbolicLink()).toBe(true); // swapped-in link left alone, not clobbered
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('restores the detached directory back under dir when clearing fails partway through', async () => {
    // A locked Chromium LOCK/SingletonLock file makes readdir/rm throw after the detach. Without
    // a restore, the original ACL-locked directory object would be stranded under its
    // `.clearing-<hex>` name and the next run would find `dir` missing and silently recreate it
    // under the parent's (often broader) inherited ACL — the exact outcome this function exists
    // to avoid.
    const dir = await mkdtemp(join(tmpdir(), 'heb-profile-'));
    try {
      await writeFile(join(dir, 'Cookies'), 'data');
      const error = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      vi.mocked(readdir).mockRejectedValueOnce(error);

      await expect(clearDirectoryContents(dir)).rejects.toThrow('resource busy or locked');

      await expect(readdir(dir)).resolves.toEqual(['Cookies']); // restored, not left under .clearing-<hex>
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores the detached directory when the identity check itself fails, not just readdir/rm', async () => {
    // The same stranding risk as the readdir/rm case above, but one step earlier: lstat(detached)
    // ran outside the restoring try/finally, so antivirus transiently locking the just-renamed
    // entry (or it being removed concurrently) threw before the directory was ever put back.
    const dir = await mkdtemp(join(tmpdir(), 'heb-profile-'));
    try {
      await writeFile(join(dir, 'Cookies'), 'data');
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(lstat).mockRejectedValueOnce(error);

      await expect(clearDirectoryContents(dir)).rejects.toThrow('permission denied');

      await expect(readdir(dir)).resolves.toEqual(['Cookies']); // restored, not left under .clearing-<hex>
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores the swapped-in link under dir when removing it fails, instead of stranding it under .clearing-<hex>', async () => {
    // The symlink-removal path clears `restore` so a *successful* removal doesn't then try to
    // rename a path that no longer exists — but if rm() itself fails (e.g. antivirus holding the
    // link), that flag must not already be cleared, or the finally block leaves dir missing
    // entirely instead of putting the link back where it was.
    const scratch = await mkdtemp(join(tmpdir(), 'heb-profile-link-fail-'));
    const dir = join(scratch, 'profile');
    const target = join(scratch, 'target');
    try {
      await mkdir(target);
      await symlink(target, dir, 'junction');
      const error = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      vi.mocked(rm).mockRejectedValueOnce(error);

      await expect(clearDirectoryContents(dir)).rejects.toThrow('resource busy or locked');

      expect((await lstat(dir)).isSymbolicLink()).toBe(true); // restored, not left under .clearing-<hex>
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
    expect(note).toContain('the Windows note above Step 5');
    // Printed before login starts, ahead of the session check, so it must not claim a prior one.
    expect(note).not.toContain('the check above');
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
