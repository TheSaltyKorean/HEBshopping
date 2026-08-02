/**
 * The Alexa custom skill.
 *
 * Transport-agnostic and dependency-injected: `createSkill` takes a factory for `ListOps`,
 * so the whole conversation can be driven in tests with no AWS, no network, and no Echo.
 * `handler.ts` supplies the real one.
 *
 * The shape of the conversation is dictated by a measured fact, not a preference. Against
 * real HEB search results, almost every spoken request lands below `CONFIRMATION_THRESHOLD`
 * — "flour tortillas" matches sixty products, and the top two are equally good answers. So
 * **the confirmation dialog is the main path, not an exception**, and it has to be good:
 * short, sequential, and always escapable.
 */

import * as Alexa from 'ask-sdk-core';
import type {
  HandlerInput,
  RequestHandler,
  RequestInterceptor,
  ErrorHandler,
} from 'ask-sdk-core';
import type { Response } from 'ask-sdk-model';
import {
  isHebError,
  parseSpokenRequest,
  type HebErrorCode,
  type ListItem,
  type Product,
} from '@heb/core';
import type { HebListOps } from '@heb/core';
import {
  MAX_SPOKEN_ITEMS,
  cardList,
  escapeSsml,
  speakableItem,
  speakableJoin,
  speakableList,
  speakableOffers,
  speakableProduct,
} from './speech.js';
import {
  MAX_OFFERS,
  clearPending,
  currentOffer,
  nextOffer,
  readPending,
  writePending,
  type Offer,
  type PendingChoice,
} from './state.js';

const CARD_TITLE = 'H-E-B Shopping List';

export interface CreateSkillOptions {
  /**
   * Built per invocation, never shared. `HebListOps` caches the resolved list, which is
   * correct within one command and wrong across two.
   */
  createListOps: () => HebListOps;
  /**
   * The skill id this Lambda will accept.
   *
   * With a direct Alexa trigger there is no HTTP request to sign, so signature
   * verification does not apply — the trigger itself is the authenticated channel. What
   * *does* still matter is that anyone who learns this function's ARN could point their own
   * skill at it, so the skill id is checked and everything else rejected.
   */
  skillId?: string;
}

// ---------------------------------------------------------------------------
// Speech helpers
// ---------------------------------------------------------------------------

const REPROMPT = 'You can add something, ask what is on your list, or remove something.';

/**
 * Every candidate, not just the ones we will speak.
 *
 * `MAX_OFFERS` caps *questions*, not candidates — `nextOffer` enforces that. Truncating
 * here instead would leave `giveUp` building its card from only the three options the user
 * has just rejected, which is precisely the opposite of what the card is for.
 */
function offersFor(product: Product, alternatives: readonly Product[]): Offer[] {
  const candidates = [product, ...alternatives];
  const spoken = speakableOffers(candidates);

  return candidates.map((candidate, index) => ({
    productId: candidate.id,
    spoken: spoken[index]!,
    full: candidate.name,
  }));
}

function ask(input: HandlerInput, offer: Offer): Response {
  const name = escapeSsml(offer.spoken);
  return input.responseBuilder
    .speak(`Did you mean ${name}?`)
    .reprompt(`Did you mean ${name}? You can say yes, no, or cancel.`)
    .getResponse();
}

/**
 * Out of patience: stop guessing and put the options where they can be read.
 *
 * This is the escape hatch that makes a voice-only ambiguity survivable at all. Reading
 * candidates four and five aloud helps nobody; a card in the Alexa app can hold as many as
 * we like, with full names and sizes.
 */
function giveUp(input: HandlerInput, pending: PendingChoice): Response {
  const names = pending.offers.map((offer) => offer.full);
  return input.responseBuilder
    .speak(
      `Sorry, I could not tell which one you wanted. ` +
        `I have put the choices for ${escapeSsml(pending.spokenQuery)} in your Alexa app.`,
    )
    .withSimpleCard(CARD_TITLE, `Did you mean one of these?\n\n${names.join('\n')}`)
    .getResponse();
}

