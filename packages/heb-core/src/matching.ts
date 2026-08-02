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

/**
 * The tokens matching actually scores: normalised, with filler removed.
 *
 * Exported so callers that need to reason about coverage use the *same* tokens rather
 * than raw `tokenize` output — "the milk" is one meaningful token, not two, and treating
 * it as two silently halves every coverage ratio computed outside this module.
 */
export function meaningfulTokens(text: string): string[] {
  return tokenize(text).filter((token) => !FILLER.has(token));
}

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

/**
 * Brand names that *begin* with a number word, where the number is part of the name.
 *
 * "Two Good vanilla yogurt" is one product, not two yogurts — and the mistake is silent,
 * because the resolved product still looks right while the quantity is doubled. Only
 * spelled-out numbers are listed: nobody says "add 2 Good yogurt" out loud, and treating
 * digits this way would break the ordinary "2 avocados" case.
 */
const NUMBER_LED_BRANDS: ReadonlyArray<readonly string[]> = [
  ['two', 'good'],
  ['seven', 'up'],
  ['five', 'guys'],
  ['three', 'bridges'],
];

export function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Fold accents to their base letters *before* the ASCII filter below, which would
      // otherwise delete them outright: "café" would become "caf" and "maíz" "ma z",
      // neither of which can reach the cafe/maiz entries in CANONICAL — failing on exactly
      // the Spanish names those entries exist to match.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
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

  // A number that starts a brand name belongs to the query, not to the count. Alexa
  // transcribes these either way — "7 Up" as often as "seven up" — so the digit form has
  // to be normalised, or "7 Up" parses as seven units of "up".
  const DIGIT_WORDS: Readonly<Record<string, string>> = {
    '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five',
    '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten',
  };
  const asWords = tokens.map((token) => DIGIT_WORDS[token] ?? token);
  const startsBrand = NUMBER_LED_BRANDS.some((brand) =>
    brand.every((word, index) => asWords[index] === word),
  );

  const isCount =
    !startsBrand &&
    numeric !== undefined &&
    // Zero is not a count, it is a refusal. "add 0 bananas" would otherwise reach
    // `addItem` with quantity 0, and the initial mutation adds a line regardless —
    // only quantities above one get adjusted — so asking for none would add one.
    numeric > 0 &&
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

  // Inflection only — deliberately NOT open-ended prefix matching.
  //
  // A general "one starts with the other" rule looks harmless and is not: `bread` starts
  // `breaded`, so asking to remove bread from a list holding only "Breaded Chicken
  // Breasts" reached full coverage and the sole-line shortcut deleted the chicken without
  // asking. Recall is worth much less here than not destroying the wrong groceries, and
  // the confirmation dialog already handles the cases this loses.
  return sharesForm(query, product);
}

/**
 * Candidate singular forms of a token.
 *
 * Both `-s` and `-es` are tried because neither alone is right: stripping only `s` turns
 * "tomatoes" into "tomatoe", and stripping only `es` turns "grapes" into "grap".
 * Comparing the *sets* gets both without needing to know which rule applies.
 */
function pluralForms(token: string): string[] {
  const forms = [token];
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    forms.push(token.slice(0, -1));
    if (token.length > 4 && token.endsWith('es')) forms.push(token.slice(0, -2));
  }
  return forms;
}

function sharesForm(a: string, b: string): boolean {
  const forms = new Set(pluralForms(a));
  return pluralForms(b).some((form) => forms.has(form));
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
 * House brands, most specific pattern first.
 *
 * Detection order is not preference order. Mi Tienda products are named "H-E-B Mi Tienda
 * …", so testing for plain H-E-B first would swallow every Mi Tienda item.
 */
const BRAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; preference: number }> = [
  { pattern: /\bmi tienda\b/, preference: 1 },
  { pattern: /\bhill country fare\b/, preference: 2 },
  { pattern: /\bh-?e-?b\b/, preference: 0 },
];

/** Lower is better; anything unrecognised sorts after every house brand. */
const UNRANKED_BRAND = BRAND_PATTERNS.length;

export function brandPreference(product: Product): number {
  const haystack = `${product.brand ?? ''} ${product.name}`.toLowerCase();
  for (const { pattern, preference } of BRAND_PATTERNS) {
    if (pattern.test(haystack)) return preference;
  }
  return UNRANKED_BRAND;
}

/**
 * Personal signals that break ties between products the words cannot separate.
 *
 * Deliberately *only* tiebreakers. Letting them raise confidence would mean a familiar
 * brand could win against a product that matches the request better — "H-E-B Whole Milk"
 * beating "Oatly Oat Milk" for "oat milk" — which is precisely the silent-wrong-product
 * failure the whole design is built to avoid.
 */
export interface MatchPreferences {
  /** Catalog ids the account has bought before, from the buy-it-again carousel. */
  purchasedIds?: ReadonlySet<string>;
}

/**
 * How close two semantic scores must be to count as "the words cannot separate these".
 *
 * Inside this band the personal signals decide. Outside it, the better match always wins,
 * however unfamiliar its brand.
 */
