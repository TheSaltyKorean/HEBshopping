import { describe, expect, it } from 'vitest';
import {
  brandPreference,
  broadenQuery,
  canonical,
  isConfident,
  matchProducts,
  mergeCandidates,
  parseSpokenRequest,
  separation,
  tokenize,
} from './matching.js';
import { CONFIRMATION_THRESHOLD } from './constants.js';
import type { Product } from './types.js';

/** Product names copied from real HEB search results, so the table tests reality. */
const p = (id: string, name: string, brand?: string): Product =>
  brand === undefined ? { id, name } : { id, name, brand };

const CATALOG = {
  oatMilk: [
    p('1', 'Oatly The Original Oat Milk, 1/2 gal', 'Oatly'),
    p('2', 'Planet Oat Original Oatmilk, 52 oz', 'Planet Oat'),
    p('3', 'H-E-B Select Ingredients Whole Milk, 1 gal', 'H-E-B'),
  ],
  eggs: [
    p('4', 'H-E-B Grade AA Large White Eggs, 12 ct', 'H-E-B'),
    p('5', 'H-E-B Grade AA Cage Free Large Brown Eggs, 12 ct', 'H-E-B'),
    p('6', 'Eggland’s Best Large White Eggs, 18 ct', "Eggland's Best"),
  ],
  twoPercent: [
    p('7', 'H-E-B Select Ingredients 2% Reduced Fat Milk, 1 gal', 'H-E-B'),
    p('8', 'H-E-B Select Ingredients Whole Milk, 1 gal', 'H-E-B'),
  ],
  tortillas: [
    p('9', 'H-E-B Bakery Flour Tortillas, 10 ct', 'H-E-B'),
    p('10', 'Mission Soft Taco Flour Tortillas, 10 ct', 'Mission'),
  ],
  bananas: [
    p('11', 'Fresh Bananas', 'H-E-B'),
    p('12', 'Organic Bananas', 'H-E-B'),
    p('13', 'Banana Bread Baking Mix', 'Krusteaz'),
  ],
  paperTowels: [
    p('14', 'Bounty Select-A-Size Paper Towels, 6 rolls', 'Bounty'),
    p('15', 'H-E-B Ultra Strong Paper Towels, 8 rolls', 'H-E-B'),
  ],
};

