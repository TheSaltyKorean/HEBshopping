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

import { CONFIRMATION_THRESHOLD, MAX_QUANTITY, MAX_WEIGHT_LB } from './constants.js';
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

/**
 * Spoken counts, up to the ceiling the tools accept.
 *
 * Runs to twenty because that is the MCP schema's maximum: stopping at twelve meant
 * "thirteen bananas" kept the word in the query, so it either failed to match or added a
 * single item — a silent undercount, since the confirmation still names the right product.
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  // Past the ceiling, only the bare tens word needs recognising — it already exceeds
  // MAX_QUANTITY/MAX_WEIGHT_LB on its own, so reading it (rather than leaving it as
  // unmatched query text) is enough to route "thirty bananas" through the existing
  // refusal fields instead of silently searching for "thirty bananas" as a product name.
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  couple: 2, few: 3, pair: 2, both: 2,
  // NOT "dozen". "A dozen eggs" is one carton of twelve, not twelve cartons — the same
  // trap as "two percent milk", and the product name already carries the count.
};

/**
 * A single decimal digit following a spoken "point" — either the spelled-out word ("five")
 * or, when Alexa's transcription mixes words and numerals ("one point 5" or a grouped
 * numeral like "one point 25"), the bare numeral token itself. Returns the digit *text*
 * rather than a numeric value: a grouped numeral like "05" (in "one point 05 pounds") has a
 * leading zero that `Number("05")` would silently drop, collapsing the decimal loops'
 * `join('')` result from "05" to "5" and reading 1.5 lb for a request that asked for 1.05 lb.
 * Shared by the weight and count decimal-digit loops in `parseWeightPhrase` and
 * `parseSpokenRequest` below.
 */
function spokenDigitText(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const word = NUMBER_WORDS[token];
  if (word !== undefined && word <= 9) return String(word);
  return /^[0-9]+$/.test(token) ? token : undefined;
}

/**
 * The digits that follow a tens word in a compound amount ("twenty one pounds", "thirty
 * five bananas"). See `parseWeightPhrase` and `parseSpokenRequest`.
 */
const ONES_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

/**
 * Words that turn a preceding number into a *description* rather than a count.
 *
 * "two percent milk" means 2% milk — one carton — not two milks. Getting this wrong is
 * both easy and very visible, which is why it is data rather than a buried conditional.
 */
const MEASURE_WORDS = new Set([
  'percent', '%', 'pound', 'pounds', 'lb', 'lbs', 'ounce', 'ounces', 'oz',
  'liter', 'litre', 'gallon', 'quart', 'inch',
  // Packaging counts. "Six pack soda" is one package, not six cases, and "12 count eggs"
  // is one carton — the number belongs to the product name, exactly as in "two percent
  // milk". Getting these wrong multiplies a whole shop.
  'pack', 'packs', 'pk', 'count', 'ct', 'case', 'cases', 'dozen', 'roll', 'rolls',
  // "8-piece fried chicken" names one package of eight pieces, the same trap as "six pack
  // soda" — but unlike "count"/"ct", "piece" also has a genuine plural count reading
  // ("two pieces of chicken"), so it is in `PLURAL_PACKAGE_WORDS` too.
  'piece', 'pieces',
  // Abbreviated metric and volume units. Alexa transcribes "2 L soda" and "500 ml water"
  // exactly like that, and without these the size becomes the quantity — two litres of
  // soda turns into two of whatever "soda" matched.
  'l', 'ml', 'g', 'kg', 'gram', 'grams', 'kilogram', 'kilograms',
  'milliliter', 'milliliters', 'millilitre', 'millilitres', 'litre', 'liters', 'litres',
  'gal', 'qt', 'pt', 'pint', 'pints', 'quarts', 'gallons', 'fl',
  // Dosage units. "200 mg ibuprofen" is one bottle of 200 mg tablets, not 200 items — same
  // trap as "two percent milk", and without these the leading number is read as a quantity
  // instead of staying part of the catalog query. "IU" (international units) is the standard
  // strength unit for supplements like vitamin D — "400 IU vitamin D" is one bottle, not 400.
  'mg', 'mcg', 'milligram', 'milligrams', 'microgram', 'micrograms', 'iu',
  // "hour" — a genuine duration unit, exactly like "percent": "five hour energy berry" is
  // one bottle of 5-hour Energy, not five bottles of "hour energy berry". Handling it here,
  // rather than adding "5-hour energy" to `NUMBER_LED_BRANDS`, generalises to any number-led
  // product named after a duration instead of growing an allowlist one brand at a time.
  'hour', 'hours',
  // "ply" describes the sheet count of the roll, not how many rolls: "two-ply Charmin
  // toilet paper" is one product, not two. Same shape as "percent" and "pack" — the number
  // is part of what the product *is*, not how many are wanted.
  'ply',
  // Composition words — see `COMPOSITION_WORDS` below for why these are singled out.
  'cheese', 'layer', 'bean', 'meat', 'wick', 'blade',
]);

/**
 * `MEASURE_WORDS` entries that name a singular product's *composition or style* rather than a
 * fixed unit or package size: "four cheese pizza" is one pizza made with four cheeses, "seven
 * layer dip" is one dip with seven layers, "three bean salad" is one salad of three beans,
 * "four meat pizza" is one pizza with four meats, "three wick candle" is one candle with three
 * wicks, "five blade razor" is one razor with five blades — same shape as "two percent milk",
 * where the number describes the product rather than how many are wanted.
 *
 * Unlike the rest of `MEASURE_WORDS` ("percent", "pack", "ply", ...), which describe the
 * product regardless of what follows, these words only read that way when the head noun right
 * after them is singular: "two cheese sticks" really is two sticks, "three wick candles"
 * really is three candles, and the plural head noun is exactly the tell. Applying that same
 * check to the whole of `MEASURE_WORDS` would break entries like "count", where the noun that
 * follows ("12 count eggs") is plural by nature of what the word measures — so the
 * singular-head check is scoped to this set.
 */
