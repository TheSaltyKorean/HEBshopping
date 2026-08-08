/**
 * Turning products and lists into things worth hearing.
 *
 * Voice has constraints a screen does not, and they drive everything in this file:
 *
 * - **Nothing can be skimmed.** A listener processes words in order, at the speed they are
 *   spoken, and cannot glance back. Long names are not merely tedious, they are unusable.
 * - **Nothing can be scrolled.** A ten-item list read aloud is forgotten by item four.
 * - **The clock is running.** Alexa cuts the response off at roughly eight seconds.
 *
 * So: shorten aggressively, cap how much is read, and put the overflow on a card in the
 * Alexa app where it can be looked at rather than remembered.
 */

import type { ListItem, Product } from '@heb/core';

/**
 * Marketing and packaging words that add syllables without helping anyone choose.
 *
 * Real HEB names are relentless: "H-E-B Select Ingredients Organic Reduced Fat 2% Milk".
 * The distinguishing parts of that are "H-E-B" and "2% milk"; the rest is noise the moment
 * it is spoken rather than read.
 */
const NOISE = new Set([
  'select', 'ingredients', 'quality', 'premium', 'original', 'classic', 'style',
  'brand', 'value', 'great', 'signature', 'traditional', 'authentic', 'natural',
  'flavored', 'flavor', 'assorted', 'variety', 'pack', 'count', 'ct', 'ea',
  'with', 'of',
  // "Salsa Verde **Para** Enchiladas" — a connective, like "with".
  //
  // Only `para`. The obvious extension to the other Spanish function words is wrong here:
  // "el", "la" and "de" occur inside brand names, and stripping them turns "Old El Paso"
  // into "Old Paso". heb-core's matching FILLER *can* drop them, because there it removes
  // the same word from both the query and the product name; this list rewrites a name a
  // person is about to hear, so a mangled brand is a real defect.
  'para',
]);

/** How many words of a product name to speak. Beyond this, listeners stop tracking. */
const MAX_SPOKEN_WORDS = 6;

/**
 * When truncating, how many words to keep from the front.
 *
 * Product names are brand-first and category-last: "Hatch Medium Green Chile with Roasted
 * Garlic Enchilada **Sauce**". Cutting the tail therefore removes the single word that says
 * what the thing *is* — "Hatch Medium Green Chile with Roasted" identifies nothing. Keeping
 * both ends and dropping the middle preserves the two parts that actually distinguish it.
 */
const HEAD_WORDS = 3;

/**
 * Shorten a product name to something sayable, keeping what distinguishes it.
 *
 * Size is dropped: it is the least useful part when choosing between products by ear, and
 * it is exactly what the Alexa app card is for. The brand is kept because it is usually
 * *the* discriminator between otherwise-identical items.
 */
export function speakableProduct(product: Product): string {
  const withoutSize = product.name
    // Trailing ", 15 oz" / ", 12 ct" / ", 6 rolls" / ", 1/2 gal" — but not an arbitrary
    // trailing clause. "Acme Macaroni, Beef, and Tomato" has no size to drop, and stripping
    // "Beef" would confirm a shortened name the listener was never fully told.
    .replace(
      /,\s*\d+(\.\d+)?(\/\d+)?\s*(oz|lb|lbs|ct|count|gal|qt|l|ml|g|kg|pk|pack|packs|roll|rolls|dozen)\.?\s*$/i,
      '',
    )
    .replace(/\b\d+(\.\d+)?\s*(oz|lb|lbs|ct|gal|qt|l|ml|g|kg|pk)\b/gi, '')
    .replace(/\b\d+\/\d+\s*(gal|lb)\b/gi, '');

  const words = withoutSize
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !NOISE.has(word.toLowerCase()));

  const kept = words.length > 0 ? words : withoutSize.split(/\s+/).filter(Boolean);
  if (kept.length <= MAX_SPOKEN_WORDS) return kept.join(' ').trim();

  // Widen the head to whatever the brand actually needs rather than assuming a width:
  // "Old El Paso" and "Central Market Organics" are three words, and clipping either
  // mid-brand produces a name that does not exist.
  const brandWords = product.brand === undefined ? 0 : product.brand.split(/\s+/).length;
  const head = Math.min(Math.max(HEAD_WORDS, brandWords), MAX_SPOKEN_WORDS - 1);

  return [...kept.slice(0, head), ...kept.slice(-(MAX_SPOKEN_WORDS - head))].join(' ').trim();
}

