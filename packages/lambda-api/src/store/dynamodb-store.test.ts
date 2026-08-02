/**
 * `DynamoDbStore` against the same contract as `FileStore`.
 *
 * That interchangeability is the whole local-development story: if these two can drift,
 * everything verified on a laptop proves nothing about production. The DynamoDB client is
 * faked rather than mocked per-call — a tiny in-memory table — so the contract exercises
 * real command construction and real round-tripping.
 */

import { describe, expect, it } from 'vitest';
import { runStoreContract, sampleSession } from '@heb/core/testing';
import { DynamoDbStore } from './dynamodb-store.js';

/** Just enough DynamoDBDocumentClient to serve Get and Put. */
function fakeDocumentClient() {
  const rows = new Map<string, Record<string, unknown>>();

  return {
    rows,
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      const name = command.constructor.name;
      if (name === 'PutCommand') {
        rows.set(String(command.input['Item'].sessionId), command.input['Item']);
        return {};
      }
      if (name === 'GetCommand') {
        return { Item: rows.get(String(command.input['Key'].sessionId)) };
      }
      throw new Error(`unexpected command: ${name}`);
    },
  };
}

runStoreContract('DynamoDbStore', async () => {
  const client = fakeDocumentClient();
  return {
    store: new DynamoDbStore({ tableName: 'heb-session', client: client as never }),
    cleanup: async () => client.rows.clear(),
  };
});

describe('DynamoDbStore — storage shape', () => {
  it('keys by sessionId so a second account needs no second table', async () => {
    const client = fakeDocumentClient();
    const mine = new DynamoDbStore({ tableName: 't', sessionId: 'mine', client: client as never });
    const theirs = new DynamoDbStore({ tableName: 't', sessionId: 'theirs', client: client as never });

    await mine.putSession(sampleSession({ buildId: 'mine' }));
    await theirs.putSession(sampleSession({ buildId: 'theirs' }));

    expect((await mine.getSession())?.buildId).toBe('mine');
    expect((await theirs.getSession())?.buildId).toBe('theirs');
  });

  it('reads a structurally invalid row as absent rather than crashing', async () => {
    const client = fakeDocumentClient();
    client.rows.set('default', { sessionId: 'default', session: { cookies: null } });

    // Callers must get the "log in again" path, not a crash deep inside checkSession.
    const store = new DynamoDbStore({ tableName: 't', client: client as never });
    expect(await store.getSession()).toBeNull();
  });

  it('reads consistently, so a command right after re-login sees the new jar', async () => {
    const client = fakeDocumentClient();
    const captured: Array<Record<string, unknown>> = [];
    const spy = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        captured.push(command.input);
        return client.send(command as never);
      },
    };

    await new DynamoDbStore({ tableName: 't', client: spy as never }).getSession();
    expect(captured[0]?.['ConsistentRead']).toBe(true);
  });
});
