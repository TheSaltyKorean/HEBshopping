/**
 * Conversation tests: drive the skill exactly as Alexa would.
 *
 * These build real request envelopes and feed them through the real `Skill` object, so
 * routing, handler precedence, and session-attribute round-tripping are all exercised —
 * not just the handler bodies. No AWS, no network, no Echo.
 *
 * Session attributes are threaded between turns by hand, which is precisely what Alexa
 * does, and is the only way a multi-turn bug would show up.
 */

import { describe, expect, it, vi } from 'vitest';
import { HebError, type AddResult, type HebList, type LineMatch, type ListItem } from '@heb/core';
import type { HebListOps } from '@heb/core';
import { createSkill } from './skill.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const product = (id: string, name: string) => ({ id, name });

const line = (lineId: string, id: string, name: string, quantity = 1): ListItem => ({
  lineId,
  product: product(id, name),
  text: name,
  quantity,
});

const SAUCES = [
  product('798642', 'Hatch Medium Green Chile with Roasted Garlic Enchilada Sauce, 15 oz'),
  product('140900', 'Old El Paso Mild Green Chile Enchilada Sauce, 10 oz'),
  product('8764017', 'H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz'),
];

/** Only the methods the skill actually calls; the rest would be dead weight. */
type FakeOps = Pick<HebListOps, 'addItem' | 'getList' | 'removeItem' | 'rankLines'>;

function fakeOps(overrides: Partial<FakeOps> = {}): FakeOps {
  return {
    addItem: vi.fn(async (): Promise<AddResult> => ({ status: 'added', item: line('l1', '1', 'Milk') })),
    getList: vi.fn(async (): Promise<HebList> => ({ listId: 'L', name: 'Shopping', storeId: '1', items: [] })),
    removeItem: vi.fn(async () => {}),
    rankLines: vi.fn(async (): Promise<LineMatch[]> => []),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Envelope plumbing
// ---------------------------------------------------------------------------

type Attributes = Record<string, unknown>;

function envelope(request: object, sessionAttributes: Attributes): object {
  return {
    version: '1.0',
    session: { new: false, sessionId: 's', application: { applicationId: 'amzn1.ask.skill.test' }, attributes: sessionAttributes, user: { userId: 'u' } },
    context: { System: { application: { applicationId: 'amzn1.ask.skill.test' }, user: { userId: 'u' } } },
    request,
  };
}

const intent = (name: string, slots: Record<string, string> = {}): object => ({
  type: 'IntentRequest',
  requestId: 'r',
  timestamp: new Date(0).toISOString(),
  locale: 'en-US',
  intent: {
    name,
    confirmationStatus: 'NONE',
    slots: Object.fromEntries(
      Object.entries(slots).map(([key, value]) => [key, { name: key, value, confirmationStatus: 'NONE' }]),
    ),
  },
});

interface Turn {
  speech: string;
  card: string | null;
  ended: boolean;
  attributes: Attributes;
}

/** A conversation that carries session attributes forward, exactly as Alexa does. */
function conversation(ops: FakeOps) {
  const skill = createSkill({ createListOps: () => ops as unknown as HebListOps });
  let attributes: Attributes = {};

  return async function say(request: object): Promise<Turn> {
    const response = (await skill.invoke(envelope(request, attributes) as never, {} as never)) as {
      sessionAttributes?: Attributes;
      response: {
        outputSpeech?: { ssml?: string };
        card?: { content?: string };
        shouldEndSession?: boolean;
      };
    };

    attributes = response.sessionAttributes ?? {};
    return {
      speech: (response.response.outputSpeech?.ssml ?? '').replace(/<\/?speak>/g, '').trim(),
      card: response.response.card?.content ?? null,
      ended: response.response.shouldEndSession === true,
      attributes,
    };
  };
}

// ---------------------------------------------------------------------------

describe('adding — the confident path', () => {
  it('confirms using the resolved product name, not what was said', async () => {
    const ops = fakeOps({
      addItem: vi.fn(async () => ({
        status: 'added' as const,
        item: line('l1', '8764017', 'H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz'),
      })),
    });
    const say = conversation(ops);

    const turn = await say(intent('AddItemIntent', { item: 'green chili enchilada sauce' }));

    // The whole point of the dialog is that request and result can differ; echoing the
    // request back would hide exactly the mistake the user needs to catch.
    expect(turn.speech).toContain('Salsa Verde');
    // The category word must survive shortening, or the confirmation identifies nothing.
    expect(turn.speech).toContain('Enchiladas');
    expect(turn.speech).not.toContain('green chili');
    expect(turn.ended).toBe(false);
  });

  it('parses a spoken count out of the phrase', async () => {
    const ops = fakeOps();
    const say = conversation(ops);
    await say(intent('AddItemIntent', { item: 'two avocados' }));

    expect(ops.addItem).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2, query: 'avocados' }));
  });

  it('does not read "two percent milk" as two milks', async () => {
    const ops = fakeOps();
    const say = conversation(ops);
    await say(intent('AddItemIntent', { item: 'two percent milk' }));

    expect(ops.addItem).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
  });

  it('reports an increment rather than claiming a fresh add', async () => {
    const ops = fakeOps({
      addItem: vi.fn(async () => ({
        status: 'already_present' as const,
        item: line('l1', '1', 'Oatly The Original Oat Milk, 1/2 gal', 3),
      })),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'oat milk' }));

    expect(turn.speech).toContain('already on your list');
    expect(turn.speech).toContain('3');
  });

  it('asks what to add when the slot is empty', async () => {
    const ops = fakeOps();
    const turn = await conversation(ops)(intent('AddItemIntent', { item: '' }));

    expect(turn.speech).toContain('What would you like to add');
    expect(ops.addItem).not.toHaveBeenCalled();
  });
});

