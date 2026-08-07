import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { runStoreContract, sampleSession } from './store-contract.js';

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'heb-store-'));
  return {
    store: new FileStore(join(directory, 'nested', 'session.json')),
    cleanup: () => rm(directory, { recursive: true, force: true }),
    directory,
  };
}

runStoreContract('FileStore', harness);

// Whether this filesystem actually enforces the owner-only mode `chmod` requests. False on
// Windows (`chmod` there only toggles the read-only attribute) and on some WSL mounts of a
// Windows drive, which report `process.platform === 'linux'` but can behave the same way —
// so this is checked by writing a real file rather than trusting the platform name.
const honorsOwnerOnlyMode = await (async () => {
  const probeDir = await mkdtemp(join(tmpdir(), 'heb-mode-probe-'));
  try {
    const probePath = join(probeDir, 'probe');
    await writeFile(probePath, 'x', { mode: 0o600 });
    await chmod(probePath, 0o600);
    return ((await stat(probePath)).mode & 0o777) === 0o600;
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
})();

describe('FileStore specifics', () => {
  // Skipped rather than loosened where the filesystem doesn't honour the mode: relaxing the
  // assertion to accept whatever comes back would make it pass everywhere while checking
  // nothing, and asserting that value would pin the platform's quirk as if it were the
  // guarantee. Neither is the guarantee, so the check runs where it is real and is honest
  // about not running where it is not — see `SECRET_FILE_MODE` and docs/setup.md for what
  // protects the file where this doesn't hold.
  it.skipIf(!honorsOwnerOnlyMode)('writes the session owner-only', async () => {
    // The file holds live auth cookies for an account with a saved payment method, so a
    // default-umask world-readable file would be a real exposure on a shared machine.
    const { store, cleanup, directory } = await harness();
    try {
      await store.putSession(sampleSession());
      const mode = (await stat(join(directory, 'nested', 'session.json'))).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

  it('creates missing parent directories', async () => {
    const { store, cleanup } = await harness();
    try {
      await expect(store.putSession(sampleSession())).resolves.not.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('treats a corrupt file as "no session" rather than throwing', async () => {
    // Callers can act on "log in again". They cannot act on a JSON parse error, and an
    // exception here would surface to a voice user as an opaque failure.
    const { cleanup, directory } = await harness();
    const path = join(directory, 'session.json');
    try {
      await writeFile(path, '{ this is not valid json');
      expect(await new FileStore(path).getSession()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('leaves no temp file behind after a write', async () => {
    const { store, cleanup, directory } = await harness();
    try {
      await store.putSession(sampleSession());
      await expect(stat(join(directory, 'nested', 'session.json.tmp'))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe('stored sessions must carry cookie paths', () => {
  it('treats a jar without paths as absent rather than crashing later', async () => {
    // `path` became load-bearing when cookies started being matched by scope; without it
    // `cookiePathMatches` throws a bare TypeError instead of the login remedy.
    const path = join(tmpdir(), `heb-nopath-${Date.now()}.json`);
    await writeFile(
      path,
      JSON.stringify({
        cookies: [{ name: 'sat', value: 'x', domain: 'www.heb.com', expires: 1 }],
        capturedAt: 1,
        buildId: null,
      }),
    );

    try {
      expect(await new FileStore(path).getSession()).toBeNull();
    } finally {
      await rm(path, { force: true });
    }
  });
});