/**
 * XML-escape text destined for SSML.
 *
 * `ResponseBuilder.speak()` emits SSML, so a catalog name containing `&` — H-E-B sells
 * "Half & Half", among many others — produces invalid markup and the response fails to
 * speak at all. Every catalog- or slot-derived string must go through this before being
 * interpolated into speech. Card text must NOT: cards are plain text and would show the
 * entities literally.
 */
export function escapeSsml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** The size or count a product name carries, e.g. "15 oz", "12 ct". */
export function extractSize(name: string): string | null {
  // Fractions first: "1/2 gal" would otherwise match the plain-number pattern as "2 gal",
  // which is a different and wrong size.
  return (
    name.match(/(\d+\/\d+\s*(?:gal|lb|oz))\b/i)?.[1] ??
    name.match(/(\d+(?:\.\d+)?\s*(?:oz|lb|lbs|ct|gal|qt|l|ml|g|kg|pk|rolls|count))\b/i)?.[1] ??
    null
  );
}

/**
 * Spoken names for a set of candidates, guaranteed to differ from one another.
 *
 * `speakableProduct` drops size because it is noise when choosing by ear — but when two
 * candidates differ *only* by size, dropping it makes the dialog ask an unanswerable
 * question: the same words offered twice for different product ids, where "yes" picks a
 * variant the user had no way to choose. Size is restored only for the colliding names,
 * so the common case stays short.
 */
export function speakableOffers(products: readonly Product[]): string[] {
  const base = products.map(speakableProduct);
  const tally = (names: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  };

  const initial = tally(base);
  const withSizes = base.map((name, index) => {
    if ((initial.get(name) ?? 0) < 2) return name;
    const size = extractSize(products[index]!.name);
    return size === null ? name : `${name}, ${size}`;
  });

  // Re-check, because adding the size does not always separate them: two products can
  // share a size ("Acme Original Tomato Sauce, 12 oz" and "Acme Classic ..., 12 oz" both
  // shorten to the same words), or neither may carry one. Falling back to the full name is
  // verbose, but a long question the user can answer beats a short one they cannot.
  const after = tally(withSizes);
  return withSizes.map((name, index) =>
    (after.get(name) ?? 0) < 2 ? name : products[index]!.name,
  );
}

/**
 * How many characters of free text to speak.
 *
 * `text` is usually what a person typed by hand and short by construction — but the MCP
 * `heb_add_item` `text` input has no length limit, so a line created that way can carry
 * arbitrarily long text. Speaking it unbounded lets a single spoken line push the response
 * past Alexa's 24 KB cap on its own, on top of whatever the card and screen directive already
 * budget for. Walked by code point rather than sliced by UTF-16 index, so the cut cannot split
 * a surrogate pair (an astral character, e.g. an emoji) into an unpaired half.
 */
const MAX_SPOKEN_TEXT_CHARS = 80;

/**
 * What to speak for a list line, product-backed or not.
 *
 * A free-text line has no product to shorten, so its `text` is spoken as-is, capped at
 * `MAX_SPOKEN_TEXT_CHARS`.
 */
export function speakableItem(item: ListItem): string {
  if (item.product !== undefined) return speakableProduct(item.product);
  const chars = Array.from(item.text);
  return chars.length <= MAX_SPOKEN_TEXT_CHARS
    ? item.text
    : `${chars.slice(0, MAX_SPOKEN_TEXT_CHARS).join('')}…`;
}