describe('adding — the confirmation dialog', () => {
  const ambiguous = () =>
    fakeOps({
      addItem: vi.fn(async (input: { productId?: string }) =>
        input.productId === undefined
          ? {
              status: 'needs_confirmation' as const,
              match: { product: SAUCES[0]!, confidence: 0.55, alternatives: [SAUCES[1]!, SAUCES[2]!] },
            }
          : { status: 'added' as const, item: line('l9', input.productId, 'H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz') },
      ),
    });

  it('offers one candidate at a time and writes nothing yet', async () => {
    const ops = ambiguous();
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'green chili enchilada sauce' }));

    expect(turn.speech).toMatch(/^Did you mean /);
    // One question, one product — reading three long names aloud is unusable.
    expect(turn.speech).toContain('Hatch');
    expect(turn.speech).not.toContain('Old El Paso');
    expect(turn.ended).toBe(false);
  });

  it('walks to the next candidate on "no", and adds the one accepted', async () => {
    const ops = ambiguous();
    const say = conversation(ops);

    await say(intent('AddItemIntent', { item: 'green chili enchilada sauce' }));
    const second = await say(intent('AMAZON.NoIntent'));
    expect(second.speech).toContain('Old El Paso');

    const third = await say(intent('AMAZON.NoIntent'));
    expect(third.speech).toContain('Mi Tienda');

    const done = await say(intent('AMAZON.YesIntent'));
    expect(done.speech).toContain('Added');
    // "Yes" must add the offer on the table — the third one — not the original best guess.
    expect(ops.addItem).toHaveBeenLastCalledWith(expect.objectContaining({ productId: '8764017' }));
  });

  it('gives up after three offers and puts the choices on a card', async () => {
    const ops = ambiguous();
    const say = conversation(ops);

    await say(intent('AddItemIntent', { item: 'green chili enchilada sauce' }));
    await say(intent('AMAZON.NoIntent'));
    await say(intent('AMAZON.NoIntent'));
    const surrender = await say(intent('AMAZON.NoIntent'));

    expect(surrender.speech).toContain('could not tell which one');
    // The escape hatch: voice cannot show a list, so the app can.
    expect(surrender.card).toContain('Mi Tienda');
    expect(surrender.card).toContain('Hatch');
    expect(ops.addItem).toHaveBeenCalledTimes(1); // the initial search only; nothing written
  });

  it('forgets the pending question once answered', async () => {
    const ops = ambiguous();
    const say = conversation(ops);

    await say(intent('AddItemIntent', { item: 'green chili enchilada sauce' }));
    const done = await say(intent('AMAZON.YesIntent'));

    // A stale pending choice would make a later unrelated "yes" add something at random.
    expect(done.attributes['pendingChoice']).toBeUndefined();
  });

  it('treats a bare "yes" with nothing pending as unhandled rather than adding something', async () => {
    const ops = ambiguous();
    const turn = await conversation(ops)(intent('AMAZON.YesIntent'));

    expect(ops.addItem).not.toHaveBeenCalled();
    expect(turn.speech).toContain('went wrong');
  });
});

