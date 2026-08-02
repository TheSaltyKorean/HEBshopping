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
 * Required, and deliberately fatal when missing.
 *
 * Without it `createSkill` never calls `withSkillId`, and the function accepts requests
 * from *any* Alexa application that can reach it — which is the whole defence against
 * someone pointing their own skill at this ARN, since a direct Alexa trigger has no
 * request signature to verify. Failing at cold start is far better than silently serving
 * a household's shopping list to an unknown skill.
 */
const SKILL_ID = process.env['HEB_SKILL_ID'];
if (SKILL_ID === undefined || SKILL_ID.trim() === '') {
  throw new Error(
    'HEB_SKILL_ID is required: without it this Lambda would accept any Alexa skill id.',
  );
}

/**
 * Built once per container, reused across invocations.
 *
 * Safe to hoist because it holds no per-request state: the skill object is a router. The
 * things that *are* per-request — the resolved list, the pending question — live in
 * `HebListOps` instances and Alexa session attributes respectively.
 */
/**
 * Total HEB time one voice command may consume.
 *
 * Alexa's ceiling is roughly 8 seconds end to end; this leaves room for cold start,
 * parsing, and speaking. The per-call timeout alone cannot enforce it, because an add of
 * several units is three or four sequential calls.
 */
const INVOCATION_BUDGET_MS = 6_500;

const skill = createSkill({
  createListOps: () =>
    new HebListOps({
      client: new HebClient({
        store: new FileStore(SESSION_PATH),
        budgetMs: INVOCATION_BUDGET_MS,
      }),
      ...(process.env['HEB_LIST_ID'] !== undefined ? { listId: process.env['HEB_LIST_ID'] } : {}),
    }),
  skillId: SKILL_ID,
});

export const handler = async (event: unknown, context: unknown): Promise<unknown> =>
  skill.invoke(event as never, context as never);
