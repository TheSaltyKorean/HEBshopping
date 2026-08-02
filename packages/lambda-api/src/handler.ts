/**
 * Lambda entry point for the Alexa custom skill.
 *
 * Invoked directly by the Alexa trigger — no API Gateway, which is both cheaper and one
 * fewer thing to secure.
 *
 * Configuration is environment-only, and secrets are never among it: `HEB_LIST_ID` and
 * `HEB_SKILL_ID` are identifiers, not credentials. The session cookies come from the
 * `Store`, which at W10 is DynamoDB.
 */

import { FileStore, HebClient, HebListOps } from '@heb/core';
import { createSkill } from './skill.js';

const SESSION_PATH = process.env['HEB_SESSION_PATH'] ?? '/tmp/heb-session.json';

/**
 * Built once per container, reused across invocations.
 *
 * Safe to hoist because it holds no per-request state: the skill object is a router. The
 * things that *are* per-request — the resolved list, the pending question — live in
 * `HebListOps` instances and Alexa session attributes respectively.
 */
const skill = createSkill({
  createListOps: () =>
    new HebListOps({
      client: new HebClient({ store: new FileStore(SESSION_PATH) }),
      ...(process.env['HEB_LIST_ID'] !== undefined ? { listId: process.env['HEB_LIST_ID'] } : {}),
    }),
  ...(process.env['HEB_SKILL_ID'] !== undefined ? { skillId: process.env['HEB_SKILL_ID'] } : {}),
});

export const handler = async (event: unknown, context: unknown): Promise<unknown> =>
  skill.invoke(event as never, context as never);