function confirmAdded(input: HandlerInput, item: ListItem, wasPresent: boolean): Response {
  // Confirm with the *resolved* product name, never the spoken text: the whole point of
  // the dialog is that those two can differ, and echoing the request back would hide it.
  const name = escapeSsml(speakableItem(item));
  const speech = wasPresent
    ? `${name} was already on your list. You now have ${item.quantity}.`
    : `Added ${item.quantity > 1 ? `${item.quantity} ` : ''}${name}.`;

  return input.responseBuilder
    .speak(`${speech} Anything else?`)
    .reprompt(REPROMPT)
    .getResponse();
}

// ---------------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------------

const isIntent =
  (...names: string[]) =>
  (input: HandlerInput): boolean =>
    Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' &&
    names.includes(Alexa.getIntentName(input.requestEnvelope));

function launchHandler(): RequestHandler {
  return {
    canHandle: (input) => Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest',
    handle: (input) =>
      input.responseBuilder
        .speak(`H-E-B list. ${REPROMPT}`)
        .reprompt(REPROMPT)
        .getResponse(),
  };
}

function addItemHandler(options: CreateSkillOptions): RequestHandler {
  return {
    canHandle: isIntent('AddItemIntent'),
    async handle(input) {
      const spoken = Alexa.getSlotValue(input.requestEnvelope, 'item');
      if (spoken === undefined || spoken.trim() === '') {
        return input.responseBuilder
          .speak('What would you like to add?')
          .reprompt('What would you like to add?')
          .getResponse();
      }

      // Quantity is parsed from the spoken phrase rather than a separate slot: "two
      // avocados" arrives as one AMAZON.SearchQuery, and heb-core already knows that
      // "two percent milk" is one carton rather than two.
      const { quantity, query } = parseSpokenRequest(spoken);
      const result = await options.createListOps().addItem({ query, quantity });

      if (result.status === 'added') return confirmAdded(input, result.item, false);
      if (result.status === 'already_present') return confirmAdded(input, result.item, true);

      const pending: PendingChoice = {
        kind: 'add',
        spokenQuery: query,
        quantity,
        offers: offersFor(result.match.product, result.match.alternatives),
        index: 0,
      };
      writePending(input, pending);
      return ask(input, currentOffer(pending)!);
    },
  };
}

function readListHandler(options: CreateSkillOptions): RequestHandler {
  return {
    canHandle: isIntent('ReadListIntent'),
    async handle(input) {
      const list = await options.createListOps().getList();
      const builder = input.responseBuilder.speak(
        `${escapeSsml(speakableList(list.items))} Anything else?`,
      );

      // Only the overflow case. Every nonempty list used to get one, so a three-item read
      // left a card in the app's history that said nothing the speech had not already.
      if (list.items.length > MAX_SPOKEN_ITEMS) {
        builder.withSimpleCard(CARD_TITLE, cardList(list.items));
      }
      return builder.reprompt(REPROMPT).getResponse();
    },
  };
}