describe('reading the list', () => {
  it('reads a short list in full', async () => {
    const ops = fakeOps({
      getList: vi.fn(async () => ({
        listId: 'L',
        name: 'Shopping',
        storeId: '1',
        items: [line('a', '1', 'Oatly The Original Oat Milk, 1/2 gal'), line('b', '2', 'Fresh Bananas', 2)],
      })),
    });
    const turn = await conversation(ops)(intent('ReadListIntent'));

    expect(turn.speech).toContain('2 items');
    expect(turn.speech).toContain('Oatly');
    expect(turn.speech).toContain('2 Fresh Bananas');
  });

  it('caps a long list and defers the rest to the card', async () => {
    const items = Array.from({ length: 20 }, (_, i) => line(`l${i}`, `${i}`, `Product Number ${i}`));
    const ops = fakeOps({
      getList: vi.fn(async () => ({ listId: 'L', name: 'Shopping', storeId: '1', items })),
    });
    const turn = await conversation(ops)(intent('ReadListIntent'));

    expect(turn.speech).toContain('20 items');
    expect(turn.speech).toContain('Alexa app');
    expect(turn.speech).not.toContain('Product Number 19');
    expect(turn.card).toContain('Product Number 19'); // nothing is hidden, just not spoken
  });

  it('says so plainly when the list is empty', async () => {
    const turn = await conversation(fakeOps())(intent('ReadListIntent'));
    expect(turn.speech).toContain('empty');
    expect(turn.card).toBeNull();
  });
});

describe('removing', () => {
  it('removes outright when one line clearly matches', async () => {
    const item = line('line-7', '1', 'Oatly The Original Oat Milk, 1/2 gal');
    const ops = fakeOps({ rankLines: vi.fn(async () => [{ item, confident: true }]) });
    const turn = await conversation(ops)(intent('RemoveItemIntent', { item: 'oat milk' }));

    expect(ops.removeItem).toHaveBeenCalledWith({ lineId: 'line-7' });
    expect(turn.speech).toContain('Removed');
  });

  it('confirms first when several lines match, and removes the accepted one', async () => {
    const ops = fakeOps({
      rankLines: vi.fn(async () => [
        { item: line('line-1', '1', 'H-E-B Whole Milk, 1 gal'), confident: false },
        { item: line('line-2', '2', 'H-E-B 2% Reduced Fat Milk, 1 gal'), confident: false },
      ]),
    });
    const say = conversation(ops);

    const asked = await say(intent('RemoveItemIntent', { item: 'milk' }));
    expect(asked.speech).toMatch(/^Did you mean /);
    expect(ops.removeItem).not.toHaveBeenCalled();

    await say(intent('AMAZON.NoIntent'));
    await say(intent('AMAZON.YesIntent'));
    expect(ops.removeItem).toHaveBeenCalledWith({ lineId: 'line-2' });
  });

  it('says so when nothing on the list matches', async () => {
    const ops = fakeOps({ rankLines: vi.fn(async () => []) });
    const turn = await conversation(ops)(intent('RemoveItemIntent', { item: 'motorcycle tyres' }));

    expect(turn.speech).toContain('could not find');
    expect(ops.removeItem).not.toHaveBeenCalled();
  });
});