/**
 * Say a weight the way a person does: "two pounds", "half a pound", "a pound and a half".
 *
 * H-E-B's ladder is in quarter-pound steps, so the fractions that actually occur are a
 * small closed set. Alexa reads a bare "0.25 pounds" as "zero point two five pounds",
 * which is not how anyone orders deli meat.
 */
export function speakablePounds(pounds: number): string {
  const FRACTIONS: Readonly<Record<string, string>> = {
    '0.25': 'a quarter pound',
    '0.5': 'half a pound',
    '0.75': 'three quarters of a pound',
  };
  const whole = Math.floor(pounds);
  const remainder = Number((pounds - whole).toFixed(2));

  if (whole === 0) return FRACTIONS[String(remainder)] ?? `${pounds} pounds`;

  const unit = whole === 1 ? 'a pound' : `${whole} pounds`;
  if (remainder === 0) return unit;

  const TAILS: Readonly<Record<string, string>> = {
    '0.25': 'and a quarter',
    '0.5': 'and a half',
    '0.75': 'and three quarters',
  };
  const tail = TAILS[String(remainder)];
  return tail === undefined ? `${pounds} pounds` : `${unit} ${tail}`;
}

/** Join a list the way a person would say it: "a, b, and c". */
export function speakableJoin(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/** One line of a read-back: "two pounds of sliced turkey", "3 avocados", "milk". */
function spokenLine(item: ListItem): string {
  if (item.weight !== undefined) {
    return `${speakablePounds(item.weight)} of ${speakableItem(item)}`;
  }
  return item.quantity > 1 ? `${item.quantity} ${speakableItem(item)}` : speakableItem(item);
}

/** How many list items to read before deferring the rest to the card. */
export const MAX_SPOKEN_ITEMS = 7;

/**
 * Read back a list, capped.
 *
 * A long list gets a count and the first few items rather than the lot: hearing twenty-six
 * products in a row tells you nothing you can act on, and would exceed the response budget
 * anyway. The full list goes to the card.
 */
export function speakableList(items: readonly ListItem[]): string {
  if (items.length === 0) return 'Your H-E-B list is empty.';

  const spoken = items.slice(0, MAX_SPOKEN_ITEMS).map(spokenLine);

  const count = `${items.length} item${items.length === 1 ? '' : 's'}`;
  if (items.length <= MAX_SPOKEN_ITEMS) {
    return `You have ${count}: ${speakableJoin(spoken)}.`;
  }
  return (
    `You have ${count}. The first ${MAX_SPOKEN_ITEMS} are: ${speakableJoin(spoken)}. ` +
    `I've put the whole list in your Alexa app.`
  );
}

/**
 * Alexa's card body limit, with headroom, in UTF-8 bytes.
 *
 * Cards are capped at 8000 characters and count toward the response as a whole, and that
 * whole-response cap (like the APL screen's, see `apl.ts`) is a byte limit — an emoji-heavy
 * item name is a handful of UTF-16 code units but roughly twice as many UTF-8 bytes, so
 * budgeting by `.length` under-counts exactly the free-text names (unbounded via the MCP
 * `text` input) that are most likely to be non-ASCII. Worse, the card is JSON-serialized into
 * the response, so a quote or backslash in a free-text name costs an extra escape byte on the
 * wire that raw UTF-8 byte counting misses entirely — the same reason `apl.ts` measures rows
 * by their serialized form rather than their raw one. Exceeding the cap makes Alexa reject
 * the *entire* response — so an unbounded card fails `ReadListIntent` outright on exactly the
 * long lists the card exists to serve, and the user hears nothing rather than the seven items
 * that were carefully prepared for speech.
 */
const MAX_CARD_CHARS = 7_000;

/**
 * What a line is called on screen or on a card.
 *
 * A catalog product carries the store's own name for it, which is what someone scanning a
 * shelf wants to read. `text` is the free-text fallback for a line H-E-B could not match.
 */
export function itemName(item: ListItem): string {
  return item.product?.name ?? item.text;
}

/**
 * The amount, as a standalone label, or undefined when there is nothing worth showing.
 *
 * A quantity of one is the default and adding "× 1" to every line is noise. Weight wins
 * over quantity because a weighed line's quantity is not the thing being bought.
 */
export function itemAmountLabel(item: ListItem): string | undefined {
  if (item.weight !== undefined) return `${item.weight} lb`;
  if (item.quantity > 1) return `× ${item.quantity}`;
  return undefined;
}

/**
 * How many UTF-8 bytes a single Unicode code point costs once JSON-encoded as part of a
 * string, excluding the surrounding quotes. Mirrors `apl.ts`'s row budgeting: an emoji is two
 * UTF-16 code units but four UTF-8 bytes, and a quote or backslash costs an extra escape byte
 * once serialized into the response.
 */
function jsonByteLength(ch: string): number {
  return Buffer.byteLength(JSON.stringify(ch), 'utf8') - 2;
}

/**
 * Shortens `line` so its JSON-escaped form fits within `maxBytes`.
 *
 * Only applied to the very first line: the loop below always keeps at least one line so the
 * card is never empty, but an oversized line must not be exempt from the budget either — free
 * text has no length bound of its own (reachable via the MCP `text` input), and dropping it
 * entirely (the previous behavior) discarded every line after it too, not just itself. Walked
 * by Unicode code point, not UTF-16 code unit, so the cut cannot split a surrogate pair — the
 * same technique `apl.ts`'s `truncateRow` uses.
 */
function truncateLine(line: string, maxBytes: number): string {
  const chars = Array.from(line);
  const budget = Math.max(1, maxBytes);
  const ellipsisCost = jsonByteLength('…');
  let cost = 0;
  let cut = 0;
  while (cut < chars.length) {
    const chCost = jsonByteLength(chars[cut] as string);
    if (cost + chCost + ellipsisCost > budget) break;
    cost += chCost;
    cut++;
  }
  return `${chars.slice(0, cut).join('')}…`;
}

/** Plain-text card body, bounded, and explicit about anything it had to drop. */
export function cardList(items: readonly ListItem[]): string {
  if (items.length === 0) return 'Your H-E-B list is empty.';

  const lines: string[] = [];
  let used = 0;
  // The lines below are joined (and the footer is prefixed) with a real `\n` character, which
  // costs 2 bytes, not 1, once this whole card is JSON-serialized into the response.
  const sepBytes = jsonByteLength('\n');

  for (const [index, item] of items.entries()) {
    // Kept as a prefix rather than reusing `itemAmountLabel`: a card is one string per line,
    // so the amount has to read inline, where "2 lb — Turkey" and "3 × Milk" are the
    // established shapes. The screen has a second column and formats the same data itself.
    const amount =
      item.weight !== undefined
        ? `${item.weight} lb — `
        : item.quantity > 1
          ? `${item.quantity} × `
          : '';
    let line = `${amount}${itemName(item)}`;
    const remaining = items.length - index;
    // Reserve room for the footer, so the truncation notice itself cannot overflow.
    const footer = `\n… and ${remaining} more (${items.length} items in total).`;
    // JSON-encoded, minus the 2 bytes for the wrapping quotes JSON.stringify adds but the
    // response body only pays once for the whole card, not once per line: a quote or
    // backslash in a free-text name costs an extra escape byte on the wire that the raw byte
    // length does not.
    let lineBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') - 2;
    const footerBytes = Buffer.byteLength(JSON.stringify(footer), 'utf8') - 2;

    if (used + lineBytes + sepBytes + footerBytes > MAX_CARD_CHARS) {
      if (lines.length === 0) {
        line = truncateLine(line, MAX_CARD_CHARS - used - sepBytes - footerBytes);
        lineBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') - 2;
      } else {
        lines.push(footer.trimStart());
        break;
      }
    }
    lines.push(line);
    used += lineBytes + sepBytes;
  }

  return lines.join('\n');
}
