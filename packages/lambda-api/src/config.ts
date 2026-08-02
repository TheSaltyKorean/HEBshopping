/**
 * Runtime configuration, resolved once and validated loudly.
 *
 * Every value here is an identifier or a location — never a credential. The session lives
 * in the `Store`; the MCP bearer token is read from SSM at cold start and never appears in
 * an environment variable, because Lambda environment variables are visible to anyone with
 * `lambda:GetFunctionConfiguration`.
 *
 * Missing configuration fails at cold start rather than on the first voice command. A
 * skill that answers "something went wrong" is far harder to diagnose than one that never
 * starts.
 */

import { FileStore, type Store } from '@heb/core';
import { DynamoDbStore } from './store/dynamodb-store.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required but was not set.`);
  }
  return value;
}

/**
 * The session store, DynamoDB in production and a file locally.
 *
 * Selected by the presence of `HEB_SESSION_TABLE` rather than a NODE_ENV-style flag: the
 * thing that actually differs is where the jar lives, so let that be what decides.
 */
export function resolveStore(): Store {
  const table = process.env['HEB_SESSION_TABLE'];
  if (table !== undefined && table.trim() !== '') {
    const sessionId = process.env['HEB_SESSION_ID'];
    return new DynamoDbStore({
      tableName: table,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }
  return new FileStore(process.env['HEB_SESSION_PATH'] ?? '/tmp/heb-session.json');
}

/** Pin one list. Only needed when the account has several. */
export function listId(): string | undefined {
  const value = process.env['HEB_LIST_ID'];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * The Alexa skill this function will accept, required in production.
 *
 * A direct Alexa trigger carries no request signature to verify, so the skill id is the
 * only thing standing between this function and any other skill that learns its ARN.
 */
export function requireSkillId(): string {
  return required('HEB_SKILL_ID');
}

/**
 * Total HEB time one invocation may consume.
 *
 * Alexa's ceiling is roughly 8 seconds end to end; this leaves room for cold start,
 * parsing, and speech. A per-call timeout cannot enforce it, because an add of several
 * units is three or four sequential calls.
 */
export const INVOCATION_BUDGET_MS = 6_500;

/**
 * The same budget for MCP, where there is no voice ceiling.
 *
 * An agent will happily wait; Alexa will not. Reusing the voice limit here would abort
 * work that the MCP function's own 15s timeout was configured to allow — a broadened
 * search plus an add plus a quantity mutation, against a slow upstream. Kept under that
 * timeout so the budget fails first, with a spoken-quality error rather than a hard cut.
 */
export const MCP_BUDGET_MS = 12_000;
