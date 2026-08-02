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
    .replace(/,[^,]*$/, '') // trailing ", 15 oz" / ", 12 ct"
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

/** Join a list the way a person would say it: "a, b, and c". */
export function speakableJoin(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
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

  const spoken = items.slice(0, MAX_SPOKEN_ITEMS).map((item) => {
    const name = speakableProduct(item.product);
    return item.quantity > 1 ? `${item.quantity} ${name}` : name;
  });

  const count = `${items.length} item${items.length === 1 ? '' : 's'}`;
  if (items.length <= MAX_SPOKEN_ITEMS) {
    return `You have ${count}: ${speakableJoin(spoken)}.`;
  }
  return (
    `You have ${count}. The first ${MAX_SPOKEN_ITEMS} are: ${speakableJoin(spoken)}. ` +
    `I've put the whole list in your Alexa app.`
  );
}

/** Plain-text card body: no length limit, so nothing is hidden here. */
export function cardList(items: readonly ListItem[]): string {
  if (items.length === 0) return 'Your H-E-B list is empty.';
  return items
    .map((item) => `${item.quantity > 1 ? `${item.quantity} × ` : ''}${item.product.name}`)
    .join('\n');
}
