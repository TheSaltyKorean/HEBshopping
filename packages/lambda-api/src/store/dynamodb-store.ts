/**
 * DynamoDB-backed `Store` — the production session jar.
 *
 * Lives here rather than in `heb-core` on purpose: `heb-core` has zero dependencies, and
 * dragging the AWS SDK into it would put a cloud client inside the pure business logic and
 * make every local test carry it. `Store` is the seam precisely so this can sit outside.
 *
 * One row, one session. The table is not a database — it is a place to keep a cookie jar
 * that must survive Lambda cold starts, and its whole content is a credential.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionState, Store } from '@heb/core';

export interface DynamoDbStoreOptions {
  tableName: string;
  /**
   * Which session this is. One household needs only the default, but the key exists so a
   * second account never means a second table.
   */
  sessionId?: string;
  /** Injectable for tests and for pointing at DynamoDB Local. */
  client?: DynamoDBDocumentClient;
}

export const DEFAULT_SESSION_ID = 'default';

export class DynamoDbStore implements Store {
  private readonly table: string;
  private readonly sessionId: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoDbStoreOptions) {
    this.table = options.tableName;
    this.sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
    this.client =
      options.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        // Cookie values are opaque strings; nothing here benefits from marshalling
        // cleverness, and removing undefined keeps round-tripped sessions byte-identical.
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  async getSession(): Promise<SessionState | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { sessionId: this.sessionId },
        // A stale read here means using cookies that were just replaced, which surfaces as
        // a spurious SESSION_EXPIRED on the one command after a re-login. Cheap to avoid.
        ConsistentRead: true,
      }),
    );

    const item = result.Item;
    if (item === undefined) return null;

    // Same rule as FileStore: structurally invalid reads as absent, so callers get the
    // "log in again" path rather than a crash deep inside `checkSession`.
    return isSessionState(item['session']) ? item['session'] : null;
  }

  async putSession(session: SessionState): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: { sessionId: this.sessionId, session, updatedAt: session.capturedAt },
      }),
    );
  }
}

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SessionState>;
  if (!Array.isArray(candidate.cookies)) return false;

  return candidate.cookies.every(
    (cookie) =>
      typeof cookie === 'object' &&
      cookie !== null &&
      typeof cookie.name === 'string' &&
      typeof cookie.value === 'string' &&
      typeof cookie.domain === 'string' &&
      typeof cookie.expires === 'number',
  );
}
