/**
 * Turning spoken text into a specific HEB product.
 *
 * This is where a voice assistant is most likely to embarrass itself, so the design goal
 * is not "match as often as possible" — it is "be confident only when confidence is
 * warranted". An unnecessary "did you mean X?" costs the user two seconds. Silently adding
 * the wrong product costs them a wasted trip.
 *
 * Hybrid by design (plan §8.1): HEB's own search supplies the candidates, because it knows
 * the catalog, stock, and store. Scoring happens here, because we need a confidence number
 * that HEB's ranking does not give us and cannot be tested offline.
 */

import { CONFIRMATION_THRESHOLD } from './constants.js';
import type { MatchResult, Product } from './types.js';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Words that carry no product meaning. Kept small on purpose: over-stripping loses real
 * signal ("cream" in "sour cream", "free" in "cage free").
 */
const FILLER = new Set([
  'a', 'an', 'the', 'some', 'please', 'my', 'me', 'i', 'want', 'need',
  'get', 'buy', 'add', 'to', 'list', 'and', 'for', 'brand', 'with', 'of',
  // Spanish function words. HEB's Texas catalog carries many Spanish product names
  // ("Salsa Verde Para Enchiladas"), and these carry no more meaning than "for" does.
  'para', 'de', 'con', 'la', 'el', 'los', 'las', 'y',
]);

/**
 * Tokens that mean the same product thing, collapsed to one canonical form.
 *
 * Two jobs. First, spelling variants that voice transcription picks arbitrarily —
 * "chili" / "chile" / "chilli" are the same pepper and a user has no idea which one the
 * catalog used. Second, English↔Spanish equivalents, because a large share of this
 * catalog is named in Spanish: "Salsa Verde Para Enchiladas" *is* green enchilada sauce,
 * and without this it shares zero tokens with how an English speaker would ask for it.
 *
 * Deliberately narrow. Every entry here makes more products look alike, which lowers
 * separation and therefore lowers confidence — the safe direction, since it asks rather
 * than guesses. Words whose meanings genuinely diverge across the two languages are left
 * out: "pan" is bread in Spanish and cookware in English, and "carne" is meat generally
 * rather than beef specifically.
 */
const CANONICAL: Readonly<Record<string, string>> = {
  // spelling variants
  chile: 'chili', chilli: 'chili', chiles: 'chili', chilis: 'chili',
  // colours — the discriminating word on a great many Mexican-food products
  verde: 'green', roja: 'red', rojo: 'red', blanca: 'white', blanco: 'white',
  amarillo: 'yellow', negro: 'black', negra: 'black',
  // foods
  salsa: 'sauce', queso: 'cheese', pollo: 'chicken', leche: 'milk', crema: 'cream',
  frijoles: 'beans', arroz: 'rice', maiz: 'corn', harina: 'flour', azucar: 'sugar',
  huevos: 'eggs', manteca: 'lard', jugo: 'juice', agua: 'water', cafe: 'coffee',
};

/** Fold a token onto its canonical form. Identity for anything not in the map. */
export function canonical(token: string): string {
  return CANONICAL[token] ?? token;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3,
};

/**
 * Words that turn a preceding number into a *description* rather than a count.
 *
 * "two percent milk" means 2% milk — one carton — not two milks. Getting this wrong is
 * both easy and very visible, which is why it is data rather than a buried conditional.
 */
