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
  hasCode,
  isHebError,
  parseSpokenRequest,
  MAX_QUANTITY,
  MAX_WEIGHT_LB,
  type AddResult,
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
  speakablePounds,
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
   * The skill ids this Lambda will accept. Empty or omitted disables the check (tests only).
   *
   * With a direct Alexa trigger there is no HTTP request to sign, so signature
   * verification does not apply — the trigger itself is the authenticated channel. What
   * *does* still matter is that anyone who learns this function's ARN could point their own
   * skill at it, so the skill id is checked and everything else rejected.
   *
   * A *list*, because Alexa allows exactly one invocation name per skill. Answering to
   * both "grocery list" and "heb list" means two skills, and they share this one Lambda.
   */
  skillIds?: readonly string[];
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

/**
 * Confirm a line we wrote down rather than matched.
 *
 * Says both halves out loud — that the search failed *and* what was written. Reporting only
 * the success would hide that no real product is attached, and someone shopping from this
 * list would look for a scannable item that is not there.
 */
function confirmWritten(input: HandlerInput, item: ListItem, wasPresent: boolean): Response {
  const name = escapeSsml(item.text);
  const speech = wasPresent
    ? `I could not find that at your H-E-B. It was already written on your list, ` +
      `so you now have ${item.quantity}.`
    : `I could not find that at your H-E-B, so I wrote ${name} on your list.`;
  return input.responseBuilder.speak(`${speech} Anything else?`).reprompt(REPROMPT).getResponse();
}