function removeItemHandler(options: CreateSkillOptions): RequestHandler {
  return {
    canHandle: isIntent('RemoveItemIntent'),
    async handle(input) {
      const spoken = Alexa.getSlotValue(input.requestEnvelope, 'item');
      if (spoken === undefined || spoken.trim() === '') {
        return input.responseBuilder
          .speak('What would you like to remove?')
          .reprompt('What would you like to remove?')
          .getResponse();
      }

      const listOps = options.createListOps();
      const ranked = await listOps.rankLines(spoken);

      if (ranked.length === 0) {
        return input.responseBuilder
          .speak(`I could not find ${escapeSsml(spoken)} on your list. Anything else?`)
          .reprompt(REPROMPT)
          .getResponse();
      }

      const best = ranked[0]!;
      if (best.confident) {
        await listOps.removeItem({ lineId: best.item.lineId });
        return input.responseBuilder
          .speak(`Removed ${escapeSsml(speakableItem(best.item))}. Anything else?`)
          .reprompt(REPROMPT)
          .getResponse();
      }

      const pending: PendingChoice = {
        kind: 'remove',
        spokenQuery: spoken,
        quantity: 1,
        offers: (() => {
          // Synthesise a product per *line* so free-text items can be offered too:
          // they have no catalog product, but they do have text worth speaking.
          const spoken = speakableOffers(
            ranked.map((entry) => entry.item.product ?? { id: entry.item.lineId, name: entry.item.text }),
          );
          return ranked.map((entry, index) => ({
            lineId: entry.item.lineId,
            spoken: spoken[index]!,
            full: entry.item.product?.name ?? entry.item.text,
          }));
        })(),
        index: 0,
      };
      writePending(input, pending);
      return ask(input, currentOffer(pending)!);
    },
  };
}

/** "Yes" only means anything while a question is on the table. */
function yesHandler(options: CreateSkillOptions): RequestHandler {
  return {
    canHandle: (input) => isIntent('AMAZON.YesIntent')(input) && readPending(input) !== null,
    async handle(input) {
      const pending = readPending(input)!;
      const offer = currentOffer(pending)!;
      clearPending(input);

      const listOps = options.createListOps();

      if (pending.kind === 'remove') {
        await listOps.removeItem({ lineId: offer.lineId! });
        return input.responseBuilder
          .speak(`Removed ${escapeSsml(offer.spoken)}. Anything else?`)
          .reprompt(REPROMPT)
          .getResponse();
      }

      // Adding by productId skips matching entirely — the user has just resolved the
      // ambiguity themselves, so re-searching could only reintroduce it.
      const result = await listOps.addItem({
        productId: offer.productId!,
        quantity: pending.quantity,
      });
      if (result.status === 'needs_confirmation') {
        return giveUp(input, pending); // unreachable via productId, but never guess
      }
      return confirmAdded(input, result.item, result.status === 'already_present');
    },
  };
}

/** "No" walks to the next candidate, or gives up gracefully. */
function noHandler(): RequestHandler {
  return {
    canHandle: (input) => isIntent('AMAZON.NoIntent')(input) && readPending(input) !== null,
    handle(input) {
      const pending = readPending(input)!;
      const advanced = nextOffer(pending);

      if (advanced === null) {
        clearPending(input);
        return giveUp(input, pending);
      }
      writePending(input, advanced);
      return ask(input, currentOffer(advanced)!);
    },
  };
}

function helpHandler(): RequestHandler {
  return {
    canHandle: isIntent('AMAZON.HelpIntent'),
    handle: (input) =>
      input.responseBuilder
        .speak(
          'You can say: add oat milk. Or: what is on my list. Or: remove tortillas. ' +
            'When I ask "did you mean", answer yes or no. What would you like?',
        )
        .reprompt(REPROMPT)
        .getResponse(),
  };
}

function stopHandler(): RequestHandler {
  return {
    canHandle: isIntent('AMAZON.CancelIntent', 'AMAZON.StopIntent', 'AMAZON.NoIntent'),
    handle: (input) => {
      // Reached by a bare "no" with nothing pending — the yes/no handlers above claim it
      // first whenever a question is actually on the table.
      clearPending(input);
      return input.responseBuilder.speak('Okay.').withShouldEndSession(true).getResponse();
    },
  };
}

function fallbackHandler(): RequestHandler {
  return {
    canHandle: isIntent('AMAZON.FallbackIntent'),
    handle(input) {
      // Mid-dialog, a misheard word should not cost the question. Re-ask it rather than
      // dropping to a generic prompt that a later "yes" could no longer be answering.
      const pending = readPending(input);
      if (pending !== null) {
        const offer = currentOffer(pending);
        if (offer !== undefined) return ask(input, offer);
      }
      return input.responseBuilder
        .speak(`Sorry, I did not catch that. ${REPROMPT}`)
        .reprompt(REPROMPT)
        .getResponse();
    },
  };
}