const MEASURE_WORDS = new Set(['percent', '%', 'pound', 'pounds', 'lb', 'lbs', 'ounce', 'ounces', 'oz', 'liter', 'litre', 'gallon', 'quart', 'inch']);

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Collapse letter-by-letter hyphenation so "H-E-B" becomes one token "heb" and can
      // match a spoken "heb". Splitting it into h/e/b makes the store's own brand — by far
      // the most common one in this catalog — permanently unmatchable.
      // Multi-letter hyphenates like "select-a-size" are deliberately left alone.
      .replace(/\b[a-z](?:-[a-z])+\b/g, (match) => match.replaceAll('-', ''))
      .replace(/[^a-z0-9%\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

export interface SpokenRequest {
  /** How many of the item the user asked for. Defaults to 1. */
  quantity: number;
  /** The product description, with any leading count removed. */
  query: string;
}

/**
 * Split a spoken phrase into a count and a product description.
 *
 * Only a *leading* number counts. "milk two percent" keeps "two percent" as description,
 * and so does "two percent milk" — because the word after the number is a measure word.
 */
export function parseSpokenRequest(text: string): SpokenRequest {
  const tokens = tokenize(text).filter((token) => !FILLER.has(token));
  if (tokens.length === 0) return { quantity: 1, query: '' };

  const first = tokens[0]!;
  const second = tokens[1];
  const numeric = NUMBER_WORDS[first] ?? (/^\d+$/.test(first) ? Number(first) : undefined);

  const isCount =
    numeric !== undefined &&
    tokens.length > 1 &&
    !(second !== undefined && MEASURE_WORDS.has(second));

  if (isCount) {
    return { quantity: numeric, query: tokens.slice(1).join(' ') };
  }
  return { quantity: 1, query: tokens.join(' ') };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Loose equality so "banana" matches "bananas" without a real stemmer, and so a token
 * matches its cross-language or alternate-spelling twin ("verde" ≡ "green").
 */
function tokensMatch(queryToken: string, productToken: string): boolean {
  const query = canonical(queryToken);
  const product = canonical(productToken);
  if (query === product) return true;
  if (query.length < 4 || product.length < 4) return false;
  return product.startsWith(query) || query.startsWith(product);
}

/**
 * Fraction of the user's words present in the product name.
 *
 * Deliberately asymmetric: we care that everything the user *said* is accounted for, not
 * that the product name is fully consumed. HEB names carry a lot of extra ("H-E-B Select
 * Ingredients Organic ..."), and penalising that would rank verbose real matches below
 * terse wrong ones.
 */
export function coverage(queryTokens: readonly string[], product: Product): number {
  if (queryTokens.length === 0) return 0;
  const productTokens = tokenize(`${product.brand ?? ''} ${product.name}`);
  const matched = queryTokens.filter((queryToken) =>
    productTokens.some((productToken) => tokensMatch(queryToken, productToken)),
  );
  return matched.length / queryTokens.length;
}

/**
 * Fraction of the *product's* words the user actually said.
 *
 * The mirror of coverage, and it carries different information: "milk" covers
 * "H-E-B Organic 2% Reduced Fat Milk" completely while describing almost none of it, which
 * is precisely the signal that the user under-specified. Without this, "bananas" and
 * "milk" look identical — both fully covered — and we would confidently pick an arbitrary
 * milk.
 */
export function precision(queryTokens: readonly string[], product: Product): number {
  const productTokens = tokenize(`${product.brand ?? ''} ${product.name}`).filter(
    (token) => !FILLER.has(token),
  );
  if (productTokens.length === 0) return 0;
  const matched = productTokens.filter((productToken) =>
    queryTokens.some((queryToken) => tokensMatch(queryToken, productToken)),
  );
  return matched.length / productTokens.length;
}

/**
 * How well a product matches the words, independent of where HEB ranked it.
 *
 * Kept strictly separate from the rank tiebreak below, because confidence is derived from
 * the *gap* between the top two. Folding rank in here would manufacture a gap out of thin
 * air: two identical milks would differ purely by position and we would report ourselves
 * confident about an arbitrary choice.
 */
function semanticScore(queryTokens: readonly string[], product: Product): number {
  return 0.75 * coverage(queryTokens, product) + 0.25 * precision(queryTokens, product);
}

/** Small nudge preserving HEB's own relevance ordering. Ordering only — never confidence. */
function rankBonus(rank: number): number {
  return 0.1 / (1 + rank);
}

/**
 * How much better the best candidate is than the runner-up, normalised to 0..1.
 *
 * This is what distinguishes "oat milk" (one clear winner) from "milk" (fifty equally good
 * answers). Without it, both would score identically on coverage alone and we would
 * confidently add an arbitrary milk.
 */
const SEPARATION_SCALE = 0.15;

export function separation(scores: readonly number[]): number {
  if (scores.length < 2) return 1;
  const [best, runnerUp] = scores;
  return Math.min(1, Math.max(0, (best! - runnerUp!) / SEPARATION_SCALE));
}

/**
 * Confidence blends "did we understand the words" with "was the answer unambiguous".
 *
 * The floor matters: a perfectly-covered but totally ambiguous query lands at 0.55, safely
 * below `CONFIRMATION_THRESHOLD` (0.7), so it asks instead of guessing. A perfectly-covered
 * unambiguous query reaches 1.0.
 */
const AMBIGUOUS_FLOOR = 0.55;

export function confidenceFrom(topCoverage: number, sep: number): number {
  return topCoverage * (AMBIGUOUS_FLOOR + (1 - AMBIGUOUS_FLOOR) * sep);
}

/**
 * Rank candidates and report the best with a calibrated confidence.
 *
 * Returns `null` when nothing matches at all, which callers surface as
 * `PRODUCT_NOT_FOUND` — HEB has no free-text fallback, so there is nothing else to offer.
 */
export function matchProducts(query: string, candidates: readonly Product[]): MatchResult | null {
  const queryTokens = tokenize(query).filter((token) => !FILLER.has(token));
  if (queryTokens.length === 0 || candidates.length === 0) return null;

  // Order by semantics plus HEB's ranking; judge confidence on semantics alone.
  const ranked = candidates
    .map((product, rank) => ({
      product,
      semantic: semanticScore(queryTokens, product),
      ordering: semanticScore(queryTokens, product) + rankBonus(rank),
    }))
    .sort((a, b) => b.ordering - a.ordering);

  const best = ranked[0]!;
  if (coverage(queryTokens, best.product) === 0) return null;

  return {
    product: best.product,
    confidence: confidenceFrom(
      coverage(queryTokens, best.product),
      separation(ranked.map((entry) => entry.semantic)),
    ),
    alternatives: ranked.slice(1, 5).map((entry) => entry.product),
  };
}

/**
 * A shorter query to retry with when the first search returned a poor candidate set.
 *
 * The failure this exists for is search-side, not scoring-side. HEB's search treats extra
 * words as constraints, so a specific phrase can return a *narrower and worse* set than a
 * general one: "green chili enchilada sauce" yielded three products and omitted
 * "H-E-B Mi Tienda Salsa Verde Para Enchiladas" entirely, while plain "enchilada sauce"
 * returned twenty-five including it. No amount of rescoring recovers a product that was
 * never a candidate.
 *
 * Dropping leading modifiers keeps the head noun, which in English is where the product
 * category lives ("enchilada sauce", "oat milk"). Returns `null` when the query is already
 * short enough that broadening would just be a different query.
 */
export function broadenQuery(query: string): string | null {
  const tokens = tokenize(query).filter((token) => !FILLER.has(token));
  if (tokens.length <= 2) return null;
  return tokens.slice(-2).join(' ');
}

/**
 * Merge candidate lists, keeping first-seen order and dropping duplicates by product id.
 *
 * Order carries HEB's own relevance ranking, so the original search's results stay ahead
 * of the broadened retry's — the retry adds reach without overriding the better-targeted
 * query's judgement.
 */
export function mergeCandidates(...lists: ReadonlyArray<readonly Product[]>): Product[] {
  const seen = new Set<string>();
  const merged: Product[] = [];
  for (const list of lists) {
    for (const product of list) {
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      merged.push(product);
    }
  }
  return merged;
}

/** Single place the threshold is applied, so both surfaces agree on what "sure" means. */
export function isConfident(match: MatchResult): boolean {
  return match.confidence >= CONFIRMATION_THRESHOLD;
}
