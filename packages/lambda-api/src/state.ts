/**
 * Multi-turn state for the confirmation dialog.
 *
 * Everything here lives in **Alexa session attributes**, never in module scope. A warm
 * Lambda serves many households' invocations from the same process; a module-level
 * variable would leak one person's pending question into someone else's conversation, and
 * would do it intermittently enough to be very hard to reproduce.
 */

import type { HandlerInput } from 'ask-sdk-core';

const PENDING_KEY = 'pendingChoice';

/**
 * How many candidates to offer before giving up and deferring to the app card.
 *
 * Three is a ceiling on patience, not on candidates. Asking "did you mean...?" a fourth
 * time is worse than admitting the request was too vague and putting the options somewhere
 * they can be read.
 */
export const MAX_OFFERS = 3;

/**
 * Bounds on the amounts a pending add may carry, matching the MCP tool schema.
 *
 * Both surfaces reach the same `addItem`, so the voice path should not accept an amount the
 * agent path rejects outright.
 */
export const MAX_QUANTITY = 20;
export const MAX_WEIGHT_LB = 20;

export interface Offer {
  /** Set for an add: the catalog product to add. */
  productId?: string;
  /** Set for a removal: the list line to delete. */
  lineId?: string;
  /** Shortened, for speaking. */
  spoken: string;
  /** Full product name, for the card. */
  full: string;
}

export interface PendingChoice {
  kind: 'add' | 'remove';
  /** What the user originally said, for phrasing the give-up message and the card. */
  spokenQuery: string;
  /** Only meaningful for an add. */
  quantity: number;
  /**
   * Pounds, when the add was phrased by weight. Only meaningful for an add.
   *
   * Carried across the dialog so answering "yes" to the second offer still orders two
   * pounds — dropping it here would quietly turn the confirmation into a one-unit add.
   */
  weight?: number;
  offers: Offer[];
  /** Which offer is currently on the table. */
  index: number;
}

export function readPending(input: HandlerInput): PendingChoice | null {
  const attributes = input.attributesManager.getSessionAttributes();
  const pending = attributes[PENDING_KEY] as PendingChoice | undefined;

  // Session attributes survive a round trip as plain JSON, so nothing about their shape is
  // guaranteed. Validate rather than trust: a malformed value should read as "no pending
  // question" and let the user start over, not throw mid-conversation.
  // `index` must be a real position, not merely a number. `-1`, `NaN` and `1.5` all pass a
  // bare `typeof` check and a `>= length` check, and `currentOffer` then returns undefined
  // while the yes/no handlers assert an offer exists — so a malformed attribute throws
  // mid-dialog instead of quietly reading as "no pending question", which is the whole
  // point of validating here.
  if (
    // `null` is valid JSON and survives a round trip, so `=== undefined` does not cover it
    // — and `pending.offers` on a null throws the very error this validation exists to
    // prevent. Same for a primitive left there by a malformed client.
    typeof pending !== 'object' ||
    pending === null ||
    !Array.isArray(pending.offers) ||
    !Number.isInteger(pending.index) ||
    pending.index < 0 ||
    pending.index >= pending.offers.length ||
    // `kind` decides which mutation "yes" runs. An attribute carrying anything else reaches
    // the handlers as neither branch, and a *wrong* one routes the answer into the other
    // mutation entirely.
    (pending.kind !== 'add' && pending.kind !== 'remove')
  ) {
    return null;
  }

  // The offer on the table must carry the id its `kind` needs. Shape and kind can both look
  // right while the two disagree — `kind: 'remove'` over an offer holding only a
  // `productId`, say — and the yes handler then calls removal with `lineId: undefined`.
  // Validating the pair is the point: either field alone passes.
  const offer = pending.offers[pending.index];
  const id =
    typeof offer === 'object' && offer !== null
      ? pending.kind === 'add'
        ? (offer as Offer).productId
        : (offer as Offer).lineId
      : undefined;
  if (typeof id !== 'string' || id === '') return null;

  // The amounts an "add" carries into `addItem`. This function is the boundary that
  // promises arbitrary session JSON is tolerated, so the promise has to cover the numbers
  // too: `quantity: {}` or `weight: "2"` reach the mutation and either write a unit nobody
  // asked for or compute a nonsense counter-weight target. Bounds match the MCP schema.
  if (pending.kind === 'add') {
    if (!Number.isInteger(pending.quantity) || pending.quantity < 1 || pending.quantity > MAX_QUANTITY) {
      return null;
    }
    if (
      pending.weight !== undefined &&
      (!Number.isFinite(pending.weight) || pending.weight <= 0 || pending.weight > MAX_WEIGHT_LB)
    ) {
      return null;
    }
  }

  return pending;
}

export function writePending(input: HandlerInput, pending: PendingChoice): void {
  const attributes = input.attributesManager.getSessionAttributes();
  input.attributesManager.setSessionAttributes({ ...attributes, [PENDING_KEY]: pending });
}

export function clearPending(input: HandlerInput): void {
  const attributes = input.attributesManager.getSessionAttributes();
  const { [PENDING_KEY]: _discarded, ...rest } = attributes;
  input.attributesManager.setSessionAttributes(rest);
}

/** The offer currently being asked about. */
export function currentOffer(pending: PendingChoice): Offer | undefined {
  return pending.offers[pending.index];
}

/** Advance to the next candidate, or `null` when the patience budget is spent. */
export function nextOffer(pending: PendingChoice): PendingChoice | null {
  const index = pending.index + 1;
  if (index >= Math.min(pending.offers.length, MAX_OFFERS)) return null;
  return { ...pending, index };
}
