import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

describe('FileStore specifics', () => {
  it('writes the session owner-only', async () => {
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
