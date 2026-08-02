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
