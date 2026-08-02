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
  if (
    pending === undefined ||
    !Array.isArray(pending.offers) ||
    typeof pending.index !== 'number' ||
    pending.index >= pending.offers.length
  ) {
    return null;
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