const COMPOSITION_WORDS = new Set(['cheese', 'layer', 'bean', 'meat', 'wick', 'blade']);

/**
 * Brand names that *begin* with a number word, where the number is part of the name.
 *
 * "Two Good vanilla yogurt" is one product, not two yogurts — and the mistake is silent,
 * because the resolved product still looks right while the quantity is doubled. Only
 * spelled-out numbers are listed: nobody says "add 2 Good yogurt" out loud, and treating
 * digits this way would break the ordinary "2 avocados" case.
 */
/**
 * Package words a preceding number *multiplies* rather than describes.
 *
 * `MEASURE_WORDS` exists because "six pack soda" is one package and "12 count eggs" is one
 * carton — the number belongs to the product name. But the same words also take an honest
 * count: "two dozen eggs" is two cartons, and suppressing it confirms the right product
 * while adding one, which is a silent undercount of exactly the kind the number words run
 * to twenty to avoid.
 *
 * The two readings are separated the same way weights are (`parseWeightPhrase`): by the
 * word **of**. "three packs of gum" counts packages; "six pack soda" names one. `dozen` is
 * listed separately because it never describes a package — there is no "two-dozen" product
 * the way there is a "six-pack" — so it multiplies whenever a number precedes it.
 *
 * `count` and `ct` are deliberately absent: they only ever describe a size.
 *
 * Only the plural forms count as evidence: "six pack of soda" names one singular six-pack
 * (the singular noun already reads as a package name with "of" attached, e.g. "a pack of
 * gum"), while "three packs of gum" is genuinely three. `pk` has no distinct plural
 * spelling, so it stays singular-only and never multiplies via "of".
 */
const PLURAL_PACKAGE_WORDS = new Set(['packs', 'cases', 'rolls', 'pieces']);

