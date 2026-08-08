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
import { readPending } from './state.js';

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

  it('explains an ignored count on a counter item as sold-by-the-pound, not a server cap', async () => {
    // `HebListOps` sets `quantityRequested` on a weight-priced line to surface a count it
    // never attempted to apply — the row's own quantity stays 1 regardless of what was
    // asked for. That is not the server refusing to raise a ceiling, and must not be worded
    // as one ("H-E-B only allows 1 ... could not bring it up to 3").
    const ops = fakeOps({
      addItem: vi.fn(async () => ({
        status: 'added' as const,
        item: { ...line('l1', '1', 'Sliced Turkey'), weight: 1 },
        quantityRequested: 3,
      })),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'three sliced turkeys' }));

    expect(turn.speech).toContain('sold by the pound');
    expect(turn.speech).not.toContain('only allows');
  });

  it('does not claim a package was added when a packaged item is already at its ceiling', async () => {
    // `HebListOps` returns this early, before ever issuing the add mutation — the ceiling
    // blocked it outright, so nothing was written. The "sold by the package ... added one
    // instead" wording is for a real add that skipped the pounds in favor of a package; it
    // must not fire alongside "only allows N", which says nothing was added at all.
    const existing = line('l1', '1', 'Sliced Turkey Lunch Meat, 16 oz', 20);
    const ops = fakeOps({
      addItem: vi.fn(async () => ({
        status: 'already_present' as const,
        item: { ...existing, maximumQuantity: 20 },
        quantityRequested: 21,
        weightRequested: 2,
      })),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'two pounds of sliced turkey lunch meat' }));

    expect(turn.speech).toContain('only allows');
    expect(turn.speech).not.toContain('added one instead');
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

  describe('on a device with a screen', () => {
    const items = Array.from({ length: 20 }, (_, i) => line(`l${i}`, `${i}`, `Product Number ${i}`));
    const listOf = (n: number) => ({
      listId: 'L',
      name: 'Shopping',
      storeId: '1',
      items: items.slice(0, n),
    });

    const readOn = async (device: object | undefined, count: number) => {
      const skill = createSkill({
        createListOps: () => fakeOps({ getList: vi.fn(async () => listOf(count)) }) as never,
        skillIds: ['amzn1.ask.skill.test'],
      });
      const response = (await skill.invoke(
        {
          version: '1.0',
          session: {
            new: true,
            sessionId: 's',
            application: { applicationId: 'amzn1.ask.skill.test' },
            attributes: {},
            user: { userId: 'u' },
          },
          context: {
            System: {
              application: { applicationId: 'amzn1.ask.skill.test' },
              user: { userId: 'u' },
              ...(device === undefined ? {} : { device }),
            },
          },
          request: intent('ReadListIntent'),
        } as never,
        {} as never,
      )) as { response: { directives?: Array<{ type: string; datasources?: unknown }> } };
      return response.response.directives ?? [];
    };

    const showDevice = { supportedInterfaces: { 'Alexa.Presentation.APL': {} } };

    it('sends no directive to a speaker', async () => {
      // A directive naming an unsupported interface makes Alexa reject the whole response,
      // so the plain-Echo path has to stay byte-for-byte what it was.
      expect(await readOn(undefined, 3)).toHaveLength(0);
    });

    it('renders the list on a Show', async () => {
      const directives = await readOn(showDevice, 3);
      expect(directives.map((d) => d.type)).toContain('Alexa.Presentation.APL.RenderDocument');
    });

    it('renders the list on launch, so opening the skill is enough to see it', async () => {
      // "Open heb shopper skill" on a Show used to answer with a menu of things you could
      // ask for, next to a screen that could simply have shown the list.
      const skill = createSkill({
        createListOps: () => fakeOps({ getList: vi.fn(async () => listOf(4)) }) as never,
        skillIds: ['amzn1.ask.skill.test'],
      });
      const response = (await skill.invoke(
        {
          version: '1.0',
          session: {
            new: true,
            sessionId: 's',
            application: { applicationId: 'amzn1.ask.skill.test' },
            attributes: {},
            user: { userId: 'u' },
          },
          context: {
            System: {
              application: { applicationId: 'amzn1.ask.skill.test' },
              user: { userId: 'u' },
              device: showDevice,
            },
          },
          request: { type: 'LaunchRequest', requestId: 'r', timestamp: new Date(0).toISOString(), locale: 'en-US' },
        } as never,
        {} as never,
      )) as {
        response: {
          outputSpeech?: { ssml?: string };
          directives?: Array<{ type: string; datasources?: unknown }>;
        };
      };

      expect(response.response.directives?.map((d) => d.type)).toContain(
        'Alexa.Presentation.APL.RenderDocument',
      );
      // Says the count, not the contents — the screen is doing the reading.
      expect(response.response.outputSpeech?.ssml).toContain('4 items');
    });

    it('leaves a speaker launch instant, with no list fetch at all', async () => {
      // Fetching to launch would put a network round trip in front of every "open H-E-B
      // list" and buy nothing audible, since the list still has to be asked for.
      const getList = vi.fn(async () => listOf(4));
      const skill = createSkill({
        createListOps: () => fakeOps({ getList }) as never,
        skillIds: ['amzn1.ask.skill.test'],
      });
      await skill.invoke(
        {
          version: '1.0',
          session: {
            new: true,
            sessionId: 's',
            application: { applicationId: 'amzn1.ask.skill.test' },
            attributes: {},
            user: { userId: 'u' },
          },
          context: {
            System: { application: { applicationId: 'amzn1.ask.skill.test' }, user: { userId: 'u' } },
          },
          request: { type: 'LaunchRequest', requestId: 'r', timestamp: new Date(0).toISOString(), locale: 'en-US' },
        } as never,
        {} as never,
      );

      expect(getList).not.toHaveBeenCalled();
    });

    it('falls back to the instant greeting, not an error, when launch on a Show cannot fetch the list', async () => {
      // Before this handler touched the network, "open H-E-B list" always succeeded
      // instantly on every device. A transient HEB failure must not turn that into a spoken
      // error with the session ended — it should degrade to the same greeting a speaker
      // gets, so a follow-up question can retry the read.
      const skill = createSkill({
        createListOps: () => fakeOps({ getList: vi.fn(async () => { throw new HebError('UPSTREAM_ERROR', 'down'); }) }) as never,
        skillIds: ['amzn1.ask.skill.test'],
      });
      const response = (await skill.invoke(
        {
          version: '1.0',
          session: {
            new: true,
            sessionId: 's',
            application: { applicationId: 'amzn1.ask.skill.test' },
            attributes: {},
            user: { userId: 'u' },
          },
          context: {
            System: {
              application: { applicationId: 'amzn1.ask.skill.test' },
              user: { userId: 'u' },
              device: showDevice,
            },
          },
          request: { type: 'LaunchRequest', requestId: 'r', timestamp: new Date(0).toISOString(), locale: 'en-US' },
        } as never,
        {} as never,
      )) as {
        response: {
          outputSpeech?: { ssml?: string };
          directives?: Array<{ type: string; datasources?: unknown }>;
          shouldEndSession?: boolean;
        };
      };

      expect(response.response.outputSpeech?.ssml).toContain('H-E-B list.');
      expect(response.response.directives ?? []).toHaveLength(0);
      expect(response.response.shouldEndSession).not.toBe(true);
    });

    describe('after a write', () => {
      const invokeOn = async (
        device: object | undefined,
        request: object,
        createListOps: () => unknown,
      ) => {
        const skill = createSkill({
          createListOps: createListOps as never,
          skillIds: ['amzn1.ask.skill.test'],
        });
        return (await skill.invoke(
          {
            version: '1.0',
            session: {
              new: true,
              sessionId: 's',
              application: { applicationId: 'amzn1.ask.skill.test' },
              attributes: {},
              user: { userId: 'u' },
            },
            context: {
              System: {
                application: { applicationId: 'amzn1.ask.skill.test' },
                user: { userId: 'u' },
                ...(device === undefined ? {} : { device }),
              },
            },
            request,
          } as never,
          {} as never,
        )) as {
          response: {
            outputSpeech?: { ssml?: string };
            directives?: Array<{ type: string }>;
          };
        };
      };

      /** Adds succeed; each `getList` returns the post-write list. */
      const opsAfterAdd = (getList: () => Promise<unknown>) => () =>
        fakeOps({
          getList: vi.fn(getList),
          addItem: vi.fn(async () => ({
            status: 'added',
            item: line('new', '9', 'Oat Milk'),
            quantityRequested: 1,
          })),
        }) as never;

      it('redraws the screen, so an add is visible without asking again', async () => {
        const response = await invokeOn(
          showDevice,
          intent('AddItemIntent', { item: 'oat milk' }),
          opsAfterAdd(async () => listOf(5)),
        );
        expect(response.response.outputSpeech?.ssml).toContain('Added');
        expect(response.response.directives?.map((d) => d.type)).toContain(
          'Alexa.Presentation.APL.RenderDocument',
        );
      });

      it('does not redraw on a speaker', async () => {
        const response = await invokeOn(
          undefined,
          intent('AddItemIntent', { item: 'oat milk' }),
          opsAfterAdd(async () => listOf(5)),
        );
        expect(response.response.outputSpeech?.ssml).toContain('Added');
        expect(response.response.directives ?? []).toHaveLength(0);
      });

      it('still confirms the add when the redraw fails', async () => {
        // The write has already committed. Turning a successful add into a spoken error
        // because a cosmetic refresh failed would be strictly worse than a stale screen.
        const response = await invokeOn(
          showDevice,
          intent('AddItemIntent', { item: 'oat milk' }),
          opsAfterAdd(async () => {
            throw new Error('HEB unreachable');
          }),
        );
        expect(response.response.outputSpeech?.ssml).toContain('Added');
        expect(response.response.directives ?? []).toHaveLength(0);
      });

      it('does not redraw when the add only asked a question', async () => {
        // `needs_confirmation` wrote nothing, so a refresh would spend a round trip
        // redrawing the list exactly as it already is.
        const response = await invokeOn(
          showDevice,
          intent('AddItemIntent', { item: 'tortillas' }),
          () =>
            fakeOps({
              getList: vi.fn(async () => listOf(5)),
              addItem: vi.fn(async () => ({
                status: 'needs_confirmation' as const,
                match: { product: SAUCES[0]!, confidence: 0.55, alternatives: [SAUCES[1]!] },
              })),
            }) as never,
        );
        expect(response.response.outputSpeech?.ssml).toContain('Did you mean');
        expect(response.response.directives ?? []).toHaveLength(0);
      });

      it('does not redraw when already_present wrote nothing', async () => {
        // `HebListOps` reports `already_present` with `wrote: false` when it never issued a
        // mutation at all — blocked by the quantity ceiling, or a counter good re-asked with
        // no weight. A refresh here would spend a round trip redrawing a list that never
        // changed.
        const response = await invokeOn(
          showDevice,
          intent('AddItemIntent', { item: 'sliced turkey' }),
          () =>
            fakeOps({
              getList: vi.fn(async () => listOf(5)),
              addItem: vi.fn(async () => ({
                status: 'already_present' as const,
                item: line('l1', '1', 'Sliced Turkey', 1),
                wrote: false,
              })),
            }) as never,
        );
        expect(response.response.outputSpeech?.ssml).toContain('already on your list');
        expect(response.response.directives ?? []).toHaveLength(0);
      });

      it('bounds the refresh by what is left of Alexa\'s deadline, not the Lambda\'s', async () => {
        // A default `createListOps()` call hands the refresh a whole new budget, which can
        // run past Alexa's own ~8s deadline and lose the already-built spoken confirmation
        // along with the screen, even while the Lambda's own looser 10s timeout still shows
        // several seconds left. 3s of Lambda time remaining means 7s has already elapsed
        // (out of the Lambda's 10s), leaving only 1s of Alexa's 8s — minus the safety margin.
        const createListOps = vi.fn(
          (): unknown =>
            fakeOps({
              addItem: vi.fn(async () => ({
                status: 'added' as const,
                item: line('new', '9', 'Oat Milk'),
                quantityRequested: 1,
              })),
              getList: vi.fn(async () => listOf(5)),
            }),
        );
        const skill = createSkill({
          createListOps: createListOps as never,
          skillIds: ['amzn1.ask.skill.test'],
        });

        await skill.invoke(
          {
            version: '1.0',
            session: {
              new: true,
              sessionId: 's',
              application: { applicationId: 'amzn1.ask.skill.test' },
              attributes: {},
              user: { userId: 'u' },
            },
            context: {
              System: {
                application: { applicationId: 'amzn1.ask.skill.test' },
                user: { userId: 'u' },
                device: showDevice,
              },
            },
            request: intent('AddItemIntent', { item: 'oat milk' }),
          } as never,
          { getRemainingTimeInMillis: () => 3_000 } as never,
        );

        expect(createListOps).toHaveBeenCalledTimes(2);
        expect(createListOps).toHaveBeenLastCalledWith(500);
      });

      it('skips the redraw outright when the Lambda has essentially no time left', async () => {
        const createListOps = vi.fn(
          (): unknown =>
            fakeOps({
              addItem: vi.fn(async () => ({
                status: 'added' as const,
                item: line('new', '9', 'Oat Milk'),
                quantityRequested: 1,
              })),
              getList: vi.fn(async () => listOf(5)),
            }),
        );
        const skill = createSkill({
          createListOps: createListOps as never,
          skillIds: ['amzn1.ask.skill.test'],
        });

        const response = (await skill.invoke(
          {
            version: '1.0',
            session: {
              new: true,
              sessionId: 's',
              application: { applicationId: 'amzn1.ask.skill.test' },
              attributes: {},
              user: { userId: 'u' },
            },
            context: {
              System: {
                application: { applicationId: 'amzn1.ask.skill.test' },
                user: { userId: 'u' },
                device: showDevice,
              },
            },
            request: intent('AddItemIntent', { item: 'oat milk' }),
          } as never,
          { getRemainingTimeInMillis: () => 100 } as never,
        )) as { response: { outputSpeech?: { ssml?: string }; directives?: unknown[] } };

        // The spoken confirmation still comes through — only the cosmetic refresh is
        // skipped, exactly like the "redraw fails" case above.
        expect(response.response.outputSpeech?.ssml).toContain('Added');
        expect(response.response.directives ?? []).toHaveLength(0);
        expect(createListOps).toHaveBeenCalledTimes(1);
      });

      it('redraws the screen when a write partially lands before a later step throws', async () => {
        // ask-sdk's dispatcher never runs response interceptors once a handler has thrown —
        // it jumps straight to the error handler — so the one error path where a write
        // really did land (`partialAdd`) has to ask for the redraw itself.
        const response = await invokeOn(
          showDevice,
          intent('AddItemIntent', { item: 'two pounds of ham' }),
          () =>
            fakeOps({
              getList: vi.fn(async () => listOf(5)),
              addItem: vi.fn(async () => {
                throw new HebError('UPSTREAM_ERROR', 'HEB rejected the weight update.', {
                  retryable: false,
                  details: { partialAdd: true },
                });
              }),
            }) as never,
        );
        expect(response.response.outputSpeech?.ssml).toContain('went through only partly');
        expect(response.response.directives?.map((d) => d.type)).toContain(
          'Alexa.Presentation.APL.RenderDocument',
        );
      });

      it('does not redraw a speaker when a write partially lands before a later step throws', async () => {
        const response = await invokeOn(
          undefined,
          intent('AddItemIntent', { item: 'two pounds of ham' }),
          () =>
            fakeOps({
              getList: vi.fn(async () => listOf(5)),
              addItem: vi.fn(async () => {
                throw new HebError('UPSTREAM_ERROR', 'HEB rejected the weight update.', {
                  retryable: false,
                  details: { partialAdd: true },
                });
              }),
            }) as never,
        );
        expect(response.response.outputSpeech?.ssml).toContain('went through only partly');
        expect(response.response.directives ?? []).toHaveLength(0);
      });

      describe('removing', () => {
        const opsAfterRemove = () =>
          fakeOps({
            getList: vi.fn(async () => listOf(5)),
            rankLines: vi.fn(async () => [{ item: line('l1', '1', 'Sliced Turkey'), confident: true }]),
          }) as never;

        it('redraws the screen after an outright remove', async () => {
          const response = await invokeOn(showDevice, intent('RemoveItemIntent', { item: 'turkey' }), opsAfterRemove);
          expect(response.response.outputSpeech?.ssml).toContain('Removed');
          expect(response.response.directives?.map((d) => d.type)).toContain(
            'Alexa.Presentation.APL.RenderDocument',
          );
        });

        it('does not redraw a speaker after an outright remove', async () => {
          const response = await invokeOn(undefined, intent('RemoveItemIntent', { item: 'turkey' }), opsAfterRemove);
          expect(response.response.outputSpeech?.ssml).toContain('Removed');
          expect(response.response.directives ?? []).toHaveLength(0);
        });

        it('redraws the screen after a confirmed remove ("yes" to an ambiguous match)', async () => {
          // A different line than the outright-remove branch above — `yesHandler`'s own
          // `pending.kind === 'remove'` branch calls `markListChanged` too, and needs its
          // own coverage since it is reached by a "yes" after an ambiguous match, not
          // directly by `RemoveItemIntent`.
          const skill = createSkill({
            createListOps: () =>
              fakeOps({
                getList: vi.fn(async () => listOf(5)),
                rankLines: vi.fn(async () => [
                  { item: line('line-1', '1', 'H-E-B Whole Milk, 1 gal'), confident: false },
                  { item: line('line-2', '2', 'H-E-B 2% Reduced Fat Milk, 1 gal'), confident: false },
                ]),
              }) as never,
            skillIds: ['amzn1.ask.skill.test'],
          });
          let attributes: Record<string, unknown> = {};
          const say = async (request: object) => {
            const response = (await skill.invoke(
              {
                version: '1.0',
                session: {
                  new: false,
                  sessionId: 's',
                  application: { applicationId: 'amzn1.ask.skill.test' },
                  attributes,
                  user: { userId: 'u' },
                },
                context: {
                  System: {
                    application: { applicationId: 'amzn1.ask.skill.test' },
                    user: { userId: 'u' },
                    device: showDevice,
                  },
                },
                request,
              } as never,
              {} as never,
            )) as {
              sessionAttributes?: Record<string, unknown>;
              response: { outputSpeech?: { ssml?: string }; directives?: Array<{ type: string }> };
            };
            attributes = response.sessionAttributes ?? {};
            return response;
          };

          await say(intent('RemoveItemIntent', { item: 'milk' }));
          const response = await say(intent('AMAZON.YesIntent'));

          expect(response.response.outputSpeech?.ssml).toContain('Removed');
          expect(response.response.directives?.map((d) => d.type)).toContain(
            'Alexa.Presentation.APL.RenderDocument',
          );
        });
      });
    });

    it('shows every item even when speech had to cap at seven', async () => {
      // The whole point: a Show that says "I've put the whole list in your Alexa app" while
      // displaying nothing is worse than either surface alone.
      const [directive] = await readOn(showDevice, 20);
      const rendered = directive as unknown as {
        datasources: { hebList: { items: unknown[] } };
      };
      expect(rendered.datasources.hebList.items).toHaveLength(20);
    });
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

describe('schema drift alongside a partial write', () => {
  it('mentions the existing line, not just the deployment fix', async () => {
    // `adjustWeight` can propagate both `schemaDrift` and `partialAdd` when the initial add
    // landed but the weight update was rejected. The schema-drift branch used to speak only
    // the "this skill needs updating" copy, dropping the partial-write warning — so once the
    // deployment is fixed, repeating the original request finds the existing line and adds
    // the requested weight on top of H-E-B's default instead of just setting it.
    const ops = fakeOps({
      addItem: vi.fn(async () => {
        throw new HebError('UPSTREAM_ERROR', 'HEB rejected the weight update.', {
          retryable: false,
          details: { schemaDrift: true, partialAdd: true },
        });
      }),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'two pounds of ham' }));

    expect(turn.speech).toMatch(/skill is updated/i);
    expect(turn.speech).toMatch(/already on your list/i);
  });
});

describe('a definitive weight refusal must not invite a retry', () => {
  it('tells the user to check the amount rather than repeat the command', async () => {
    // `adjustWeight` rethrows H-E-B's own refusal with `details.rejected` intact — repeating
    // the same request will refuse the same way again, so the generic UPSTREAM_ERROR copy
    // ("please try again") is the one answer guaranteed not to help.
    const ops = fakeOps({
      addItem: vi.fn(async () => {
        throw new HebError('UPSTREAM_ERROR', 'HEB refused the requested weight.', {
          retryable: false,
          details: { rejected: true, attempted: 'change the weight' },
        });
      }),
    });
    const turn = await conversation(ops)(intent('AddItemIntent', { item: 'two pounds of ham' }));

    expect(turn.speech).toMatch(/would not set that amount/i);
    expect(turn.speech).not.toMatch(/try again/i);
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

  it('asks again for a filler-only request instead of writing it down', async () => {
    // "Add some" parses to an empty query. Falling through reaches PRODUCT_NOT_FOUND and
    // the fallback would write "some" onto the list — a request nobody made, from a
    // sentence that was never finished.
    const ops = fakeOps();
    const say = conversation(ops);

    const turn = await say(intent('AddItemIntent', { item: 'some' }));

    expect(turn.speech).toContain('What would you like to add?');
    expect(ops.addItem).not.toHaveBeenCalled();
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

describe('the free-text fallback and merged lines', () => {
  it('confirms a merged written line instead of reporting the catalog miss', async () => {
    // HEB merges a duplicate written line and increments it, so `already_present` is a
    // success. Rethrowing PRODUCT_NOT_FOUND here would report failure for a write that
    // committed — and the user would repeat it, merging another unit.
    const ops = fakeOps({
      addItem: vi.fn(async (input: { text?: string }) => {
        if (input.text === undefined) throw new HebError('PRODUCT_NOT_FOUND', 'no match');
        return {
          status: 'already_present' as const,
          item: { lineId: 'l9', text: input.text, quantity: 3 },
        };
      }) as unknown as FakeOps['addItem'],
    });
    const say = conversation(ops);

    const turn = await say(intent('AddItemIntent', { item: 'sourdough starter' }));

    expect(turn.speech).toContain('already written');
    expect(turn.speech).toContain('3');
    expect(turn.speech).not.toContain('could not find that at your H-E-B.  Anything');
  });

  it('refuses an oversized spoken weight before it can reach a mutation', async () => {
    // A confident match on "twenty-one pounds of turkey" must never reach `addItem` — the
    // same ceiling the MCP schema and pending-state validator both enforce.
    const ops = fakeOps({
      addItem: vi.fn() as unknown as FakeOps['addItem'],
    });
    const say = conversation(ops);

    const turn = await say(intent('AddItemIntent', { item: '21 pounds of turkey' }));

    expect(turn.speech).toContain('20 pounds');
    expect(ops.addItem).not.toHaveBeenCalled();
  });

  it('refuses to write down a zero-count request', async () => {
    // "Add zero bananas" is a refusal. The catalog search still runs — "zero sugar dr
    // pepper" is a real product — but a miss must not become a written line.
    const ops = fakeOps({
      addItem: vi.fn(async () => {
        throw new HebError('PRODUCT_NOT_FOUND', 'no match');
      }) as unknown as FakeOps['addItem'],
    });
    const say = conversation(ops);

    const turn = await say(intent('AddItemIntent', { item: 'zero bananas' }));

    expect(turn.speech).toContain('could not find');
    expect(ops.addItem).toHaveBeenCalledTimes(1); // searched, never written
  });

  it('still writes down a zero-branded product that the catalog misses', async () => {
    // The zero guard must not swallow ordinary requests that merely contain the word.
    const ops = fakeOps({
      addItem: vi.fn(async (input: { text?: string }) => {
        if (input.text === undefined) throw new HebError('PRODUCT_NOT_FOUND', 'no match');
        return { status: 'added' as const, item: { lineId: 'l9', text: input.text, quantity: 1 } };
      }) as unknown as FakeOps['addItem'],
    });
    const say = conversation(ops);

    const turn = await say(intent('AddItemIntent', { item: 'dr pepper zero sugar' }));

    expect(turn.speech).toContain('wrote');
    expect(ops.addItem).toHaveBeenCalledTimes(2);
  });
});

describe('malformed pending state reads as no pending question', () => {
  // Session attributes survive a round trip as plain JSON, so nothing about their shape is
  // guaranteed. A bad index passed validation and then made the yes/no handlers assert on
  // an offer that does not exist — throwing mid-dialog instead of letting the user start
  // over, which is exactly what validating here is supposed to prevent.
  const pendingWith = (index: unknown): Record<string, unknown> => ({
    pendingChoice: {
      kind: 'add',
      spokenQuery: 'milk',
      quantity: 1,
      offers: [{ productId: 'p1', spoken: 'Milk', full: 'H-E-B Milk' }],
      index,
    },
  });

  const read = (attributes: Record<string, unknown>) =>
    readPending({
      attributesManager: { getSessionAttributes: () => attributes },
    } as unknown as Parameters<typeof readPending>[0]);

  for (const [label, index] of [
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['past the end', 9],
    ['a string', 'first'],
  ] as Array<[string, unknown]>) {
    it(`treats a ${label} index as no pending question`, () => {
      expect(read(pendingWith(index))).toBeNull();
    });
  }

  it('still accepts a valid index', () => {
    expect(read(pendingWith(0))).not.toBeNull();
  });
});

describe('a count above the ceiling is refused out loud', () => {
  // The failure being avoided is silent: "21 bananas" still resolves to bananas, so simply
  // dropping the count confirms the right product and adds one. `addRemainingUnits` issues
  // one live mutation per unit, so acting on it is not an option either.
  it('says so and writes nothing', async () => {
    const ops = fakeOps();
    const turn = await conversation(ops)(intent('AddItemIntent', { item: '50 bananas' }));

    expect(ops.addItem).not.toHaveBeenCalled();
    expect(turn.speech).toContain('20');
    expect(turn.speech).toContain('50');
  });

  it('leaves ordinary counts alone', async () => {
    const ops = fakeOps();
    await conversation(ops)(intent('AddItemIntent', { item: 'two avocados' }));

    expect(ops.addItem).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2 }));
  });
});

describe('pending state whose kind and offer disagree', () => {
  // Shape and `kind` can both look right while the two contradict each other. `kind` picks
  // which mutation "yes" runs, so an offer that carries the *other* kind's id routes the
  // answer into the wrong call — removal with `lineId: undefined`, or an add with no
  // product. Either throws mid-dialog instead of reading as "no pending question".
  const read = (pendingChoice: unknown) =>
    readPending({
      attributesManager: { getSessionAttributes: () => ({ pendingChoice }) },
    } as unknown as Parameters<typeof readPending>[0]);

  const pending = (kind: unknown, offer: unknown) => ({
    kind,
    spokenQuery: 'milk',
    quantity: 1,
    offers: [offer],
    index: 0,
  });

  const addOffer = { productId: 'p1', spoken: 'Milk', full: 'H-E-B Milk' };
  const removeOffer = { lineId: 'l1', spoken: 'Milk', full: 'H-E-B Milk' };

  it('rejects a removal offering only a productId', () => {
    expect(read(pending('remove', addOffer))).toBeNull();
  });

  it('rejects an add offering only a lineId', () => {
    expect(read(pending('add', removeOffer))).toBeNull();
  });

  it('rejects a kind that is neither add nor remove', () => {
    expect(read(pending('update', addOffer))).toBeNull();
    expect(read(pending(undefined, addOffer))).toBeNull();
  });

  it('rejects an offer that is not an object', () => {
    expect(read(pending('add', null))).toBeNull();
    expect(read(pending('add', 'Milk'))).toBeNull();
  });

  it('rejects an empty id', () => {
    expect(read(pending('add', { ...addOffer, productId: '' }))).toBeNull();
  });

  it('accepts each kind with its own id', () => {
    expect(read(pending('add', addOffer))).not.toBeNull();
    expect(read(pending('remove', removeOffer))).not.toBeNull();
  });
});

describe('pending add amounts are validated, not just its ids', () => {
  // This function is the boundary that promises arbitrary session JSON is tolerated, so the
  // promise has to cover the numbers the state carries into `addItem` — not only its shape.
  // A malformed quantity or weight reaches the mutation and either writes a unit nobody
  // asked for or computes a nonsense counter-weight target.
  const read = (extra: Record<string, unknown>) =>
    readPending({
      attributesManager: {
        getSessionAttributes: () => ({
          pendingChoice: {
            kind: 'add',
            spokenQuery: 'sliced turkey',
            quantity: 1,
            offers: [{ productId: 'p1', spoken: 'Turkey', full: 'H-E-B Turkey' }],
            index: 0,
            ...extra,
          },
        }),
      },
    } as unknown as Parameters<typeof readPending>[0]);

  it.each([
    ['an object', {}],
    ['a string', '2'],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['past the ceiling', 21],
  ] as Array<[string, unknown]>)('rejects %s quantity', (_label, quantity) => {
    expect(read({ quantity })).toBeNull();
  });

  it.each([
    ['a string', '2'],
    ['zero', 0],
    ['negative', -0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past the ceiling', 21],
  ] as Array<[string, unknown]>)('rejects %s weight', (_label, weight) => {
    expect(read({ weight })).toBeNull();
  });

  it('rejects an offer with no speakable text', () => {
    // The order of operations is what makes this dangerous: `YesIntent` deletes the line and
    // *then* builds its confirmation from `offer.spoken`. A missing one throws after the
    // mutation has committed, so Alexa reports failure for a removal that actually happened.
    const withOffers = (offers: unknown[]) =>
      readPending({
        attributesManager: {
          getSessionAttributes: () => ({
            pendingChoice: { kind: 'remove', spokenQuery: 'milk', quantity: 1, offers, index: 0 },
          }),
        },
      } as unknown as Parameters<typeof readPending>[0]);

    expect(withOffers([{ lineId: 'l1', full: 'H-E-B Milk' }])).toBeNull();
    expect(withOffers([{ lineId: 'l1', spoken: '', full: 'H-E-B Milk' }])).toBeNull();
    expect(withOffers([{ lineId: 'l1', spoken: 'Milk' }])).toBeNull();
    expect(withOffers([{ lineId: 'l1', spoken: 42, full: 'H-E-B Milk' }])).toBeNull();

    // Every offer is checked, not just the one on the table: `nextOffer` walks to the rest
    // and speaks each one, so an unvalidated offer is still reachable.
    expect(
      withOffers([
        { lineId: 'l1', spoken: 'Milk', full: 'H-E-B Milk' },
        { lineId: 'l2', full: 'H-E-B Oat Milk' },
      ]),
    ).toBeNull();

    expect(withOffers([{ lineId: 'l1', spoken: 'Milk', full: 'H-E-B Milk' }])).not.toBeNull();
  });

  it('rejects a non-string spokenQuery, which the give-up path speaks back', () => {
    const read = (spokenQuery: unknown) =>
      readPending({
        attributesManager: {
          getSessionAttributes: () => ({
            pendingChoice: {
              kind: 'add',
              spokenQuery,
              quantity: 1,
              offers: [{ productId: 'p1', spoken: 'Milk', full: 'H-E-B Milk' }],
              index: 0,
            },
          }),
        },
      } as unknown as Parameters<typeof readPending>[0]);

    expect(read(undefined)).toBeNull();
    expect(read({})).toBeNull();
    expect(read('milk')).not.toBeNull();
  });

  it('accepts the amounts a real dialog produces', () => {
    expect(read({ quantity: 2 })).not.toBeNull();
    // A quarter pound: fractional weights are the normal case at the deli counter, and
    // must not be caught by the integer rule that applies to quantity.
    expect(read({ quantity: 1, weight: 0.25 })).not.toBeNull();
    expect(read({ weight: undefined })).not.toBeNull();
  });
});

describe('pending state that is not an object at all', () => {
  const read = (pendingChoice: unknown) =>
    readPending({
      attributesManager: { getSessionAttributes: () => ({ pendingChoice }) },
    } as unknown as Parameters<typeof readPending>[0]);

  it('treats null as no pending question rather than throwing', () => {
    // `null` is valid JSON and survives a session round trip; `=== undefined` misses it,
    // and dereferencing it throws the very error this validation exists to prevent.
    expect(read(null)).toBeNull();
  });

  it('treats a primitive as no pending question', () => {
    expect(read('pendingChoice')).toBeNull();
    expect(read(7)).toBeNull();
  });
});