describe('parseSpokenRequest', () => {
  it.each([
    ['oat milk', 1, 'oat milk'],
    ['bananas', 1, 'bananas'],
    ['two avocados', 2, 'avocados'],
    // "of" is filler, so it is stripped: "lemons" searches better than "of lemons".
    ['three bags of chips', 3, 'bags chips'],
    ['a dozen eggs', 1, 'dozen eggs'],
    ['a couple of lemons', 2, 'lemons'],
    ['12 eggs', 12, 'eggs'],
    // Zero is a refusal, not a count. Treating it as one would reach addItem with
    // quantity 0, and the initial mutation adds a line regardless — so asking for none
    // would put one on the list.
    ['0 bananas', 1, '0 bananas'],
    ['zero bananas', 1, 'zero bananas'],
  ])('%s → quantity %i, query "%s"', (input, quantity, query) => {
    expect(parseSpokenRequest(input)).toEqual({ quantity, query });
  });

  it('does NOT read "two percent milk" as two milks', () => {
    // The single most plausible way this feature embarrasses itself: a measure word after
    // a number makes it a description, not a count.
    expect(parseSpokenRequest('two percent milk')).toEqual({ quantity: 1, query: 'two percent milk' });
  });

  it('does NOT read "five hour energy berry" as five products', () => {
    // "hour" is a duration unit, exactly like "percent" — the number names the product
    // (5-hour Energy), not a count of bottles.
    expect(parseSpokenRequest('five hour energy berry')).toEqual({
      quantity: 1,
      query: 'five hour energy berry',
    });
  });

  it('does NOT read "200 mg ibuprofen" as 200 items', () => {
    // "mg" is a dosage unit, exactly like "percent" — the number names the strength of the
    // tablet, not a count of bottles, and 200 also exceeds MAX_QUANTITY.
    expect(parseSpokenRequest('200 mg ibuprofen')).toEqual({ quantity: 1, query: '200 mg ibuprofen' });
  });

  it('does NOT read "5 mg melatonin" as five bottles', () => {
    expect(parseSpokenRequest('5 mg melatonin')).toEqual({ quantity: 1, query: '5 mg melatonin' });
  });

  it('does NOT read "2-in-1 shampoo" as two bottles', () => {
    // Tokenization turns "2-in-1" into "2 in 1" — "in" is ordinary filler everywhere else,
    // so it is only read as part of the product description when immediately followed by
    // "one"/"1", the same shape as "two percent milk".
    expect(parseSpokenRequest('2-in-1 shampoo')).toEqual({ quantity: 1, query: '2 in 1 shampoo' });
  });

  it('does NOT read "two-in-one shampoo" as two bottles', () => {
    expect(parseSpokenRequest('two-in-one shampoo')).toEqual({ quantity: 1, query: 'two in one shampoo' });
  });

  it('does NOT read "two ply charmin toilet paper" as two packages', () => {
    // "ply" describes the sheet count of the roll, not how many rolls were asked for.
    expect(parseSpokenRequest('two ply charmin toilet paper')).toEqual({
      quantity: 1,
      query: 'two ply charmin toilet paper',
    });
  });

  it('does NOT read "four cheese pizza" as four pizzas', () => {
    // "cheese" here names the pizza's composition, and "pizza" — the noun right after it —
    // is singular, the tell that this is one product, not a count.
    expect(parseSpokenRequest('four cheese pizza')).toEqual({
      quantity: 1,
      query: 'four cheese pizza',
    });
  });

  it('does NOT read "seven layer dip" as seven dips', () => {
    expect(parseSpokenRequest('seven layer dip')).toEqual({
      quantity: 1,
      query: 'seven layer dip',
    });
  });

  it('does NOT read "seven layer hummus" as seven hummuses', () => {
    // "hummus" ends in "s" but is singular — the plural heuristic must not mistake it for a
    // count of hummus, or the skill performs seven live additions instead of confirming one.
    expect(parseSpokenRequest('seven layer hummus')).toEqual({
      quantity: 1,
      query: 'seven layer hummus',
    });
  });

  it('still reads "two cheese sticks" as two, since "sticks" is plural', () => {
    // Unlike "four cheese pizza", the noun after "cheese" is plural — an honest count of
    // string cheese sticks, not a composition description.
    expect(parseSpokenRequest('two cheese sticks')).toEqual({ quantity: 2, query: 'cheese sticks' });
  });

  it('does NOT read "four cheese Texas toast" as four toasts', () => {
    // "Texas" sits between the composition word and the actual head noun "toast" and ends in
    // "s" itself — the plural heuristic must check the phrase's head noun, not the token
    // immediately after "cheese", or this performs four live additions instead of confirming
    // one "Four Cheese Texas Toast".
    expect(parseSpokenRequest('four cheese texas toast')).toEqual({
      quantity: 1,
      query: 'four cheese texas toast',
    });
  });

  it('reads "two cheese pizzas for dinner" as two, since "pizzas" — not the trailing "dinner" — is the head noun', () => {
    // "for dinner" trails the head noun rather than sitting between it and the composition
    // word. "for" is filler already stripped from `tokens`, so a naive last-token read picks
    // "dinner" as the head and treats this as one description instead of two pizzas.
    expect(parseSpokenRequest('two cheese pizzas for dinner')).toEqual({
      quantity: 2,
      query: 'cheese pizzas dinner',
    });
  });

  it('reads "two cheese and pepperoni pizzas" as two, since "and" joins toppings within the phrase', () => {
    // The boundary scan used to stop at every filler token including "and", even when it
    // joins two toppings inside the noun phrase rather than introducing a trailing modifier
    // like "for dinner" does. That read "cheese" as the (singular) head noun and returned
    // quantity 1 instead of 2.
    expect(parseSpokenRequest('two cheese and pepperoni pizzas')).toEqual({
      quantity: 2,
      query: 'cheese pepperoni pizzas',
    });
  });

  // A package word after a number can be either reading, and both are common:
  //   "six pack soda"      — the number names the package        → one
  //   "two dozen eggs"     — the number counts packages          → two
  // Suppressing every one of them was safe against the multiply-a-whole-shop failure and
  // wrong the other way: the skill confirms "eggs" and adds a single carton, which is a
  // silent undercount the speaker has no way to notice.
  describe('counts before package words', () => {
    it.each([
      // `dozen` never names a package size — there is no "two-dozen" product — so a number
      // in front of it always counts cartons.
      ['two dozen eggs', 2, 'dozen eggs'],
      ['3 dozen eggs', 3, 'dozen eggs'],
      // For the rest, "of" is what separates counting packages from naming one, exactly as
      // it separates "two pounds of turkey" from "1.5 lb ground beef".
      ['three packs of gum', 3, 'packs gum'],
      ['two cases of water', 2, 'cases water'],
      ['two rolls of paper towels', 2, 'rolls paper towels'],
    ])('%s → quantity %i, query "%s"', (input, quantity, query) => {
      expect(parseSpokenRequest(input)).toEqual({ quantity, query });
    });

    it.each([
      // No "of": the number is part of the package's name.
      ['six pack soda', 1, 'six pack soda'],
      ['12 count eggs', 1, '12 count eggs'],
      ['12 roll paper towels', 1, '12 roll paper towels'],
      // `count` describes a size and never multiplies, "of" or not.
      ['12 count of eggs', 1, '12 count eggs'],
      // Still one carton: no number precedes `dozen`.
      ['a dozen eggs', 1, 'dozen eggs'],
    ])('%s → quantity %i, query "%s"', (input, quantity, query) => {
      expect(parseSpokenRequest(input)).toEqual({ quantity, query });
    });
  });

  describe('counts above the ceiling every surface enforces', () => {
    // `addRemainingUnits` issues one live mutation per unit, so an unbounded count is a
    // burst of real writes against somebody's list — and the MCP schema and the pending-state
    // validator both cap at 20, so an ambiguous match would build state the next turn
    // refuses to read. The parser has to agree with them.
    it.each([
      ['21 bananas', 21],
      ['100 eggs', 100],
    ])('%s is refused rather than acted on', (input, refused) => {
      expect(parseSpokenRequest(input)).toMatchObject({ quantity: 1, quantityRefused: refused });
    });

    it('still accepts the ceiling itself', () => {
      expect(parseSpokenRequest('20 bananas')).toEqual({ quantity: 20, query: 'bananas' });
    });

    // Neither clamped nor silently dropped. Clamping writes an amount nobody asked for;
    // dropping the count leaves a query that still resolves — "21 bananas" finds bananas —
    // so the surface confirms the right product and adds one. That silent undercount is the
    // same failure that made suppressing "two dozen eggs" wrong, so the count is reported
    // and the surface refuses out loud.
    it('does not clamp, and does not let the phrase resolve to a single item', () => {
      const parsed = parseSpokenRequest('21 bananas');
      expect(parsed.quantity).not.toBe(20);
      expect(parsed.quantityRefused).toBe(21);
    });

    it('does not refuse phrases where the number was never a count', () => {
      // A package size, a brand, and an amount below the ceiling: none of these is a
      // refusal, and reporting one would block ordinary requests.
      expect(parseSpokenRequest('24 pack soda').quantityRefused).toBeUndefined();
      expect(parseSpokenRequest('seven up').quantityRefused).toBeUndefined();
      expect(parseSpokenRequest('two avocados').quantityRefused).toBeUndefined();
      expect(parseSpokenRequest('milk').quantityRefused).toBeUndefined();
    });

    // `addItem` truncates a fractional quantity with `Math.trunc` and performs a live add
    // at the reduced amount, confirming a count nobody asked for. It must be refused before
    // any mutation, the same way an over-ceiling count is.
    it('refuses a fractional count instead of truncating it', () => {
      const parsed = parseSpokenRequest('1.5 bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(1.5);
      expect(parsed.query).toBe('1.5 bananas');
    });

    // Alexa's "and" is dropped as filler before the count is read, so "one and a half
    // bananas" would otherwise resolve to a plain count of 1 with "half bananas" left as the
    // query — a live one-unit add for a request the system cannot honour precisely.
    it('refuses a spoken fractional count ("one and a half") the same way', () => {
      const parsed = parseSpokenRequest('one and a half bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(1.5);
      expect(parsed.query).toBe('one half bananas');
    });

    // Tokenize deliberately keeps "1/2" whole. Without reading it as a fraction here, it is
    // left in the query as unmatched text and the request resolves to quantity 1 with a
    // search for "1/2 bananas" instead of refusing the fractional count.
    it('refuses a digit-slash fractional count ("1/2 bananas")', () => {
      const parsed = parseSpokenRequest('1/2 bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(0.5);
      expect(parsed.query).toBe('1/2 bananas');
    });

    // "one and 1/2 bananas" leaves the numeric fraction after the leading "one" once filler
    // removal strips "and". Without folding it the same way the spelled fraction is folded,
    // this resolves to a plain count of 1 and performs a live one-unit add instead of refusing.
    it('refuses a spoken-leading digit-slash fractional count ("one and 1/2 bananas")', () => {
      const parsed = parseSpokenRequest('one and 1/2 bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(1.5);
      expect(parsed.query).toBe('one 1/2 bananas');
    });

    it('refuses a spoken-leading decimal fractional count ("one and 0.5 bananas")', () => {
      const parsed = parseSpokenRequest('one and 0.5 bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(1.5);
      expect(parsed.query).toBe('one 0.5 bananas');
    });

    // The fraction reader only consumed a single token, so "three" (the multiplier on
    // "quarters") was left as unmatched query text and the count resolved to a plain 1 —
    // performing a live one-unit add for a 1.75-item request instead of refusing it.
    it('refuses a multiword spoken fractional count ("one and three quarters")', () => {
      const parsed = parseSpokenRequest('one and three quarters bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(1.75);
      expect(parsed.query).toBe('one three quarters bananas');
    });

    it('refuses a bare leading spelled fraction ("half of a banana")', () => {
      const parsed = parseSpokenRequest('half of a banana');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(0.5);
      expect(parsed.query).toBe('half banana');
    });

    it('refuses a spoken decimal count ("two point five bananas")', () => {
      // The count parser recognized numeric "2.5" but not spoken "two point five" — "point"
      // was left as an unmatched token, `numeric` stayed 2, and this resolved to quantity 2
      // with query "point five bananas" instead of refusing the unsupported fractional count.
      const parsed = parseSpokenRequest('two point five bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(2.5);
      expect(parsed.query).toBe('two point five bananas');
    });

    it('reads a spoken decimal size, not a count ("two point five liter soda")', () => {
      // Without consuming "point five" here, this misread as two packages of "point five
      // liter soda" instead of matching the one 2.5-liter product.
      expect(parseSpokenRequest('two point five liter soda').quantity).toBe(1);
      expect(parseSpokenRequest('two point five liter soda').query).toBe('two point five liter soda');
    });

    it('refuses a spoken decimal count with no leading whole number ("point five bananas")', () => {
      // The bare "point" form requires a preceding parsed number, so `numeric` stayed
      // undefined here and the guard never ran — this resolved to quantity 1 with query
      // "point five bananas" instead of refusing the fractional count.
      const parsed = parseSpokenRequest('point five bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(0.5);
      expect(parsed.query).toBe('point five bananas');
    });

    it('converts kilograms to pounds', () => {
      // "kg"/"kilogram"/"kilograms" were in MEASURE_WORDS but not in the pound-conversion
      // table, so a weight request in kilograms fell through to a plain count-and-query parse
      // and could confirm a counter product at H-E-B's default weight instead of ~4.4 lb.
      const parsed = parseSpokenRequest('two kilograms of sliced turkey');
      expect(parsed.weight).toBeCloseTo(4.409, 2);
      expect(parsed.query).toBe('sliced turkey');
    });

    it('reads a spoken decimal weight ("one point five pounds")', () => {
      // Alexa transcribes a spoken decimal as digit words joined by "point" rather than a
      // numeral. Without reading "point five" here, "point" is left as an unmatched unit
      // word and the whole phrase falls through to the count parser, which would confirm a
      // counter product at H-E-B's default weight instead of the 1.5 lb actually requested.
      const parsed = parseSpokenRequest('one point five pounds of turkey');
      expect(parsed.weight).toBe(1.5);
      expect(parsed.query).toBe('turkey');
    });

    it('reads a spoken decimal weight with no leading whole number ("point five pounds")', () => {
      // "point five pounds" has no digit word before "point" — the leading-number check
      // required `numeric !== undefined`, so this fell through to the count parser as
      // "point five pounds of turkey" and could confirm a counter product at H-E-B's
      // default weight instead of the 0.5 lb actually requested.
      const parsed = parseSpokenRequest('point five pounds of turkey');
      expect(parsed.weight).toBe(0.5);
      expect(parsed.query).toBe('turkey');
    });

    it('does NOT treat a product that starts with "half" as a fraction', () => {
      // "half and half" is a product name — no "of" follows "half" — and must not be
      // misread as a request for half a unit of something else.
      expect(parseSpokenRequest('half and half')).toEqual({ quantity: 1, query: 'half half' });
    });

    it('refuses a spoken decimal count with a numeral digit after "point" ("one point 5 bananas")', () => {
      // Alexa's transcription sometimes mixes words and numerals — "one point 5" rather than
      // "one point five". The decimal-digit loop only recognized spelled-out NUMBER_WORDS, so
      // it stopped at "5" and this resolved to quantity 1 with "point 5 bananas" left in the
      // query instead of refusing the fractional count.
      const parsed = parseSpokenRequest('one point 5 bananas');
      expect(parsed.quantity).toBe(1);
      expect(parsed.quantityRefused).toBe(1.5);
      expect(parsed.query).toBe('one point 5 bananas');
    });

    it('reads a spoken decimal weight with a numeral digit after "point" ("one point 5 pounds")', () => {
      const parsed = parseSpokenRequest('one point 5 pounds of turkey');
      expect(parsed.weight).toBe(1.5);
      expect(parsed.query).toBe('turkey');
    });
  });

  describe('weights above the configured ceiling', () => {
    // Same rule as the count ceiling, by weight: a confident match on "twenty-one pounds of
    // turkey" would otherwise reach a live mutation with the oversized weight, which the MCP
    // schema and the pending-state validator both cap at MAX_WEIGHT_LB.
    it('refuses a weight over the ceiling rather than acting on it', () => {
      const parsed = parseSpokenRequest('21 pounds of turkey');
      expect(parsed.weight).toBeUndefined();
      expect(parsed.weightRefused).toBe(21);
      expect(parsed.query).toBe('turkey');
    });

    it('refuses a spoken compound weight over the ceiling', () => {
      // "twenty one" is two tokens — NUMBER_WORDS stops at twenty, its own ceiling — so
      // reading only the first left this at 20 and let it through unrefused.
      const compound = parseSpokenRequest('twenty one pounds of turkey');
      expect(compound.weight).toBeUndefined();
      expect(compound.weightRefused).toBe(21);
      expect(compound.query).toBe('turkey');
    });

    it('still accepts the ceiling itself', () => {
      expect(parseSpokenRequest('20 pounds of turkey')).toEqual({
        quantity: 1,
        query: 'turkey',
        weight: 20,
      });
    });

    it('does not refuse weights below the ceiling', () => {
      expect(parseSpokenRequest('two pounds of sliced turkey').weightRefused).toBeUndefined();
    });

    it('refuses a scale amount with a multi-digit coefficient', () => {
      // "twelve thousand" — the hundred/thousand multiplier used to require the leading
      // number to be a single digit (one through nine), so "twelve" fell through and this
      // resolved to a plain count-and-query parse instead of a refusal.
      const weight = parseSpokenRequest('twelve thousand pounds of turkey');
      expect(weight.weight).toBeUndefined();
      expect(weight.weightRefused).toBe(12000);
      expect(weight.query).toBe('turkey');

      const count = parseSpokenRequest('ten thousand bananas');
      expect(count.quantity).not.toBe(10000);
      expect(count.quantityRefused).toBe(10000);
    });

    it('reports the full amount when a compound hundred weight has a tens portion', () => {
      // "one hundred twenty five pounds" used to only consume the trailing ones word after
      // "hundred", leaving "twenty" unmatched and reporting a refusal of 100 instead of 125.
      const weight = parseSpokenRequest('one hundred twenty five pounds of turkey');
      expect(weight.weight).toBeUndefined();
      expect(weight.weightRefused).toBe(125);
      expect(weight.query).toBe('turkey');

      const withAnd = parseSpokenRequest('one hundred and twenty five pounds of turkey');
      expect(withAnd.weightRefused).toBe(125);
    });

    it('refuses a scale amount with a decimal coefficient', () => {
      // "1.5 thousand" — the count-and-query parser only read bare-digit coefficients, so
      // `numeric` stayed undefined, "thousand" never multiplied it, and this resolved to
      // quantity 1 with "thousand bananas" left in the search query instead of a refusal.
      const count = parseSpokenRequest('1.5 thousand bananas');
      expect(count.quantity).not.toBe(1500);
      expect(count.quantityRefused).toBe(1500);
    });
  });

  it('does not read a trailing-only number as a count', () => {
    expect(parseSpokenRequest('milk')).toEqual({ quantity: 1, query: 'milk' });
  });

  it('survives an empty or filler-only phrase', () => {
    expect(parseSpokenRequest('   ')).toEqual({ quantity: 1, query: '' });
    expect(parseSpokenRequest('please add some')).toEqual({ quantity: 1, query: '' });
  });
});

describe('matchProducts — ranking acceptance table', () => {
  it.each([
    ['oat milk', CATALOG.oatMilk, '1'],
    ['dozen eggs', CATALOG.eggs, '4'],
    ['two percent milk', CATALOG.twoPercent, '7'],
    ['heb brand tortillas', CATALOG.tortillas, '9'],
    ['bananas', CATALOG.bananas, '11'],
    // Bounty and H-E-B Ultra Strong match "paper towels" equally well, so the house-brand
    // preference decides — which is the whole point of it.
    ['paper towels', CATALOG.paperTowels, '15'],
  ])('"%s" ranks the right product first', (query, candidates, expectedId) => {
    const match = matchProducts(query, candidates);
    expect(match?.product.id).toBe(expectedId);
  });

  it('returns null when nothing matches, so callers can raise PRODUCT_NOT_FOUND', () => {
    expect(matchProducts('motorcycle tyres', CATALOG.bananas)).toBeNull();
    expect(matchProducts('', CATALOG.bananas)).toBeNull();
    expect(matchProducts('milk', [])).toBeNull();
  });

  it('offers alternatives for a confirmation prompt', () => {
    const match = matchProducts('eggs', CATALOG.eggs);
    expect(match?.alternatives.length).toBeGreaterThan(0);
    expect(match?.alternatives).not.toContainEqual(match?.product);
  });
});

describe('matchProducts — confidence calibration', () => {
  it('is confident when the query nearly names the product', () => {
    const match = matchProducts('oatly original oat milk', CATALOG.oatMilk);
    expect(isConfident(match!)).toBe(true);
  });

  it.each([
    ['milk', CATALOG.twoPercent],
    ['eggs', CATALOG.eggs],
    ['tortillas', CATALOG.tortillas],
  ])('asks rather than guessing for the under-specified "%s"', (query, candidates) => {
    // These have several near-identical good answers. Adding an arbitrary one silently is
    // the failure users actually notice, so the safe direction is to confirm.
    const match = matchProducts(query, candidates);
    expect(match).not.toBeNull();
    expect(isConfident(match!)).toBe(false);
  });

  it('never reports confidence outside 0..1', () => {
    for (const candidates of Object.values(CATALOG)) {
      for (const query of ['milk', 'eggs', 'organic bananas', 'h-e-b paper towels']) {
        const match = matchProducts(query, candidates);
        if (match === null) continue;
        expect(match.confidence).toBeGreaterThanOrEqual(0);
        expect(match.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('canonical — spelling and cross-language equivalence', () => {
  it.each([
    ['chile', 'chili'],
    ['chilli', 'chili'],
    ['verde', 'green'],
    ['roja', 'red'],
    ['salsa', 'sauce'],
    ['queso', 'cheese'],
  ])('folds "%s" onto "%s"', (token, expected) => {
    expect(canonical(token)).toBe(expected);
  });

  it('leaves words with divergent meanings alone', () => {
    // "pan" is bread in Spanish and cookware in English; "carne" is meat generally, not
    // beef. Folding either would make wrong products look right.
    expect(canonical('pan')).toBe('pan');
    expect(canonical('carne')).toBe('carne');
  });

  it('matches an English request against a Spanish product name', () => {
    // The real failure this was built for: HEB sells green enchilada sauce under a name
    // that shares no English tokens with how anyone would ask for it out loud.
    const spanish = [p('8764017', 'H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz', 'H-E-B')];
    const match = matchProducts('green chili enchilada sauce', spanish);
    expect(match).not.toBeNull();
    expect(match!.product.id).toBe('8764017');
  });
});

describe('broadenQuery — recovering from a too-narrow search', () => {
  it.each([
    ['green chili enchilada sauce', 'enchilada sauce'],
    ['organic whole milk', 'whole milk'],
  ])('broadens "%s" to "%s"', (query, expected) => {
    expect(broadenQuery(query)).toBe(expected);
  });

  it.each(['oat milk', 'bananas', 'the milk'])('leaves "%s" alone', (query) => {
    // Already at or below the head noun; broadening further would be a different query.
    expect(broadenQuery(query)).toBeNull();
  });
});

describe('mergeCandidates', () => {
  const a = p('1', 'Hatch Mild Green Enchilada Sauce, 15 oz');
  const b = p('2', 'Old El Paso Green Chile Enchilada Sauce, 10 oz');

  it('drops duplicates by product id', () => {
    expect(mergeCandidates([a, b], [b, a]).map((product) => product.id)).toEqual(['1', '2']);
  });

  it('keeps the first list ahead of later ones', () => {
    // Order carries HEB's relevance ranking; the broadened retry adds reach without
    // overriding the better-targeted query's judgement.
    const c = p('3', 'Gebhardt Enchilada Sauce, 10 oz');
    expect(mergeCandidates([a], [c, b]).map((product) => product.id)).toEqual(['1', '3', '2']);
  });

  it('is empty for no input', () => {
    expect(mergeCandidates()).toEqual([]);
  });
});

describe('separation — the confidence input Codex flagged', () => {
  it('is measured against the true runner-up, not list order', () => {
    // Callers rank by an ordering that folds in HEB's own position, so the array handed to
    // separation() is not necessarily sorted by semantic score. Comparing the best against
    // a weaker *earlier* entry would invent a gap and push confidence over the threshold.
    expect(separation([0.9, 0.4, 0.88])).toBeCloseTo(separation([0.9, 0.88, 0.4]));
  });

  it('treats a lone candidate as no evidence rather than perfect evidence', () => {
    // A singleton set is often a symptom of an over-constrained query that filtered out
    // better matches — exactly what the broadened retry exists to recover.
    expect(separation([0.95])).toBe(0);
  });

  it('does not let a singleton search result auto-write', () => {
    const only = [p('1', 'Hatch Mild Green Enchilada Sauce, 15 oz')];
    const match = matchProducts('hatch mild green enchilada sauce', only);
    expect(match).not.toBeNull();
    expect(isConfident(match!)).toBe(false);
  });
});

describe('diacritics fold to their base letters', () => {
  it.each([
    ['café', 'coffee'],
    ['maíz', 'corn'],
    ['azúcar', 'sugar'],
  ])('%s canonicalises to %s', (word, expected) => {
    // The ASCII filter used to delete the accent outright, yielding "caf" / "ma z", which
    // could never reach the cafe/maiz/azucar entries in CANONICAL.
    expect(canonical(tokenize(word)[0]!)).toBe(expected);
  });

  it('matches an accented product name against an unaccented request', () => {
    const accented = [p('9', 'Café Bustelo Espresso Ground Coffee, 10 oz')];
    expect(matchProducts('coffee', accented)).not.toBeNull();
  });
});

describe('personal preferences break ties the words cannot', () => {
  const MILKS = [
    p('own-brand', 'Oak Farms Whole Milk, 1 gal', 'Oak Farms'),
    p('heb', 'H-E-B Whole Milk, 1 gal', 'H-E-B'),
    p('mitienda', 'H-E-B Mi Tienda Whole Milk, 1 gal', 'H-E-B Mi Tienda'),
    p('hcf', 'Hill Country Fare Whole Milk, 1 gal', 'Hill Country Fare'),
  ];

  it('ranks house brands H-E-B, then Mi Tienda, then Hill Country Fare', () => {
    expect(MILKS.map(brandPreference)).toEqual([3, 0, 1, 2]);
  });

  it('does not mistake a Mi Tienda product for plain H-E-B', () => {
    // Mi Tienda names contain "H-E-B", so detection has to be specific-first.
    expect(brandPreference(p('x', 'H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz'))).toBe(1);
  });

  it('offers the preferred brand first among equally good matches', () => {
    const match = matchProducts('whole milk', MILKS);
    expect(match!.product.id).toBe('heb');
  });

  it('puts a previously-purchased product ahead even of the preferred brand', () => {
    const match = matchProducts('whole milk', MILKS, { purchasedIds: new Set(['hcf']) });
    expect(match!.product.id).toBe('hcf');
  });

  it('never lets a familiar brand beat a materially better match', () => {
    // The failure this guards: "oat milk" resolving to H-E-B *dairy* milk because the
    // brand is preferred. Preference is a tiebreak, never a substitute for matching.
    const candidates = [
      p('heb-dairy', 'H-E-B Select Ingredients Whole Milk, 1 gal', 'H-E-B'),
      p('oatly', 'Oatly The Original Oat Milk, 1/2 gal', 'Oatly'),
    ];
    const match = matchProducts('oat milk', candidates, { purchasedIds: new Set(['heb-dairy']) });
    expect(match!.product.id).toBe('oatly');
  });

  it('never lets preferences inflate confidence', () => {
    const plain = matchProducts('whole milk', MILKS);
    const preferred = matchProducts('whole milk', MILKS, { purchasedIds: new Set(['hcf']) });

    // Knowing the user's habits reorders the offer list but says nothing about whether the
    // words were unambiguous. Promoting a product that is *not* the semantic winner in
    // fact lowers confidence to the floor, because separation is anchored to whatever was
    // chosen — picking on habit is an admission that the words did not decide.
    expect(preferred!.confidence).toBeLessThanOrEqual(plain!.confidence);
    expect(preferred!.confidence).toBeLessThan(CONFIRMATION_THRESHOLD);
  });

  it('does not let a promoted product inherit the semantic winner\'s gap', () => {
    // The write-threshold hazard: an early weak candidate kept first by ordering, with
    // confidence computed from a gap that belongs to a different, better product.
    const candidates = [
      p('vanilla', 'H-E-B Vanilla Organic Oat Milk, 52 oz', 'H-E-B'),
      p('plain', 'Oatly Organic Oat Milk, 52 oz', 'Oatly'),
    ];
    const match = matchProducts('organic oat milk', candidates, {
      purchasedIds: new Set(['vanilla']),
    });
    if (match!.product.id === 'vanilla') {
      expect(isConfident(match!)).toBe(false);
    }
  });
});

describe('a sole list line is unambiguous', () => {
  it('does not treat one candidate as separated on its own', () => {
    // Catalog semantics: a lone search result usually means an over-constrained query hid
    // better ones, so it must not auto-write. Removal is the opposite case — see
    // HebListOps.rankLines, which special-cases a one-item list.
    expect(separation([0.9])).toBe(0);
  });
});

describe('numbers that belong to the product name', () => {
  it.each([
    ['two good vanilla yogurt', 1],
    ['seven up', 1],
  ])('"%s" is not a count of %i', (phrase) => {
    // Silent when wrong: the resolved product still looks right while the quantity is
    // doubled, so the user only finds out at the shelf.
    expect(parseSpokenRequest(phrase).quantity).toBe(1);
  });

  it('still reads an ordinary leading count', () => {
    expect(parseSpokenRequest('two avocados')).toEqual({ quantity: 2, query: 'avocados' });
  });
});

describe('singular and plural are the same grocery', () => {
  it.each([
    ['egg', 'H-E-B Grade AA Large White Eggs, 12 ct'],
    ['banana', 'Fresh Bananas'],
    ['tortilla', 'H-E-B Bakery Flour Tortillas, 10 ct'],
  ])('"%s" matches "%s"', (query, name) => {
    // The four-character guard on prefix matching also rejected "egg"/"eggs", so an
    // ordinary request reported the item missing from a list plainly containing it.
    const match = matchProducts(query, [p('1', name)]);
    expect(match).not.toBeNull();
  });

  it('does not collapse words that merely end in s', () => {
    expect(matchProducts('grass', [p('1', 'Fresh Bananas')])).toBeNull();
  });
});

describe('inflection, not open-ended prefixes', () => {
  it.each([
    ['tomato', 'Fresh Roma Tomatoes'],
    ['grape', 'Fresh Red Seedless Grapes'],
  ])('"%s" matches "%s"', (query, name) => {
    // Both -s and -es have to be tried: stripping only s gives "tomatoe", only es gives
    // "grap". Comparing candidate forms gets both without guessing which rule applies.
    expect(matchProducts(query, [p('1', name)])).not.toBeNull();
  });

  it.each([
    ['bread', 'H-E-B Breaded Chicken Breasts, 24 oz'],
    ['corn', 'H-E-B Cornbread Mix, 15 oz'],
  ])('"%s" does not match "%s"', (query, name) => {
    expect(matchProducts(query, [p('1', name)])).toBeNull();
  });
});

describe('numeric brand spellings', () => {
  it.each(['7 up', '2 good vanilla yogurt', '3 bridges hummus'])(
    '"%s" is one item, not a count',
    (phrase) => {
      // Alexa transcribes these either way, so the digit form has to normalise too —
      // otherwise "7 Up" asks for seven units of "up".
      expect(parseSpokenRequest(phrase).quantity).toBe(1);
    },
  );

  it('still reads a genuine leading digit as a count', () => {
    expect(parseSpokenRequest('7 bananas')).toEqual({ quantity: 7, query: 'bananas' });
  });
});

describe('packaging counts belong to the product, not the request', () => {
  it.each([
    'six pack soda',
    '12 count eggs',
    '2 ct paper towels',
    'six rolls paper towels',
  ])('"%s" is one package', (phrase) => {
    // Same trap as "two percent milk", but the blast radius is larger: read as a count,
    // "six pack soda" orders six cases.
    expect(parseSpokenRequest(phrase).quantity).toBe(1);
  });

  it('still reads a plain leading count', () => {
    expect(parseSpokenRequest('six avocados')).toEqual({ quantity: 6, query: 'avocados' });
  });
});

describe('package sizes survive tokenisation', () => {
  it.each([
    ['1.5 lb ground beef', 1, '1.5 lb ground beef'],
    ['1/2 gallon milk', 1, '1/2 gallon milk'],
  ])('"%s" keeps its size intact', (input, quantity, query) => {
    // Splitting the separator turned "1.5 lb ground beef" into 1, 5, lb — the parser then
    // read 1 as a count and searched "5 lb ground beef", a materially different package.
    expect(parseSpokenRequest(input)).toEqual({ quantity, query });
  });

  it('still treats a whole leading number as a count', () => {
    expect(parseSpokenRequest('12 eggs')).toEqual({ quantity: 12, query: 'eggs' });
  });

  it('does not keep punctuation that is not part of a number', () => {
    expect(tokenize('Oatly, 1/2 gal.')).toEqual(['oatly', '1/2', 'gal']);
  });

  it('keeps a leading decimal point instead of stripping it to a whole number', () => {
    // Without the leading zero, ".5 pounds" tokenized to "5 pounds" — ten times the
    // requested weight, and the parser's own fraction support never got a chance to see it.
    expect(tokenize('.5 pounds of turkey')).toEqual(['0.5', 'pounds', 'of', 'turkey']);
    expect(parseSpokenRequest('.5 pounds of turkey')).toEqual({ quantity: 1, weight: 0.5, query: 'turkey' });
  });
});

describe('abbreviated units are sizes, not counts', () => {
  it.each(['2 l soda', '500 ml water', '5 kg rice', '2 qt cream'])(
    '"%s" is one item',
    (phrase) => {
      // Alexa transcribes package sizes exactly like this; read as a count, "2 L soda"
      // orders two of whatever "soda" happened to match.
      expect(parseSpokenRequest(phrase).quantity).toBe(1);
    },
  );

  it('still counts plain items', () => {
    expect(parseSpokenRequest('5 bananas')).toEqual({ quantity: 5, query: 'bananas' });
  });
});

describe('articles and irregular plurals', () => {
  it('reads "a 3 Musketeers bar" as one bar', () => {
    // The article is filler, so without special handling this is indistinguishable from
    // "3 Musketeers bars" — and numeric brand names cannot be enumerated.
    expect(parseSpokenRequest('a 3 musketeers bar').quantity).toBe(1);
  });

  it('reads "a three musketeers bar" (spelled-out number) as one bar', () => {
    // Alexa transcribes "3 Musketeers" as often in words as in digits. Without the spoken
    // form in NUMBER_LED_BRANDS, this parsed as quantity 3 with query "musketeers bar".
    expect(parseSpokenRequest('a three musketeers bar')).toEqual({
      quantity: 1,
      query: 'three musketeers bar',
    });
  });

  it('reads "thousand island dressing" as one item, not a refused count of 1000', () => {
    // Without "thousand island" in NUMBER_LED_BRANDS, the leading "thousand" was read as an
    // implicit count of 1,000 and the request was refused before catalog search ever ran.
    expect(parseSpokenRequest('thousand island dressing')).toEqual({
      quantity: 1,
      query: 'thousand island dressing',
    });
  });

  it('reads "one thousand island dressing" as one item, not a refused count of 1000', () => {
    // The brand check only looked at tokens 0-1, so a leading count before "thousand island"
    // still hit the scale-word multiplier and refused the request.
    expect(parseSpokenRequest('one thousand island dressing')).toEqual({
      quantity: 1,
      query: 'thousand island dressing',
    });
  });

  it('reads "two thousand island dressings" as two items, not a refused count of 2000', () => {
    expect(parseSpokenRequest('two thousand island dressings')).toEqual({
      quantity: 2,
      query: 'thousand island dressings',
    });
  });

  it('refuses "a 100 bananas" and "a 1000 bananas" instead of silently searching for them', () => {
    // "100"/"1000" are digits, so the article-before-a-number singular marker used to catch
    // them the same as "a 3 Musketeers bar" — suppressing both the count and refusal
    // branches and falling through to a silent one-unit search for "100 bananas".
    expect(parseSpokenRequest('a 100 bananas')).toEqual({
      quantity: 1,
      query: '100 bananas',
      quantityRefused: 100,
    });
    expect(parseSpokenRequest('a 1000 bananas')).toEqual({
      quantity: 1,
      query: '1000 bananas',
      quantityRefused: 1000,
    });
  });

  it('reports the full amount when a compound hundred has a tens portion', () => {
    // "one hundred twenty five bananas" used to only consume the trailing ones word after
    // "hundred", leaving "twenty" unmatched and reporting a refusal of 100 instead of 125.
    expect(parseSpokenRequest('one hundred twenty five bananas')).toEqual({
      quantity: 1,
      query: 'one hundred twenty five bananas',
      quantityRefused: 125,
    });
    expect(parseSpokenRequest('one hundred and twenty five bananas')).toEqual({
      quantity: 1,
      query: 'one hundred twenty five bananas',
      quantityRefused: 125,
    });
  });

  it('still reads "a couple of lemons" as two', () => {
    // "couple" and "few" are quantity words in their own right and must stay counts even
    // though they are also article-adjacent number words.
    expect(parseSpokenRequest('a couple of lemons')).toEqual({ quantity: 2, query: 'lemons' });
  });

  it('reads "a pair of avocados" as two', () => {
    expect(parseSpokenRequest('a pair of avocados')).toEqual({ quantity: 2, query: 'avocados' });
  });

  it('reads "both avocados" as two', () => {
    expect(parseSpokenRequest('both avocados')).toEqual({ quantity: 2, query: 'avocados' });
  });

  it('reads "an eight o\'clock coffee" as one, not eight', () => {
    // The article + spelled-out number singular marker also catches this, but "eight o
    // clock" is now in NUMBER_LED_BRANDS too — see the bare-brand test below.
    expect(parseSpokenRequest("an eight o'clock coffee")).toEqual({
      quantity: 1,
      query: 'eight o clock coffee',
    });
  });

  it('reads "eight o\'clock coffee" (no article) as one, not eight', () => {
    // Without "eight o clock" in NUMBER_LED_BRANDS, only the article-led phrasing was
    // protected — the equally natural bare brand name still parsed as quantity 8 with
    // query "coffee", an 8x overadd.
    expect(parseSpokenRequest("eight o'clock coffee")).toEqual({
      quantity: 1,
      query: 'eight o clock coffee',
    });
  });

  it.each([
    ['strawberry', 'Fresh Strawberries, 1 lb'],
    ['blueberry', 'H-E-B Fresh Blueberries, 18 oz'],
  ])('"%s" matches "%s"', (query, name) => {
    // -s and -es gave "strawberrie" and "strawberri", neither of which anyone said, so
    // coverage stayed at zero and the add reported PRODUCT_NOT_FOUND.
    expect(matchProducts(query, [p('1', name)])).not.toBeNull();
  });
});