const SEMANTIC_TIE = 0.05;

/**
 * How much better the best candidate is than the runner-up, normalised to 0..1.
 *
 * This is what distinguishes "oat milk" (one clear winner) from "milk" (fifty equally good
 * answers). Without it, both would score identically on coverage alone and we would
 * confidently add an arbitrary milk.
 */
const SEPARATION_SCALE = 0.15;

/**
 * How far clear the *chosen* candidate is of the strongest alternative.
 *
 * Anchored to `chosen` rather than to the top of the list, because ordering folds in
 * signals other than the words — HEB's own position, and the personal preferences — so the
 * product we are about to name is not always the semantic winner. Combining one product's
 * coverage with another product's separation is what lets an early, weaker candidate
 * inherit a gap it did not earn and cross the write threshold.
 *
 * When `chosen` is *not* the semantic winner the difference is negative, which clamps to
 * zero: no separation, so confidence sits on the floor and we ask. That is the right
 * answer — preferring a product on brand or habit is never evidence that the words were
 * unambiguous.
 */
export function separation(scores: readonly number[], chosen?: number): number {
  // A lone candidate is not evidence of a clear winner — it is the absence of evidence.
  // HEB's search narrows on every extra word, so a singleton set is often a *symptom* of
  // an over-constrained query that filtered out better catalog matches. Reporting maximum
  // separation here would let a fully-covered singleton reach confidence 1.0 and be
  // written silently, skipping the broadened retry that exists for exactly this case.
  if (scores.length < 2) return 0;

  const target = chosen ?? Math.max(...scores);

  // Remove exactly one occurrence, never every equal value: two candidates tied at the top
  // means *no* separation, and filtering by value would delete both and hand the gap to a
  // weaker third product instead.
  const rivals = [...scores];
  const index = rivals.indexOf(target);
  if (index !== -1) rivals.splice(index, 1);

  return Math.min(1, Math.max(0, (target - Math.max(...rivals)) / SEPARATION_SCALE));
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
 * `PRODUCT_NOT_FOUND`. NOTE: the HEB mobile app does offer a free-text add, so this is a
 * gap in this project rather than a limit of the platform — see errors.ts.
 */
export function matchProducts(
  query: string,
  candidates: readonly Product[],
  preferences: MatchPreferences = {},
): MatchResult | null {
  const queryTokens = tokenize(query).filter((token) => !FILLER.has(token));
  if (queryTokens.length === 0 || candidates.length === 0) return null;

  const scored = candidates.map((product, rank) => ({
    product,
    rank,
    semantic: semanticScore(queryTokens, product),
    purchased: preferences.purchasedIds?.has(product.id) === true,
    brand: brandPreference(product),
  }));

  // Partition against the best score, then sort each part independently.
  //
  // The obvious formulation — one comparator that treats scores within SEMANTIC_TIE as
  // tied — is *intransitive*: a≈b and b≈c while a and c differ by twice the band. That
  // makes the sort's result implementation-defined, and can leave a product first that is
  // not the strongest match in its own band, which then hands its coverage to a confidence
  // computed from someone else's gap.
  //
  // Anchoring to the leader is both well-defined and what the rule actually means: the
  // personal signals decide among the products the words cannot separate *from the best
  // one*, and never promote a materially worse match.
  const topSemantic = Math.max(...scored.map((entry) => entry.semantic));
  const contends = (entry: (typeof scored)[number]): boolean =>
    entry.semantic >= topSemantic - SEMANTIC_TIE;

  const byPreference = (a: (typeof scored)[number], b: (typeof scored)[number]): number => {
    if (a.purchased !== b.purchased) return a.purchased ? -1 : 1;
    if (a.brand !== b.brand) return a.brand - b.brand;
    return rankBonus(b.rank) - rankBonus(a.rank);
  };

  const ranked = [
    ...scored.filter(contends).sort(byPreference),
    ...scored
      .filter((entry) => !contends(entry))
      .sort((a, b) => b.semantic - a.semantic || rankBonus(b.rank) - rankBonus(a.rank)),
  ];

  const best = ranked[0]!;
  if (coverage(queryTokens, best.product) === 0) return null;

  return {
    product: best.product,
    // Both inputs describe `best` — its coverage and its gap over the strongest rival.
    // Mixing one product's coverage with another's separation lets a candidate promoted on
    // habit or brand inherit a gap it never earned, and cross the write threshold on it.
    confidence: confidenceFrom(
      coverage(queryTokens, best.product),
      separation(
        ranked.map((entry) => entry.semantic),
        best.semantic,
      ),
    ),
    // Only candidates the request actually touches. HEB's search returns a long tail, and
    // `rankLines` feeds these straight into Alexa's sequential removal dialog — so an
    // unfiltered slice means "remove milk" can walk down to "Did you mean bread?", and a
    // "yes" then deletes a line sharing not one word with what was asked for.
    alternatives: ranked
      .slice(1)
      .filter((entry) => coverage(queryTokens, entry.product) > 0)
      .slice(0, 4)
      .map((entry) => entry.product),
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