describe('errors speak an action, not a stack trace', () => {
  it.each([
    ['SESSION_EXPIRED', /login/i],
    ['PRODUCT_NOT_FOUND', /could not find/i],
    ['UPSTREAM_ERROR', /not responding/i],
    ['BOT_CHALLENGE', /robot/i],
  ] as const)('%s', async (code, expected) => {
    const ops = fakeOps({
      addItem: vi.fn(async () => {
        throw new HebError(code, 'internal detail that must not be spoken');
      }),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'oat milk' }));

    expect(turn.speech).toMatch(expected);
    expect(turn.speech).not.toContain('internal detail');
    expect(turn.ended).toBe(true);
  });
});

describe('built-in intents', () => {
  it('opens with an orientation rather than silence', async () => {
    const turn = await conversation(fakeOps())({ type: 'LaunchRequest', requestId: 'r', timestamp: new Date(0).toISOString(), locale: 'en-US' });
    expect(turn.speech).toContain('H-E-B list');
    expect(turn.ended).toBe(false);
  });

  it('help names the three things it can do', async () => {
    const turn = await conversation(fakeOps())(intent('AMAZON.HelpIntent'));
    expect(turn.speech).toMatch(/add/i);
    expect(turn.speech).toMatch(/list/i);
    expect(turn.speech).toMatch(/remove/i);
  });

  it('stop ends the session', async () => {
    const turn = await conversation(fakeOps())(intent('AMAZON.StopIntent'));
    expect(turn.ended).toBe(true);
  });

  it('a bare "no" with nothing pending ends politely instead of erroring', async () => {
    const turn = await conversation(fakeOps())(intent('AMAZON.NoIntent'));
    expect(turn.ended).toBe(true);
    expect(turn.speech).toContain('Okay');
  });

  it('fallback re-orients instead of dropping the session', async () => {
    const turn = await conversation(fakeOps())(intent('AMAZON.FallbackIntent'));
    expect(turn.speech).toContain('did not catch');
    expect(turn.ended).toBe(false);
  });
});

describe('stale confirmation state cannot be answered later', () => {
  const ambiguousRemoval = () =>
    fakeOps({
      rankLines: vi.fn(async () => [
        { item: line('line-1', '1', 'H-E-B Whole Milk, 1 gal'), confident: false },
        { item: line('line-2', '2', 'H-E-B 2% Reduced Fat Milk, 1 gal'), confident: false },
      ]),
    });

  it('drops the pending question when another intent takes over', async () => {
    const ops = ambiguousRemoval();
    const say = conversation(ops);

    await say(intent('RemoveItemIntent', { item: 'milk' }));
    const listed = await say(intent('ReadListIntent'));
    expect(listed.attributes['pendingChoice']).toBeUndefined();

    // Without this, "yes" would delete the line offered two turns ago, for a question the
    // user is no longer being asked.
    await say(intent('AMAZON.YesIntent'));
    expect(ops.removeItem).not.toHaveBeenCalled();
  });

  it('keeps the question across a misheard utterance and re-asks it', async () => {
    const ops = ambiguousRemoval();
    const say = conversation(ops);

    const asked = await say(intent('RemoveItemIntent', { item: 'milk' }));
    const fallback = await say(intent('AMAZON.FallbackIntent'));

    // A misrecognition should not cost the dialog — but it must re-ask, so a later "yes"
    // is answering a question that was actually posed.
    expect(fallback.speech).toBe(asked.speech);

    await say(intent('AMAZON.YesIntent'));
    expect(ops.removeItem).toHaveBeenCalledWith({ lineId: 'line-1' });
  });
});