const NUMBER_LED_BRANDS: ReadonlyArray<readonly string[]> = [
  ['two', 'good'],
  ['seven', 'up'],
  ['five', 'guys'],
  ['three', 'bridges'],
  ['three', 'musketeers'],
  ['thousand', 'island'],
  ['eight', 'o', 'clock'],
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
      // A leading decimal like ".5 pounds" has no digit before the dot, so it would
      // otherwise fail the "between digits" test below and get stripped to "5 pounds" —
      // ten times the requested weight. Spell out the implied zero first.
      .replace(/(^|\s)\.(?=\d)/g, '$10.')
      // Keep decimals and fractions whole. Stripping the separator turns "1.5 lb ground
      // beef" into the tokens 1, 5, lb — and the parser then reads 1 as a count and
      // searches for "5 lb ground beef", which is a materially different package.
      .replace(/[^a-z0-9%./\s]/g, ' ')
      // ...but a dot or slash that is not *between* digits is punctuation, not a number.
      .replace(/(?<!\d)[./]|[./](?!\d)/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

export interface SpokenRequest {
  /** How many of the item the user asked for. Defaults to 1. */
  quantity: number;
  /** The product description, with any leading count removed. */
  query: string;
  /**
   * Pounds, when the phrase asked for an amount by weight ("two pounds of sliced turkey").
   *
   * Only meaningful for counter goods; `addItem` drops it for packaged products, which are
   * bought by the package. When present, `quantity` is 1.
   */
  weight?: number;
  /**
   * The count that was asked for and could not be honoured, when it exceeds `MAX_QUANTITY`.
   *
   * Present *instead of* acting on the number. Dropping it and searching the whole phrase
   * looks safe and is not: "21 bananas" still resolves to bananas, so the surface confirms
   * the right product and adds one — a silent undercount, which is the same failure that
   * made suppressing "two dozen eggs" wrong. Surfaces must refuse out loud instead.
   */
  quantityRefused?: number;
  /**
   * The weight that was asked for and could not be honoured, when it exceeds `MAX_WEIGHT_LB`.
   *
   * Present *instead of* acting on the number, for the same reason as `quantityRefused`: a
   * confident match on "twenty-one pounds of turkey" would otherwise perform a live mutation
   * with the oversized weight, and the MCP schema and pending-state validator both cap at
   * `MAX_WEIGHT_LB` anyway — silently snapping it to the ceiling writes an amount nobody asked
   * for. Surfaces must refuse out loud instead.
   */
  weightRefused?: number;
}

/** Units that mean pounds. */
const POUND_WORDS = new Set(['pound', 'pounds', 'lb', 'lbs']);

/**
 * Units converted to pounds on the spot so "six ounces of turkey" and "two kilograms of
 * turkey" land on the same weight-add path as "half pound of turkey" — see `parseWeightPhrase`.
 *
 * Leaving these unit words unhandled used to fall through to the count parser, which reads
 * `ounces`/`grams`/`kilograms` as a `MEASURE_WORDS` descriptor ("two percent milk" style)
 * rather than an amount: "six ounces of sliced turkey" became a plain search for "six ounces
 * sliced turkey", and confirming a counter-product candidate silently added it at H-E-B's
 * default weight — the amount asked for never made it into the mutation. Converting here, so
 * the request reaches `adjustWeight`'s existing quarter-pound snapping the same way a pound
 * request does, is safer than that silent drop.
 */
const SUB_POUND_UNITS: Readonly<Record<string, number>> = {
  ounce: 1 / 16, ounces: 1 / 16, oz: 1 / 16,
  gram: 1 / 453.59237, grams: 1 / 453.59237, g: 1 / 453.59237,
  kilogram: 1000 / 453.59237, kilograms: 1000 / 453.59237, kg: 1000 / 453.59237,
};

/**
 * Spoken fractions of a pound. A quarter is H-E-B's own smallest deli increment. Plural forms
 * ("three quarters", never "two halves" of one pound) are included because a leading count
 * above one pluralizes the fraction word, same as the "hundred and one pound**s**" unit itself.
 */
const FRACTION_WORDS: Readonly<Record<string, number>> = {
  half: 0.5,
  quarter: 0.25,
  quarters: 0.25,
};

/** Articles skipped while reading a weight phrase; everything else is significant. */
const ARTICLES = new Set(['a', 'an', 'the']);

/**
 * A fraction token, spelled ("half") or numeric ("1/2", "0.5") — shared by the leading-amount
 * reads in both `parseWeightPhrase` and the plain count parser below, so "one and 1/2 pounds"
 * and "one and 1/2 bananas" fold a trailing numeric fraction the same way "one and a half" does.
 */
function readFractionToken(token: string): number | undefined {
  if (FRACTION_WORDS[token] !== undefined) return FRACTION_WORDS[token];
  const match = /^(\d+)\/(\d+)$/.exec(token);
  if (match) return Number(match[1]) / Number(match[2]);
  if (/^0?\.\d+$/.test(token)) return Number(token);
  return undefined;
}

/**
 * Read a leading "two pounds of …" phrase, if that is what this is.
 *
 * ── Why the "of" is required ────────────────────────────────────────────────────────
 * "Two pounds **of** sliced turkey" is an order for an amount. "1.5 lb ground beef" is the
 * name of a package — the number describes the product, exactly like "two percent milk",
 * and stripping it would search for plain "ground beef" and lose the size the speaker
 * asked for. English marks the difference with `of`, so this does too, without exception.
 *
 * Fractions are not exempt: "half pound ground beef patties" describes a package every bit
 * as much as "1.5 lb" does, and H-E-B really does sell half-pound patties. "Pound cake"
 * survives on the same rule — no `of` follows, so it stays in the query.
 *
 * Ounces and grams are converted to pounds (see `SUB_POUND_UNITS`) and snapped to H-E-B's
 * quarter-pound ladder the same way an honest pound request is. That rounding is imprecise,
 * but it is a better answer than the alternative: leaving the unit unhandled falls through to
 * the count parser, which reads it as a product descriptor and can confirm a counter-product
 * candidate at H-E-B's default weight — silently dropping the amount altogether.
 *
 * Returns null when the phrase is not a weight request, leaving the caller's normal
 * count-and-query parse untouched.
 */
function parseWeightPhrase(raw: readonly string[]): { pounds: number; rest: string[] } | null {
  let index = 0;
  const skipArticles = (): void => {
    while (index < raw.length && ARTICLES.has(raw[index]!)) index += 1;
  };

  skipArticles();
  if (index >= raw.length) return null;

  const first = raw[index]!;
  const fraction = FRACTION_WORDS[first];
  // Tokenize deliberately keeps "1/2" whole (see tokenize's comment), so a numeric fraction
  // has to be read here rather than falling through to the decimal-only regex, which would
  // leave "1/2" unparsed and drop the weight from a request like "1/2 pound of turkey".
  const fractionMatch = /^(\d+)\/(\d+)$/.exec(first);
  const numeric =
    NUMBER_WORDS[first] ??
    (fractionMatch ? Number(fractionMatch[1]) / Number(fractionMatch[2]) : undefined) ??
    (/^\d+(?:\.\d+)?$/.test(first) ? Number(first) : undefined);

  // No leading amount at all means an implicit one: "a pound of ham".
  let pounds = fraction ?? numeric ?? 1;
  if (fraction !== undefined || numeric !== undefined) index += 1;

  // "a couple of pounds of turkey" — "couple", "few", "pair", and "both" take their own "of"
  // right after them ("a couple of lemons"), which the plain count parser never sees because
  // "of" is filler there. This parser reads "of" as the significant marker before the unit,
  // so the idiom's own "of" has to be consumed here or it is mistaken for the unit token and
  // the whole phrase fails, falling through to a count-and-query parse that drops the weight.
  if (
    (first === 'couple' || first === 'few' || first === 'pair' || first === 'both') &&
    raw[index] === 'of'
  ) {
    index += 1;
  }

  // "one point five pounds of turkey" — Alexa speaks a decimal weight as digit words joined
  // by "point" rather than a numeral. Without reading it here, "point" is left as an
  // unmatched unit word and the whole phrase falls through to a count-and-query parse that
  // drops the weight and writes a counter product at H-E-B's default size instead of the
  // 1.5 lb actually requested.
  //
  // "point five pounds of turkey" — the leading whole-number word can be omitted entirely,
  // same as a numeral written "0.5" or ".5" would be. `first` is then `point` itself and
  // `numeric` is undefined, so the check below must not require a preceding number.
  if (raw[index] === 'point') {
    const digits: string[] = [];
    let cursor = index + 1;
    while (cursor < raw.length && spokenDigitText(raw[cursor]) !== undefined) {
      digits.push(spokenDigitText(raw[cursor])!);
      cursor += 1;
    }
    if (digits.length > 0) {
      pounds = (numeric ?? 0) + Number(`0.${digits.join('')}`);
      index = cursor;
    }
  }

  // "a quarter of a pound of turkey" / "half of a pound of ham" / "1/2 of a pound of turkey" —
  // a bare leading fraction (no preceding whole number), whether spelled as a word or written
  // as "1/2" or "0.5", can itself be followed by "of a" before the unit. Without skipping it
  // here, "of" is read as the unit's own `of` one token early, "a pound of turkey" is left as
  // the description, and the whole phrase falls through to a plain count-and-query parse that
  // drops the weight and adds a counter product at its default size instead.
  const isNumericFraction = fractionMatch !== null || (numeric !== undefined && numeric > 0 && numeric < 1);
  if ((fraction !== undefined || isNumericFraction) && raw[index] === 'of') {
    index += 1;
    skipArticles();
  }

  // "one hundred pounds of turkey" — "hundred" multiplies the digit word before it. Without
  // this, only "one" is read here, "hundred" is left as an unmatched unit word, and the
  // whole phrase falls through to a plain count-and-query parse that drops the weight and
  // can add a counter product at its default size instead of refusing.
  //
  // "a hundred pounds of turkey" — the leading article was already stripped by skipArticles,
  // so no digit word precedes "hundred" here at all; treat the bare word as an implicit one,
  // the same way "a pound" above means one pound.
  const isBareHundred = numeric === undefined && fraction === undefined && first === 'hundred';
  if (((numeric !== undefined && numeric >= 1) || isBareHundred) && raw[index] === 'hundred') {
    pounds = (numeric ?? 1) * 100;
    index += 1;

    // "one hundred and five pounds" / "one hundred five pounds" — an optional "and" and a
    // trailing ones word extend the hundred. Without this, "hundred" is consumed but the
    // ones word is left unmatched, the unit check below fails, and the whole phrase falls
    // through to a plain count-and-query parse that drops the weight instead of refusing it.
    //
    // "one hundred twenty five pounds" / "one hundred and twenty five pounds" — the tens
    // portion needs the same treatment: a bare tens word can itself be followed by a ones
    // word, same as the standalone tens-plus-ones read below. Without it, "twenty" is left
    // unmatched and the refusal reports 100 instead of the 125 actually asked for.
    let cursor = index;
    if (raw[cursor] === 'and') cursor += 1;
    const hundredTens = NUMBER_WORDS[raw[cursor] ?? ''];
    if (hundredTens !== undefined && hundredTens >= 20 && hundredTens % 10 === 0) {
      pounds += hundredTens;
      cursor += 1;
      const tensOnes = ONES_WORDS[raw[cursor] ?? ''];
      if (tensOnes !== undefined) {
        pounds += tensOnes;
        cursor += 1;
      }
      index = cursor;
    } else {
      const hundredOnes = ONES_WORDS[raw[cursor] ?? ''];
      if (hundredOnes !== undefined) {
        pounds += hundredOnes;
        index = cursor + 1;
      }
    }
  }

  // "one thousand pounds of turkey" / "a thousand pounds of turkey" — same reasoning as
  // "hundred" above, one scale word up. Without this, "thousand" is left as an unmatched
  // unit word (or, for the bare form, as ordinary query text) and the phrase falls through
  // to a count-and-query parse that drops the weight instead of refusing it.
  const isBareThousand = numeric === undefined && fraction === undefined && first === 'thousand';
  if (((numeric !== undefined && numeric >= 1) || isBareThousand) && raw[index] === 'thousand') {
    pounds = (numeric ?? 1) * 1000;
    index += 1;
  }

  // "twenty one pounds" / "thirty five pounds" — every tens word from twenty through ninety
  // can be followed by a ones word to build a compound. Reading only the bare tens word still
  // refuses the weight (all of them exceed MAX_WEIGHT_LB), but misreports the spoken amount
  // in the refusal message unless the ones word is consumed too.
  if (numeric !== undefined && numeric >= 20 && numeric % 10 === 0) {
    const ones = ONES_WORDS[raw[index] ?? ''];
    if (ones !== undefined) {
      pounds += ones;
      index += 1;
    }
  }

  // "one half pound of turkey" / "three quarter pound of turkey" — Alexa tokenizes a
  // hyphenated amount like "one-half" or "three-quarter" the same way it would speak
  // "one and a half", but without the "and". Reading only a bare number here would leave
  // the fraction word behind as an unmatched unit word and fail the whole phrase, silently
  // falling through to a plain count-and-query parse that drops the weight entirely.
  //
  // Without the "and", the fraction word names the denominator of the leading number, not
  // an amount to add to it: "one half" is 1/2 = 0.5, and "three quarter" is 3/4 = 0.75 —
  // not 3 + 0.25 = 3.25. Addition only applies once the "and" form matches below.
  if (numeric !== undefined) {
    const adjacent = FRACTION_WORDS[raw[index] ?? ''];
    if (adjacent !== undefined) {
      pounds = pounds * adjacent;
      index += 1;

      // "three quarters of a pound of turkey" — unlike the bare "one half pound" form, the
      // plural fraction is itself followed by an explicit "of a pound" before the request's
      // own "of". Without skipping it here, "of" is read as the request's `of` one token
      // early, "a pound of turkey" is left as the description, and the whole phrase falls
      // through to a plain count-and-query parse that drops the weight entirely.
      if (raw[index] === 'of') {
        index += 1;
        skipArticles();
      }
    } else {
      // "1 1/2 pounds of turkey" — the common written mixed-number form, a whole number
      // directly followed by a numeric slash fraction. Unlike the spelled "one half" form
      // above, this is addition (1 + 1/2 = 1.5), the ordinary reading of a mixed number, not
      // a denominator naming the leading number.
      const slashMatch = /^(\d+)\/(\d+)$/.exec(raw[index] ?? '');
      if (slashMatch) {
        pounds += Number(slashMatch[1]) / Number(slashMatch[2]);
        index += 1;
      }
    }
  }

  // "two and a half pounds" — the fraction can precede the unit as well as follow it.
  //
  // `scale` converts the fraction's own unit into pounds. Before the unit token is read, the
  // fraction is already in pounds (scale 1). After it — "an ounce and a half of turkey" — the
  // fraction is in the *sub-pound unit just matched* ("a half" more ounces, not more pounds),
  // so it must go through the same `poundsPerUnit` conversion as the leading amount, or "an
  // ounce and a half" comes out as 1.5 lb instead of 0.09375 lb.
  const readAndAHalf = (scale: number, primaryUnitRead: boolean): void => {
    let cursor = index;
    if (raw[cursor] !== 'and') return;
    cursor += 1;
    while (cursor < raw.length && ARTICLES.has(raw[cursor]!)) cursor += 1;

    // "a pound and three quarters of turkey" — the same wording `speakablePounds(1.75)`
    // generates. A leading ones word before the fraction multiplies it, same as "twenty
    // one pounds" above; without reading it here, "three" is left as an unmatched fraction
    // lookup, the whole tail is unconsumed, and the phrase falls through to a plain
    // count-and-query parse that drops the weight entirely.
    const leadingOnes = ONES_WORDS[raw[cursor] ?? ''];
    const fractionCursor = leadingOnes !== undefined ? cursor + 1 : cursor;
    const extra = readFractionToken(raw[fractionCursor] ?? '');
    if (extra === undefined) return;

    // "one pound and 1/2 ounce of turkey" — once the primary unit is already read, a fraction
    // immediately followed by its own weight unit names a *second* amount, not more of the
    // unit already matched. Without this check, this branch would greedily read "1/2" as half
    // a pound, leaving "ounce" where the final "of" is expected and dropping the whole phrase
    // through to a count-and-query parse. `readAndSecondaryUnit` below handles this form
    // instead. Before the primary unit is read ("two and a half pounds"), the following word
    // *is* the primary unit the fraction itself is measured in, so this check does not apply.
    if (primaryUnitRead) {
      const followingUnit = raw[fractionCursor + 1];
      if (followingUnit !== undefined && (POUND_WORDS.has(followingUnit) || SUB_POUND_UNITS[followingUnit] !== undefined)) {
        return;
      }
    }

    pounds += extra * (leadingOnes ?? 1) * scale;
    index = fractionCursor + 1;
  };
  readAndAHalf(1, false);

  skipArticles();
  const unit = raw[index];
  const poundsPerUnit = unit === undefined ? undefined : POUND_WORDS.has(unit) ? 1 : SUB_POUND_UNITS[unit];
  if (poundsPerUnit === undefined) return null;
  pounds *= poundsPerUnit;
  index += 1;

  // "a pound and a half of turkey" — same fraction, on the other side of the unit.
  readAndAHalf(poundsPerUnit, true);

  // "one pound and two ounces of turkey" — a compound naming a second unit rather than a
  // fraction. `readAndAHalf` above already tried the fraction form and left "and" unconsumed
  // if it didn't match; without this, "ounces" fails as a fraction lookup, "and" is left
  // unconsumed, and the whole phrase falls through to a count-and-query parse that drops the
  // weight and adds a counter product at H-E-B's default size instead of the requested total.
  const readAndSecondaryUnit = (): void => {
    let cursor = index;
    if (raw[cursor] !== 'and') return;
    cursor += 1;
    while (cursor < raw.length && ARTICLES.has(raw[cursor]!)) cursor += 1;
    let secondaryNumeric =
      NUMBER_WORDS[raw[cursor] ?? ''] ??
      (/^\d+(?:\.\d+)?$/.test(raw[cursor] ?? '') ? Number(raw[cursor]) : undefined) ??
      readFractionToken(raw[cursor] ?? '');
    if (secondaryNumeric === undefined) return;
    cursor += 1;

    // "one kilogram and five hundred grams of turkey" — the secondary amount can be a
    // compound number too, the same "hundred" (plus an optional "and" and a trailing
    // tens/ones word) that the primary amount reads above. Without this, "hundred" is left
    // where the unit is expected, the unit lookup below fails, and the whole compound falls
    // through to a count-and-query parse that adds the counter product at its default
    // weight instead of the requested total.
    if (secondaryNumeric >= 1 && raw[cursor] === 'hundred') {
      secondaryNumeric *= 100;
      cursor += 1;
      let tensCursor = cursor;
      if (raw[tensCursor] === 'and') tensCursor += 1;
      const tens = NUMBER_WORDS[raw[tensCursor] ?? ''];
      if (tens !== undefined && tens >= 20 && tens % 10 === 0) {
        secondaryNumeric += tens;
        tensCursor += 1;
        const ones = ONES_WORDS[raw[tensCursor] ?? ''];
        if (ones !== undefined) {
          secondaryNumeric += ones;
          tensCursor += 1;
        }
        cursor = tensCursor;
      } else {
        const ones = ONES_WORDS[raw[tensCursor] ?? ''];
        if (ones !== undefined) {
          secondaryNumeric += ones;
          cursor = tensCursor + 1;
        }
      }
    }

    const secondaryUnit = raw[cursor];
    const secondaryPoundsPerUnit =
      secondaryUnit === undefined
        ? undefined
        : POUND_WORDS.has(secondaryUnit)
          ? 1
          : SUB_POUND_UNITS[secondaryUnit];
    if (secondaryPoundsPerUnit === undefined) return;
    pounds += secondaryNumeric * secondaryPoundsPerUnit;
    index = cursor + 1;
  };
  readAndSecondaryUnit();

  skipArticles();
  // The `of` is the whole test. No exception for fractions: "half pound beef patties" is a
  // package name, and treating it as an amount both loses the size from the search and
  // risks ordering by weight something that is not sold that way.
  if (raw[index] !== 'of') return null;
  index += 1;

  const rest = raw.slice(index).filter((token) => !FILLER.has(token));
  // A non-positive amount ("zero pounds of turkey") is still a genuine weight phrase — the
  // unit and "of" both matched — so it must come back as a refusal, not `null`. Returning
  // `null` here would fall through to the count-and-query parser, which treats "pounds" as
  // a measure word and adds the counter product at its default weight instead of refusing.
  if (rest.length === 0) return null;

  return { pounds, rest };
}

/**
 * Split a spoken phrase into a count and a product description.
 *
 * Only a *leading* number counts. "milk two percent" keeps "two percent" as description,
 * and so does "two percent milk" — because the word after the number is a measure word.
 */
export function parseSpokenRequest(text: string): SpokenRequest {
  const raw = tokenize(text);

  // Weight first: "two pounds of sliced turkey" is one order for an amount, not two
  // turkeys, and the count parse below would otherwise read the two as a quantity.
  const weighed = parseWeightPhrase(raw);
  if (weighed !== null) {
    if (!Number.isFinite(weighed.pounds) || weighed.pounds > MAX_WEIGHT_LB || weighed.pounds <= 0) {
      return { quantity: 1, query: weighed.rest.join(' '), weightRefused: weighed.pounds };
    }
    return { quantity: 1, query: weighed.rest.join(' '), weight: weighed.pounds };
  }

  // "A 3 Musketeers bar" is one bar, and so is "an Eight O'Clock coffee" — Alexa transcribes
  // the same brand as a digit or spelled out depending on the utterance. The article is
  // filtered as filler a line later, which makes either phrasing indistinguishable from "3
  // Musketeers bars" / "eight o'clock coffees" — and the brand cannot be enumerated, since
  // numeric product names are open-ended. An article immediately before a digit *or* an
  // ordinary spelled-out number word is therefore treated as a singular marker.
  //
  // Not "couple", "few", "pair", or "both": those are quantity words in their own right
  // ("a couple of lemons", "a pair of avocados"), never the start of a number-led brand
  // name, so they must stay counts.
  //
  // Not a scale word or a digit run at or above 100, either: no number-led brand in this
  // catalog opens with one ("3 Musketeers", "7 Up", "5 Guys" all use single-digit counts),
  // and "a hundred bananas" / "a 100 bananas" / "a 1000 bananas" are genuine over-ceiling
  // counts. Without this exclusion the singular marker swallows them ahead of the count and
  // refusal branches below — both of which require `!singular` — so the request silently
  // falls through as a one-unit search for "100 bananas" instead of reporting the refused
  // quantity.
  const article = raw[0] === 'a' || raw[0] === 'an';
  const nextWord = raw[1];
  const singular =
    article &&
    nextWord !== undefined &&
    nextWord !== 'hundred' &&
    nextWord !== 'thousand' &&
    ((/^\d+$/.test(nextWord) && Number(nextWord) < 100) ||
      (nextWord in NUMBER_WORDS &&
        nextWord !== 'couple' &&
        nextWord !== 'few' &&
        nextWord !== 'pair' &&
        nextWord !== 'both'));

  const tokens = raw.filter((token) => !FILLER.has(token));
  if (tokens.length === 0) return { quantity: 1, query: '' };

  const first = tokens[0]!;
  // Decimals, not just bare digits: "1.5 thousand bananas" must read 1.5 here so "thousand"
  // below can multiply it into a refusal, the same way `parseWeightPhrase` already reads
  // "1.5 lb" — without this, `numeric` stays undefined, "thousand" is left as query text, and
  // the request resolves to quantity 1 with a search for "thousand bananas" instead of refusing.
  //
  // Slash fractions too: tokenize deliberately keeps "1/2" whole (see tokenize's comment), so
  // "1/2 bananas" must read 0.5 here the same way `parseWeightPhrase` reads "1/2 lb" — without
  // this, `numeric` stays undefined, "1/2" is left as query text, and the request resolves to
  // quantity 1 with a search for "1/2 bananas" instead of refusing the fractional count.
  const firstFractionMatch = /^(\d+)\/(\d+)$/.exec(first);
  // A bare spelled fraction with no leading whole number ("half of a banana", "a quarter of
  // a banana") — "of" and the article that would normally follow it are FILLER, already
  // gone by the time `tokens` is built, so `first` is just "half"/"quarter"/"quarters"
  // here. Reading `raw` directly (rather than `tokens`) to confirm "of" actually followed
  // is required: without it, an ordinary product that happens to start with "half" — "Half
  // & Half", "half and half" — would be misread as a fractional count too. Only the
  // `fraction + of` form, the one this system cannot honour, is a count at all.
  const firstIndexInRaw = (() => {
    let index = 0;
    while (index < raw.length && FILLER.has(raw[index]!)) index += 1;
    return index;
  })();
  const isLeadingFractionPhrase =
    FRACTION_WORDS[first] !== undefined && raw[firstIndexInRaw + 1] === 'of';
  let numeric =
    NUMBER_WORDS[first] ??
    (firstFractionMatch ? Number(firstFractionMatch[1]) / Number(firstFractionMatch[2]) : undefined) ??
    (/^\d+(?:\.\d+)?$/.test(first) ? Number(first) : undefined) ??
    (isLeadingFractionPhrase ? FRACTION_WORDS[first] : undefined);

  // "two point five bananas" — Alexa speaks a decimal count the same way it speaks a decimal
  // weight, digit words joined by "point" rather than a numeral. Without reading it here,
  // "point" is left as an unmatched token ahead of the query, and the leading whole number
  // alone confirms a count of 2 instead of refusing the unsupported fractional count of 2.5
  // — or, when a measure word follows ("two point five liter soda"), miscounts two packages
  // instead of matching the one 2.5-liter product.
  //
  // "point five bananas" — same as `parseWeightPhrase`, the leading whole-number word can be
  // omitted entirely. `first` is then `point` itself and `numeric` is undefined, so the check
  // below must not require a preceding number.
  let pointTokens = 0;
  const isBarePoint = numeric === undefined && first === 'point';
  if (isBarePoint || (numeric !== undefined && tokens[1] === 'point')) {
    const digitStart = isBarePoint ? 1 : 2;
    const digits: string[] = [];
    let cursor = digitStart;
    while (cursor < tokens.length && spokenDigitText(tokens[cursor]) !== undefined) {
      digits.push(spokenDigitText(tokens[cursor])!);
      cursor += 1;
    }
    if (digits.length > 0) {
      numeric = (numeric ?? 0) + Number(`0.${digits.join('')}`);
      pointTokens = cursor - 1;
    }
  }

  // "one hundred bananas" — "hundred" multiplies the digit word before it. Without this,
  // only "one" is read here, "hundred" stays in the query as ordinary text, and the request
  // resolves to quantity 1 with a search for "hundred bananas" instead of refusing.
  //
  // "a hundred bananas" — the leading article is filtered as FILLER before `tokens` is built,
  // so no digit word precedes "hundred" here either; treat the bare word as an implicit one.
  // A spoken decimal ("two point zero thousand") advances past `first` by `pointTokens`
  // extra tokens before any scale word, so the scale must be looked up relative to that
  // consumed position rather than a fixed offset — otherwise "thousand" is left in the
  // query while `numeric` stays the un-scaled integer, and a refusal reads as a live add.
  const isBareHundred = numeric === undefined && first === 'hundred';
  let consumedHundred = 1 + pointTokens;
  const hundredIndex = isBareHundred ? 0 : consumedHundred;
  if (((numeric !== undefined && numeric >= 1) || isBareHundred) && tokens[hundredIndex] === 'hundred') {
    numeric = (numeric ?? 1) * 100;
    consumedHundred = hundredIndex + 1;

    // "one hundred and five bananas" / "one hundred five bananas" — an optional "and" and a
    // trailing ones word extend the hundred, same as `parseWeightPhrase` does. Without this,
    // a refusal for exceeding the count ceiling reports 100 instead of the 105 actually asked
    // for.
    //
    // "one hundred twenty five bananas" / "one hundred and twenty five bananas" — the tens
    // portion needs the same treatment as the ones word: a bare tens word here can itself be
    // followed by a ones word. Without it, "twenty" is left unmatched and the refusal reports
    // 100 instead of the 125 actually asked for.
    let cursor = consumedHundred;
    if (tokens[cursor] === 'and') cursor += 1;
    const hundredTens = NUMBER_WORDS[tokens[cursor] ?? ''];
    if (hundredTens !== undefined && hundredTens >= 20 && hundredTens % 10 === 0) {
      numeric += hundredTens;
      cursor += 1;
      const tensOnes = ONES_WORDS[tokens[cursor] ?? ''];
      if (tensOnes !== undefined) {
        numeric += tensOnes;
        cursor += 1;
      }
      consumedHundred = cursor;
    } else {
      const hundredOnes = ONES_WORDS[tokens[cursor] ?? ''];
      if (hundredOnes !== undefined) {
        numeric += hundredOnes;
        consumedHundred = cursor + 1;
      }
    }
  }

  // "one thousand bananas" / "a thousand bananas" — same reasoning as "hundred" above, one
  // scale word up. Without this, "thousand" is left in the query as ordinary text and the
  // request resolves to quantity 1 with a search for "thousand bananas" instead of refusing.
  //
  // "thousand island dressing" — a number-led product name, same as "seven up" or "three
  // musketeers". Without this exception, the leading "thousand" is read as an implicit count
  // of 1,000 and the request is refused before catalog search ever sees the product. This
  // applies whether "thousand" opens the phrase ("thousand island dressing") or is itself
  // preceded by a count ("one thousand island dressing", "two thousand islands dressings") —
  // in both cases "island" right after "thousand" means the product name, not a multiplier.
  const isBareThousand = numeric === undefined && first === 'thousand';
  const thousandIndex = isBareThousand ? 0 : consumedHundred;
  const isThousandIsland = tokens[thousandIndex] === 'thousand' && tokens[thousandIndex + 1] === 'island';
  if (
    !isThousandIsland &&
    ((numeric !== undefined && numeric >= 1) || isBareThousand) &&
    tokens[thousandIndex] === 'thousand'
  ) {
    numeric = (numeric ?? 1) * 1000;
    consumedHundred = thousandIndex + 1;
  }

  // "twenty one bananas" / "thirty five bananas" — every tens word from twenty through ninety
  // can be followed by a ones word to build a compound. Reading only the bare tens word still
  // refuses the count (all of them exceed MAX_QUANTITY), but misreports the spoken amount in
  // the refusal message unless the ones word is consumed too — the same trap
  // `parseWeightPhrase` guards against.
  let consumed = consumedHundred;
  if (numeric !== undefined && numeric >= 20 && numeric % 10 === 0) {
    const ones = ONES_WORDS[tokens[consumed] ?? ''];
    if (ones !== undefined) {
      numeric += ones;
      consumed += 1;
    }
  }
  // "one and a half bananas" / "one and 1/2 bananas" / "one and 0.5 bananas" — Alexa's spoken
  // fraction, with "and" and the article already dropped as filler by the time `tokens` is
  // built, so the fraction token would otherwise sit right where a measure word goes. Folding
  // it into `numeric` here turns the count into 1.5, which the existing `Number.isInteger`
  // check below already refuses the same way it refuses a digit fraction like "1.5 bananas"
  // — instead of silently reading a plain count of 1 and leaving the fraction behind as query
  // text, which would perform a live one-unit add for an amount nobody asked for.
  // "one and three quarters bananas" — same as the weight parser's `readAndAHalf`, a leading
  // ones word before the fraction multiplies it. Without reading it here, "three" is left as
  // an unmatched fraction lookup, the count resolves to a bare 1, and "three quarters bananas"
  // is left as query text — performing a live one-unit add for the unsupported 1.75-item
  // request instead of refusing it.
  const fractionLeadingOnes = ONES_WORDS[tokens[consumed] ?? ''];
  const fractionCursor = fractionLeadingOnes !== undefined ? consumed + 1 : consumed;
  const fraction = tokens[fractionCursor] !== undefined ? readFractionToken(tokens[fractionCursor]!) : undefined;

  // "two half-gallon milks" / "three quarter-pound burger patties" — a fraction word
  // directly after the count, with no "and" separating them, names the size of each
  // product, not an amount to add to the count. "and" is filler and already gone from
  // `tokens` by the time this runs, so `raw` is walked here to confirm "and" actually
  // separated the count from the fraction — the same distinction `readAndAHalf` draws for
  // weights. Without this check, "two half-gallon milks" folds to a count of 2.5, leaves
  // "gallon milks" for the measure-word parser below, and resolves to a live one-item add
  // instead of matching two half-gallon cartons.
  const rawIndexOfMeaningful = (n: number): number => {
    let seen = 0;
    for (const [index, token] of raw.entries()) {
      if (FILLER.has(token)) continue;
      if (seen === n) return index;
      seen += 1;
    }
    return raw.length;
  };
  const hasAndBeforeFraction = raw
    .slice(rawIndexOfMeaningful(consumed - 1) + 1, rawIndexOfMeaningful(fractionCursor))
    .includes('and');

  if (numeric !== undefined && numeric >= 1 && fraction !== undefined && hasAndBeforeFraction) {
    numeric += fraction * (fractionLeadingOnes ?? 1);
    consumed = fractionCursor + 1;
  }

  const second = tokens[consumed];

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

  // "two dozen eggs" is two cartons, not one. A number before a package word is a genuine
  // count when the phrasing says so — `dozen` always, and the others only when "of" follows,
  // which is what separates "three packs of gum" (three) from "six pack soda" (one). The
  // test is against `raw`, since "of" is filler and has already been dropped from `tokens`.
  //
  // Located by walking to the (consumed + 1)th meaningful token rather than
  // `raw.indexOf(second)`, which would find an earlier copy of the same word and test the
  // wrong neighbour — and which shifts by one when the count itself was a compound.
  const secondAt = (() => {
    let seen = 0;
    for (const [index, token] of raw.entries()) {
      if (FILLER.has(token)) continue;
      seen += 1;
      if (seen === consumed + 1) return index;
    }
    return -1;
  })();

  const multiplies =
    second !== undefined &&
    (second === 'dozen' ||
      (PLURAL_PACKAGE_WORDS.has(second) && secondAt >= 0 && raw[secondAt + 1] === 'of'));

  // Composition words only describe the product, rather than counting it, when the head
  // noun of the phrase is singular — see `COMPOSITION_WORDS` for why this check is scoped
  // to that set rather than all of `MEASURE_WORDS`. Words ending in "us" (hummus, couscous)
  // are excluded from the plural heuristic since they are singular despite the trailing s.
  //
  // The head noun is the last word of the noun phrase that starts right after the
  // composition word, not simply the last token of the whole utterance — "four cheese Texas
  // toast" has an adjective ("Texas") between "cheese" and the actual head noun "toast", so
  // the noun phrase runs to the end. But "two cheese pizzas for dinner" has a trailing
  // modifier ("for dinner") *after* the head noun, and "for" is filler already stripped from
  // `tokens`, so reading the last token there picks "dinner" instead of "pizzas". Walking
  // `raw` (which still has the filler) from the composition word to the next filler word, or
  // to the end if none follows, finds the noun phrase's actual boundary in both cases.
  //
  // "and" is excepted from that stop set: "two cheese and pepperoni pizzas" uses it to join
  // toppings *within* the noun phrase, not to introduce a trailing modifier the way "for"
  // does — stopping there would read "cheese" as the (singular) head and lose the count.
  let headEnd = raw.length;
  if (secondAt >= 0) {
    for (let i = secondAt + 1; i < raw.length; i += 1) {
      if (raw[i] === 'and') continue;
      if (FILLER.has(raw[i]!)) {
        headEnd = i;
        break;
      }
    }
  }
  const headNoun = secondAt >= 0 && headEnd > secondAt + 1 ? raw[headEnd - 1] : undefined;
  const isMeasureWord =
    second !== undefined &&
    MEASURE_WORDS.has(second) &&
    (!COMPOSITION_WORDS.has(second)
      ? true
      : headNoun === undefined ||
        !(headNoun.length > 3 && headNoun.endsWith('s') && !headNoun.endsWith('ss') && !headNoun.endsWith('us')));

  // "2-in-1 shampoo" tokenizes to "2 in 1 shampoo" — the leading number describes the
  // product's formulation, not how many are wanted, the same trap as "two percent milk".
  // "in" is not itself a measure word (it is ordinary filler everywhere else), so it is
  // only read this way immediately followed by "one"/"1"; without this, the phrase reads
  // as quantity 2 with query "in 1 shampoo", and confirming the product adds two.
  const isNumberInOne =
    second === 'in' && (tokens[consumed + 1] === 'one' || tokens[consumed + 1] === '1');

  const isCount =
    !singular &&
    !startsBrand &&
    numeric !== undefined &&
    // Zero is not a count, it is a refusal. "add 0 bananas" would otherwise reach
    // `addItem` with quantity 0, and the initial mutation adds a line regardless —
    // only quantities above one get adjusted — so asking for none would add one.
    numeric > 0 &&
    // Above the ceiling every surface enforces, the number is not a count this system can
    // act on — and treating it as one issues that many live mutations. It stays in the
    // query instead, so the search sees the words that were actually said.
    numeric <= MAX_QUANTITY &&
    // A fractional count ("1.5 bananas") is not a count this system can act on either —
    // `addItem` truncates it and performs a live add at the reduced amount, confirming a
    // quantity nobody asked for. It is refused below instead of silently rounded.
    Number.isInteger(numeric) &&
    tokens.length > consumed &&
    !(isMeasureWord && !multiplies) &&
    !isNumberInOne;

  if (isCount) {
    return { quantity: numeric!, query: tokens.slice(consumed).join(' ') };
  }
  // A count this system will not act on. Reported rather than quietly folded into the
  // query, so the surface can say so instead of adding one of something.
  if (
    !singular &&
    !startsBrand &&
    numeric !== undefined &&
    (numeric > MAX_QUANTITY || !Number.isInteger(numeric)) &&
    tokens.length > consumed &&
    !(isMeasureWord && !multiplies) &&
    !isNumberInOne
  ) {
    return { quantity: 1, query: tokens.join(' '), quantityRefused: numeric };
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
export function tokensMatch(queryToken: string, productToken: string): boolean {
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
    // "strawberries" → "strawberry". Without this the -s and -es forms give "strawberrie"
    // and "strawberri", neither of which is the word anyone said, so coverage stayed at
    // zero and an add reported PRODUCT_NOT_FOUND while HEB had returned the right product.
    if (token.length > 4 && token.endsWith('ies')) forms.push(`${token.slice(0, -3)}y`);
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
 * `PRODUCT_NOT_FOUND` — a recoverable state, since `addItem({ text })` can still put the
 * request on the list as a plain written line. See errors.ts.
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
