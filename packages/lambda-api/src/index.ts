/**
 * @heb/lambda-api — the Alexa surface over the HEB shopping list.
 *
 * `createSkill` is the testable core; `handler.ts` is the thin Lambda wrapper that supplies
 * the real `Store` and configuration.
 */

export { createSkill } from './skill.js';
export type { CreateSkillOptions } from './skill.js';
export { cardList, speakableList, speakableProduct, speakableJoin } from './speech.js';
export { MAX_OFFERS } from './state.js';
export type { Offer, PendingChoice } from './state.js';