function confirmAdded(
  input: HandlerInput,
  item: ListItem,
  wasPresent: boolean,
  quantityRequested?: number,
  weightRequested?: number,
): Response {
  // Confirm with the *resolved* product name, never the spoken text: the whole point of
  // the dialog is that those two can differ, and echoing the request back would hide it.
  const name = escapeSsml(speakableItem(item));

  // A concurrent add of the same, previously-absent product merges into this line before
  // this request's own units land, so `item.quantity` can read higher than what was asked
  // for. Speak the amount this request actually contributed, not the merged total — the
  // `mergedNotice` below says what the list now holds.
  const requestedCount =
    !wasPresent && quantityRequested !== undefined && item.quantity > quantityRequested
      ? quantityRequested
      : item.quantity;

  // A counter line is measured in pounds, so speak pounds. Its `quantity` is an artefact
  // of how HEB stores the row, and "you now have 1" beside two pounds of turkey is wrong.
  const speech = wasPresent
    ? item.weight === undefined
      ? `${name} was already on your list. You now have ${item.quantity}.`
      : `${name} was already on your list. You now have ${speakablePounds(item.weight)}.`
    : item.weight === undefined
      ? `Added ${requestedCount > 1 ? `${requestedCount} ` : ''}${name}.`
      : `Added ${speakablePounds(item.weight)} of ${name}.`;

  // The server's per-item cap can stop a multi-unit add short of what was asked. Saying so
  // is what tells the shopper the line reads 10, not the 15 they actually asked for.
  const cappedNotice =
    quantityRequested !== undefined && quantityRequested > item.quantity
      ? ` H-E-B only allows ${item.quantity} of ${name}, so I could not add all ${quantityRequested}.`
      : '';

  // The other direction: someone else added the same item in the gap, so the list holds
  // more than this request asked for.
  const mergedNotice =
    !wasPresent && quantityRequested !== undefined && item.quantity > quantityRequested
      ? ` Someone else added it too, so the list now has ${item.quantity}.`
      : '';

  // Same idea for a counter product whose own weight ladder tops out below the ask: the
  // line was written at the last rung, not the pounds actually requested. A packaged
  // product has no ladder at all — `item.weight` stays undefined and the pounds asked for
  // were dropped entirely in favor of one package.
  const weightCappedNotice =
    weightRequested === undefined
      ? ''
      : item.weight === undefined
        ? ` ${name} is sold by the package, not the pound, so I added one instead of ${speakablePounds(weightRequested)}.`
        : weightRequested > item.weight
          ? ` H-E-B only sells ${name} up to ${speakablePounds(item.weight)}, so I could not add the full ${speakablePounds(weightRequested)}.`
          : '';

  return input.responseBuilder
    .speak(`${speech}${cappedNotice}${mergedNotice}${weightCappedNotice} Anything else?`)
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
      const { quantity, query, weight, quantityRefused, weightRefused } = parseSpokenRequest(spoken);

      // A count above the ceiling every surface enforces. Say so rather than acting on some
      // other number: adding `MAX_QUANTITY` writes an amount nobody asked for, and dropping
      // the count adds one while confirming the right product — a silent undercount the
      // speaker has no way to notice.
      if (quantityRefused !== undefined) {
        const message =
          `I can add up to ${MAX_QUANTITY} at a time, and you asked for ${quantityRefused}. ` +
          'Try again with a smaller number.';
        return input.responseBuilder.speak(message).reprompt(message).getResponse();
      }

      // Same rule, by weight: a confident match on "twenty-one pounds of turkey" would
      // otherwise perform a live mutation with the oversized weight before this handler ever
      // gets a say.
      if (weightRefused !== undefined) {
        const message =
          `I can add up to ${MAX_WEIGHT_LB} pounds at a time, and you asked for ${weightRefused}. ` +
          'Try again with a smaller amount.';
        return input.responseBuilder.speak(message).reprompt(message).getResponse();
      }

      // "Add zero bananas" is a refusal, and the parser deliberately keeps the word in the
      // query rather than treating zero as a count. The catalog search must still run —
      // "zero sugar dr pepper" is a real product and has to keep working — but if nothing
      // matches, writing "zero bananas" down would turn a refusal into a list entry.
      const refusesWithZero = /^(?:zero|0)\b/.test(query.trim());

      // "Add some" is filler all the way down: the parse leaves nothing to search for.
      // Falling through would reach PRODUCT_NOT_FOUND and write "some" onto the list as a
      // written line — a request nobody made, from a sentence that was never finished.
      if (query.trim() === '') {
        return input.responseBuilder
          .speak('What would you like to add?')
          .reprompt('What would you like to add?')
          .getResponse();
      }

      // ONE client for the whole invocation, reused by the fallback below. A second
      // `createListOps()` builds a fresh `HebClient` and hands it a fresh 6.5-second
      // budget, so a slow search followed by a fallback add can run past Alexa's ~8s
      // ceiling and the Lambda timeout — and a text mutation that commits at the cutoff
      // is confirmed to nobody, inviting a repeat that writes a second line.
      const listOps = options.createListOps();

      let result: AddResult;
      try {
        result = await listOps.addItem({
          query,
          quantity,
          ...(weight === undefined ? {} : { weight }),
        });
      } catch (error) {
        // Nothing in the catalog matched. Rather than a dead end, write the request down
        // as a plain line — exactly what H-E-B's own `Add "…" to list` button does. A line
        // saying what you asked for beats no line at all, and this is the one failure a
        // shopper can still act on in the aisle.
        if (!hasCode(error, 'PRODUCT_NOT_FOUND') || refusesWithZero) throw error;

        // Deliberately the *spoken* phrase, not the parsed `query`. Nothing resolved it, so
        // there is no product name to prefer — and the stripped parts are exactly the ones
        // worth keeping here: "two avocados" and "two pounds of brisket" must survive as
        // written, or the line understates the order.
        const written = await listOps.addItem({ text: spoken.trim() });
        // `already_present` is a *success*: HEB merges a duplicate written line into the
        // existing one and increments it (verified against the live list). Rethrowing the
        // catalog miss here would report a failure for a write that committed, and the
        // user would repeat it — merging yet another unit.
        if (written.status === 'needs_confirmation') throw error; // unreachable for text
        return confirmWritten(input, written.item, written.status === 'already_present');
      }

      if (result.status === 'added') {
        return confirmAdded(input, result.item, false, result.quantityRequested, result.weightRequested);
      }
      if (result.status === 'already_present') {
        return confirmAdded(input, result.item, true, result.quantityRequested, result.weightRequested);
      }

      const pending: PendingChoice = {
        kind: 'add',
        spokenQuery: query,
        quantity,
        ...(weight === undefined ? {} : { weight }),
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
        ...(pending.weight === undefined ? {} : { weight: pending.weight }),
      });
      if (result.status === 'needs_confirmation') {
        return giveUp(input, pending); // unreachable via productId, but never guess
      }
      return confirmAdded(
        input,
        result.item,
        result.status === 'already_present',
        result.quantityRequested,
        result.weightRequested,
      );
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
    'My H-E-B login has expired. Someone needs to run the login tool on the computer, and ' +
    'then upload the new session, before I can reach your list again.',
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
        // AMBIGUOUS_LIST covers both "several lists" and "none at all", and the remedies
        // are opposites. Telling someone with no lists to pick one is advice they cannot
        // act on, so branch on the count the error carries.
        if (error.code === 'AMBIGUOUS_LIST' && error.details?.['listCount'] === 0) {
          console.error('HebError AMBIGUOUS_LIST (no lists)');
          return input.responseBuilder
            .speak(
              'You do not have an H-E-B shopping list yet. Create one in the H-E-B app, ' +
                'then ask me again.',
            )
            .withShouldEndSession(true)
            .getResponse();
        }
        // The CODE only. Not the message, and not `details`: PRODUCT_NOT_FOUND embeds the
        // spoken grocery query and AMBIGUOUS_LIST embeds list names, so logging either
        // would retain a household's shopping in CloudWatch indefinitely.
        console.error(`HebError ${error.code}`);

        // Schema drift is permanent until someone changes the code, and takes priority over
        // `partialAdd` when both are set: suggesting a retry or "check the quantity" makes a
        // broken integration look transient, and the log line — a bare code — gives no hint
        // either, so an Alexa-only deployment could stay broken for weeks.
        if (error.details?.['schemaDrift'] === true) {
          console.error('HebError UPSTREAM_ERROR (schema drift — operations.ts needs updating)');
          return input.responseBuilder
            .speak(
              'H-E-B has changed something on their side, and I cannot reach your list ' +
                'until this skill is updated. Retrying will not help.',
            )
            .withShouldEndSession(true)
            .getResponse();
        }

        // Keyed on the specific marker, not on "non-retryable UPSTREAM_ERROR" — plenty of
        // other failures are non-retryable (a refused removal, schema drift on a read),
        // and telling someone their item was added when nothing was added is worse than
        // the generic apology. The core sets `partialAdd` only where a line really exists.
        if (error.details?.['partialAdd'] === true) {
          // Both facts, when both apply. The login remedy on its own invites repeating the
          // whole request, and the item is already on the list — so the repeat adds more.
          const speech =
            error.code === 'SESSION_EXPIRED'
              ? 'The item is on your list, but my H-E-B login expired before I could set ' +
                'the amount. Someone needs to run the login tool. Do not ask me again ' +
                'afterwards — the item is already there; just fix the amount in the app.'
              : 'That went through only partly — the item is on your list, but H-E-B would ' +
                'not set the amount. Please check the quantity in the H-E-B app.';
          return input.responseBuilder.speak(speech).withShouldEndSession(true).getResponse();
        }

        // Indeterminate: the write may well have landed and the confirming read failed
        // too. "Please try again" is the one response that can make it worse, because the
        // retry finds the committed line and increments it — so say what is unknown.
        if (error.details?.['indeterminate'] === true) {
          return input.responseBuilder
            .speak(
              'I could not confirm whether that worked. Please check your list before ' +
                'asking again, so we do not add it twice.',
            )
            .withShouldEndSession(true)
            .getResponse();
        }

        // A definitive refusal, not a transient failure: H-E-B looked at this exact request
        // and said no. The generic UPSTREAM_ERROR copy invites a retry that will refuse the
        // same way again.
        if (error.details?.['rejected'] === true) {
          // Only a weight/quantity update is actually "setting an amount" — an initial add
          // wrote nothing, and a removal targets a line that still exists, so those get
          // wording that matches what was actually attempted.
          const attempted = error.details['attempted'];
          const speech =
            attempted === 'change the weight' || attempted === 'change the quantity'
              ? 'H-E-B would not set that amount. Please check the quantity in the H-E-B app.'
              : 'H-E-B would not make that change. Please check your list in the H-E-B app.';
          return input.responseBuilder.speak(speech).withShouldEndSession(true).getResponse();
        }

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
  // Not `withSkillId`, which accepts only one. Same check, same failure mode — an
  // unrecognised application id aborts before any handler runs and before the session
  // cookies are touched.
  const allowed = new Set(options.skillIds ?? []);
  if (allowed.size > 0) {
    builder.addRequestInterceptors({
      process(input: HandlerInput): void {
        const seen =
          input.requestEnvelope.context?.System?.application?.applicationId ??
          input.requestEnvelope.session?.application?.applicationId;
        if (seen === undefined || !allowed.has(seen)) {
          // The rejected id is deliberately not logged: it is an identifier belonging to
          // whoever called, and this line would be the one place a probe could confirm a
          // guess from CloudWatch. The count is enough to diagnose a misconfiguration.
          throw new Error(
            `Alexa request rejected: application id is not one of the ${allowed.size} configured skill(s).`,
          );
        }
      },
    });
  }
  return builder.create();
}

export { speakableJoin };
