/**
 * Weight-based items — the deli and seafood counters.
 *
 * Three separable things, tested separately because each fails differently:
 *   - hearing "two pounds of X" without hearing it in "1.5 lb ground beef";
 *   - snapping onto the ladder H-E-B will actually accept;
 *   - carrying `pricedByWeight` off the wire so a packaged good never gets a weight.
 */

import { describe, expect, it } from 'vitest';
import { parseSpokenRequest } from './matching.js';
import { snapWeight, toProduct } from './lists.js';

describe('parseSpokenRequest — weight phrases', () => {
  const cases: Array<[string, number, string]> = [
    ['two pounds of sliced turkey', 2, 'sliced turkey'],
    ['a pound of ham', 1, 'ham'],
    ['half a pound of ham', 0.5, 'ham'],
    ['a quarter pound of deli cheese', 0.25, 'deli cheese'],
    ['a pound and a half of turkey', 1.5, 'turkey'],
    ['two and a half pounds of shrimp', 2.5, 'shrimp'],
    ['1.5 pounds of shrimp', 1.5, 'shrimp'],
    ['half pound of turkey', 0.5, 'turkey'],
    ['3 lbs of peeled shrimp', 3, 'peeled shrimp'],
  ];

  for (const [spoken, pounds, query] of cases) {
    it(`reads "${spoken}" as ${pounds} lb of ${query}`, () => {
      const parsed = parseSpokenRequest(spoken);
      expect(parsed.weight).toBe(pounds);
      expect(parsed.query).toBe(query);
      // A weight request is one order, never a count.
      expect(parsed.quantity).toBe(1);
    });
  }
});

describe('parseSpokenRequest — phrases that only look like weights', () => {
  // Each of these would break something real if it were stripped as an amount.
  const cases: Array<[string, string]> = [
    // The package *is* 1.5 lb. Stripping it searches for plain ground beef and loses the
    // size the speaker asked for — and HEB sells 1 lb, 2.25 lb and 3 lb of it.
    ['1.5 lb ground beef', '1.5 lb ground beef'],
    // A cake, not an amount.
    ['pound cake', 'pound cake'],
    // H-E-B really does sell half-pound patties, so "half pound" describes the package
    // every bit as much as "1.5 lb" does. Fractions get no exemption from the `of` rule.
    ['half pound ground beef patties', 'half pound ground beef patties'],
    ['quarter pound burger', 'quarter pound burger'],
    // "bag", not "of", follows the unit — a package name. ("of" drops out either way; it
    // is ordinary filler, like "the".)
    ['2 lb bag of sugar', '2 lb bag sugar'],
  ];

  for (const [spoken, query] of cases) {
    it(`leaves "${spoken}" alone`, () => {
      const parsed = parseSpokenRequest(spoken);
      expect(parsed.weight).toBeUndefined();
      expect(parsed.query).toBe(query);
    });
  }

  it('does not disturb ordinary counts', () => {
    expect(parseSpokenRequest('two avocados')).toMatchObject({ quantity: 2, query: 'avocados' });
    expect(parseSpokenRequest('two percent milk').weight).toBeUndefined();
    expect(parseSpokenRequest('a dozen eggs').quantity).toBe(1);
  });
});

describe('snapWeight', () => {
  // What the store actually reports for counter goods: quarter-pound steps.
  const LADDER = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  it('leaves an on-ladder weight untouched', () => {
    expect(snapWeight(1.5, LADDER)).toBe(1.5);
  });

  it('snaps an off-ladder weight to the nearest rung', () => {
    expect(snapWeight(1.3, LADDER)).toBe(1.25);
    expect(snapWeight(0.9, LADDER)).toBe(1);
  });

  it('rounds a tie up, because short-changing groceries is the worse error', () => {
    expect(snapWeight(0.375, LADDER)).toBe(0.5);
  });

  it('clamps to the ends of the ladder rather than inventing a rung', () => {
    expect(snapWeight(10, LADDER)).toBe(2);
    expect(snapWeight(0.05, LADDER)).toBe(0.25);
  });

  it('passes through unchanged when the product reported no ladder', () => {
    // HEB is then the judge. Inventing a step would be a guess about someone's order.
    expect(snapWeight(1.3, [])).toBe(1.3);
    expect(snapWeight(1.3)).toBe(1.3);
  });
});

describe('toProduct — weight metadata off the wire', () => {
  it('carries the ladder through, sorted and de-duplicated across SKUs', () => {
    const product = toProduct({
      id: 'p1',
      fullDisplayName: 'H-E-B Deli Honey-Smoked Turkey Breast, Custom Sliced, lb',
      pricedByWeight: true,
      SKUs: [
        { weightSelectionIncrements: [0.5, 0.25] },
        { weightSelectionIncrements: [0.5, 0.75] },
      ],
    });
    expect(product.pricedByWeight).toBe(true);
    expect(product.weightIncrements).toEqual([0.25, 0.5, 0.75]);
  });

  it('marks a packaged good as not priced by weight, however its name reads', () => {
    // The exact trap: the name quotes a weight, but you buy the package.
    const product = toProduct({
      id: 'p2',
      fullDisplayName: 'H-E-B Natural Boneless Chicken Breasts, Avg. 2.85 lbs',
      pricedByWeight: false,
      SKUs: [{ weightSelectionIncrements: [] }],
    });
    expect(product.pricedByWeight).toBeUndefined();
    expect(product.weightIncrements).toBeUndefined();
  });

  it('drops a nonsense rung rather than offering an unorderable weight', () => {
    const product = toProduct({
      id: 'p3',
      fullDisplayName: 'Counter thing, lb',
      pricedByWeight: true,
      SKUs: [{ weightSelectionIncrements: [0, -1, 0.25] }],
    });
    expect(product.weightIncrements).toEqual([0.25]);
  });
});