describe('the give-up card shows more than what was rejected', () => {
  it('keeps candidates beyond the three that were spoken', async () => {
    const many = Array.from({ length: 5 }, (_, i) => product(`${i}`, `Candidate Number ${i} Sauce`));
    const ops = fakeOps({
      addItem: vi.fn(async () => ({
        status: 'needs_confirmation' as const,
        match: { product: many[0]!, confidence: 0.55, alternatives: many.slice(1) },
      })),
    });
    const say = conversation(ops);

    await say(intent('AddItemIntent', { item: 'sauce' }));
    await say(intent('AMAZON.NoIntent'));
    await say(intent('AMAZON.NoIntent'));
    const surrender = await say(intent('AMAZON.NoIntent'));

    // MAX_OFFERS caps spoken questions, not candidates: the card exists to show the ones
    // there was no time to say.
    expect(surrender.card).toContain('Candidate Number 4');
  });
});

describe('speech is valid SSML', () => {
  it('escapes an ampersand in a product name', async () => {
    const ops = fakeOps({
      addItem: vi.fn(async () => ({
        status: 'added' as const,
        item: line('l1', '1', 'H-E-B Half & Half, 32 oz'),
      })),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'half and half' }));

    // A raw & makes the SSML invalid and the response fails to speak at all.
    expect(turn.speech).toContain('&amp;');
    expect(turn.speech).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('indeterminate writes must not invite a retry', () => {
  it('tells the user to check the list rather than repeat the command', async () => {
    // The write may well have landed and only the confirming read failed. "Try again" is
    // the one answer that compounds it: the retry finds the committed line and increments.
    const ops = fakeOps({
      addItem: vi.fn(async () => {
        throw new HebError('UPSTREAM_ERROR', 'HEB did not confirm the add.', {
          retryable: false,
          details: { indeterminate: true },
        });
      }),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'oat milk' }));

    expect(turn.speech).toMatch(/could not confirm/i);
    expect(turn.speech).not.toMatch(/try again/i);
  });

  it('still says try again for an ordinary upstream failure', async () => {
    const ops = fakeOps({
      addItem: vi.fn(async () => {
        throw new HebError('UPSTREAM_ERROR', 'HEB is down.', { retryable: true });
      }),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'oat milk' }));
    expect(turn.speech).toMatch(/try again/i);
  });
});

// ---------------------------------------------------------------------------

describe('adding — the free-text fallback', () => {
  it('writes the request down when nothing in the catalog matches', async () => {
    const addItem = vi.fn(async (input: { query?: string; text?: string }): Promise<AddResult> => {
      if (input.text === undefined) {
        throw new HebError('PRODUCT_NOT_FOUND', 'No product matched "sourdough starter".');
      }
      return {
        status: 'added',
        item: { lineId: 'l9', text: input.text, quantity: 1 },
      };
    });
    const say = conversation(fakeOps({ addItem: addItem as unknown as FakeOps['addItem'] }));

    const turn = await say(intent('AddItemIntent', { item: 'sourdough starter' }));

    // Both halves out loud: that the search failed, and what was written instead. Saying
    // only "added" would hide that no scannable product is attached to the line.
    expect(turn.speech).toContain('could not find');
    expect(turn.speech).toContain('sourdough starter');
    expect(turn.ended).toBe(false);
    expect(addItem).toHaveBeenCalledTimes(2);
  });

  it('writes the phrase as spoken, keeping the amount', async () => {
    // The parsed query drops "two pounds of" — right for a catalog search, wrong here.
    // Nothing resolved it, so the written line has to carry the whole order.
    const addItem = vi.fn(async (input: { query?: string; text?: string }): Promise<AddResult> => {
      if (input.text === undefined) throw new HebError('PRODUCT_NOT_FOUND', 'no match');
      return { status: 'added', item: { lineId: 'l9', text: input.text, quantity: 1 } };
    });
    const say = conversation(fakeOps({ addItem: addItem as unknown as FakeOps['addItem'] }));

    await say(intent('AddItemIntent', { item: 'two pounds of goat barbacoa' }));

    expect(addItem).toHaveBeenLastCalledWith({ text: 'two pounds of goat barbacoa' });
  });

  it('reuses one list client, so the fallback cannot reset the invocation budget', async () => {
    // `createListOps` builds a fresh HebClient with a fresh 6.5s budget. Calling it twice
    // lets a slow search plus a fallback add run past Alexa's ~8s ceiling, and a mutation
    // that commits at the cutoff is confirmed to nobody — inviting a repeat that writes a
    // second line.
    const ops = fakeOps({
      addItem: vi.fn(async (input: { text?: string }) => {
        if (input.text === undefined) throw new HebError('PRODUCT_NOT_FOUND', 'no match');
        return { status: 'added' as const, item: { lineId: 'l9', text: input.text, quantity: 1 } };
      }) as unknown as FakeOps['addItem'],
    });
    const createListOps = vi.fn(() => ops as unknown as HebListOps);
    const skill = createSkill({ createListOps });

    await skill.invoke(
      envelope(intent('AddItemIntent', { item: 'sourdough starter' }), {}) as never,
      {} as never,
    );

    expect(ops.addItem).toHaveBeenCalledTimes(2);
    expect(createListOps).toHaveBeenCalledTimes(1);
  });

  it('does not swallow other failures', async () => {
    // Only PRODUCT_NOT_FOUND is recoverable this way. An expired session must still reach
    // the error handler, or the user is told a line was written when none was.
    const addItem = vi.fn(async () => {
      throw new HebError('SESSION_EXPIRED', 'cookies dead');
    });
    const say = conversation(fakeOps({ addItem: addItem as unknown as FakeOps['addItem'] }));

    const turn = await say(intent('AddItemIntent', { item: 'milk' }));

    expect(turn.speech).toContain('expired');
    expect(addItem).toHaveBeenCalledTimes(1);
  });
});

describe('skill id verification', () => {
  const ask = async (skillIds: string[], applicationId: string, ops = fakeOps()) => {
    const skill = createSkill({
      createListOps: () => ops as unknown as HebListOps,
      skillIds,
    });
    const request = intent('AddItemIntent', { item: 'milk' });
    const envelopeWithId = {
      version: '1.0',
      session: { new: false, sessionId: 's', application: { applicationId }, attributes: {}, user: { userId: 'u' } },
      context: { System: { application: { applicationId }, user: { userId: 'u' } } },
      request,
    };
    return (await skill.invoke(envelopeWithId as never, {} as never)) as {
      response: { outputSpeech?: { ssml?: string } };
    };
  };

  // Deliberately not UUID-shaped: a real skill id is an account identifier, and
  // `npm run scan` rightly refuses to let one near a committed file. The check is exact
  // string matching, so the shape is irrelevant to what these prove.
  const ID_A = 'amzn1.ask.skill.test-alpha';
  const ID_B = 'amzn1.ask.skill.test-beta';

  it('accepts every configured skill, so two invocation names share one Lambda', async () => {
    for (const id of [ID_A, ID_B]) {
      const response = await ask([ID_A, ID_B], id);
      expect(response.response.outputSpeech?.ssml).toContain('Added');
    }
  });

  it('rejects a skill that is not configured, before the list is touched', async () => {
    // The whole defence: a direct Alexa trigger carries no signature, so anyone who learns
    // this function's ARN could point their own skill at it. Asserting on `addItem` rather
    // than on the speech is the part that matters — a rejection that still reached HEB
    // would leak the list through timing and through the write itself.
    const ops = fakeOps();
    const response = await ask([ID_A], ID_B, ops);
    expect(ops.addItem).not.toHaveBeenCalled();
    expect(response.response.outputSpeech?.ssml).not.toContain('Added');
  });

  it('does not leak the rejected id into the message', async () => {
    const response = await ask([ID_A], ID_B);
    expect(response.response.outputSpeech?.ssml ?? '').not.toContain(ID_B);
  });
});