/**
 * Intents that are answering the pending question rather than replacing it.
 *
 * Everything else supersedes the dialog. Without this, an ambiguous removal followed by
 * "what's on my list" would leave `pendingChoice` intact, and the next "yes" — meant for
 * something else entirely — would delete the line offered several turns ago.
 */
const DIALOG_INTENTS = new Set([
  'AMAZON.YesIntent',
  'AMAZON.NoIntent',
  'AMAZON.FallbackIntent',
]);

function clearSupersededPending(): RequestInterceptor {
  return {
    process(input) {
      if (Alexa.getRequestType(input.requestEnvelope) !== 'IntentRequest') return;
      if (DIALOG_INTENTS.has(Alexa.getIntentName(input.requestEnvelope))) return;
      clearPending(input);
    },
  };
}

function sessionEndedHandler(): RequestHandler {
  return {
    canHandle: (input) => Alexa.getRequestType(input.requestEnvelope) === 'SessionEndedRequest',
    handle: (input) => input.responseBuilder.getResponse(),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Spoken copy per error code.
 *
 * Every one of these tells the listener what to *do*. "An error occurred" is useless out
 * loud, because there is no log to go and read.
 */
const SPEECH_BY_CODE: Readonly<Record<HebErrorCode, string>> = {
  SESSION_EXPIRED:
    'My H-E-B login has expired. Someone needs to run the login tool on the computer to fix it.',
  BOT_CHALLENGE: 'H-E-B is asking me to prove I am not a robot. Please try again in a minute.',
  PRODUCT_NOT_FOUND:
    'I could not find that at your H-E-B. Try naming a brand, since many products here are ' +
    'listed under Spanish names.',
  AMBIGUOUS_LIST:
    'You have more than one H-E-B list, so I do not know which to use. Pick one in the setup.',
  AMBIGUOUS_REMOVAL: 'More than one thing on your list matches that.',
  ITEM_NOT_ON_LIST: 'That is not on your list.',
  UPSTREAM_ERROR: 'H-E-B is not responding right now. Please try again in a moment.',
};

function errorHandler(): ErrorHandler {
  return {
    canHandle: () => true,
    handle(input, error) {
      if (isHebError(error)) {
        // The CODE only. Not the message, and not `details`: PRODUCT_NOT_FOUND embeds the
        // spoken grocery query and AMBIGUOUS_LIST embeds list names, so logging either
        // would retain a household's shopping in CloudWatch indefinitely.
        console.error(`HebError ${error.code}`);
        return input.responseBuilder
          .speak(SPEECH_BY_CODE[error.code])
          .withShouldEndSession(true)
          .getResponse();
      }

      // Deliberately not the message: an upstream error can echo request content back.
      console.error(`Unhandled error: ${error instanceof Error ? error.name : 'unknown'}`);
      return input.responseBuilder
        .speak('Something went wrong talking to H-E-B. Please try again.')
        .withShouldEndSession(true)
        .getResponse();
    },
  };
}

// ---------------------------------------------------------------------------

export function createSkill(options: CreateSkillOptions) {
  const builder = Alexa.SkillBuilders.custom().addRequestHandlers(
    launchHandler(),
    // Yes/No must precede the generic stop handler, which also claims NoIntent.
    yesHandler(options),
    noHandler(),
    addItemHandler(options),
    readListHandler(options),
    removeItemHandler(options),
    helpHandler(),
    stopHandler(),
    fallbackHandler(),
    sessionEndedHandler(),
  );

  builder.addRequestInterceptors(clearSupersededPending());
  builder.addErrorHandlers(errorHandler());
  if (options.skillId !== undefined) builder.withSkillId(options.skillId);
  return builder.create();
}

export { speakableJoin };
