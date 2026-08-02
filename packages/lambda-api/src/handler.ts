/**
 * Lambda entry point for the Alexa custom skill.
 *
 * Invoked directly by the Alexa trigger — no API Gateway, which is both cheaper and one
 * fewer thing to secure.
 *
 * Configuration is environment-only, and secrets are never among it: `HEB_LIST_ID` and
 * `HEB_SKILL_ID` are identifiers, not credentials. The session cookies come from the
 * `Store` — DynamoDB in production, a file locally. See `config.ts`.
 */

import { HebClient, HebListOps } from '@heb/core';
import { createSkill } from './skill.js';
import { INVOCATION_BUDGET_MS, listId, requireSkillId, resolveStore } from './config.js';

// Resolved at cold start so misconfiguration fails immediately and visibly, rather than as
// a mystery "something went wrong" on someone's first voice command. `requireSkillId`
// throwing here is deliberate: without it the function would accept any Alexa skill that
// learns its ARN, and a direct Alexa trigger carries no signature to verify instead.
const store = resolveStore();
const skillId = requireSkillId();
const pinnedList = listId();

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
      client: new HebClient({ store, budgetMs: INVOCATION_BUDGET_MS }),
      ...(pinnedList === undefined ? {} : { listId: pinnedList }),
    }),
  skillId,
});

export const handler = async (event: unknown, context: unknown): Promise<unknown> =>
  skill.invoke(event as never, context as never);
