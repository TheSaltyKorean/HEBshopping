/**
 * Product names here are copied verbatim from real HEB search results, because the whole
 * problem is that they are longer and noisier than anyone would invent for a fixture.
 */

import { describe, expect, it } from 'vitest';
import type { ListItem } from '@heb/core';
import {
  cardList,
  escapeSsml,
  extractSize,
  speakableItem,
  speakableJoin,
  speakableList,
  speakableOffers,
  speakablePounds,
  speakableProduct,
} from './speech.js';

const product = (name: string) => ({ id: '1', name });

const line = (name: string, quantity = 1): ListItem => ({
  lineId: 'l',
  product: product(name),
  text: name,
  quantity,
});

describe('speakableProduct', () => {
  it.each([
    ['Oatly The Original Oat Milk, 1/2 gal', 'Oatly The Oat Milk'],
    ['H-E-B Grade AA Large White Eggs, 12 ct', 'H-E-B Grade AA Large White Eggs'],
    ['Bounty Select-A-Size Paper Towels, 6 rolls', 'Bounty Select-A-Size Paper Towels'],
  ])('shortens %s', (name, expected) => {
    expect(speakableProduct(product(name))).toBe(expected);
  });

  it.each([
    'Hatch Medium Green Chile with Roasted Garlic Enchilada Sauce, 15 oz',
    'H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz',
    'H-E-B Select Ingredients Organic Reduced Fat 2% Milk, 1 gal',
  ])('keeps the category word when shortening "%s"', (name) => {
    // The last word says what the thing *is*. "Hatch Medium Green Chile with Roasted"
    // identifies nothing, so truncation must never eat the tail.
    const spoken = speakableProduct(product(name));
    const lastMeaningfulWord = name.replace(/,[^,]*$/, '').split(/\s+/).at(-1)!;
    expect(spoken).toContain(lastMeaningfulWord);
  });

  it('keeps the brand, which is usually the only discriminator', () => {
    const spoken = speakableProduct(product('Hatch Medium Green Chile with Roasted Garlic Enchilada Sauce, 15 oz'));
    expect(spoken).toContain('Hatch');
  });

  it('stays short enough to be heard', () => {
    for (const name of [
      'H-E-B Select Ingredients Organic Reduced Fat 2% Milk, 1 gal',
      'Hatch Medium Green Chile with Roasted Garlic Enchilada Sauce, 15 oz',
    ]) {
      expect(speakableProduct(product(name)).split(/\s+/).length).toBeLessThanOrEqual(6);
    }
  });

  it('drops the size, which is what the card is for', () => {
    expect(speakableProduct(product('Fresh Bananas, 3 lb'))).toBe('Fresh Bananas');
    expect(speakableProduct(product('Central Market Organics Whole Milk, 1 gal'))).not.toMatch(/gal/);
  });

  it('never returns an empty string, however noisy the name', () => {
    // Every word is in the noise list; falling through to nothing would speak silence.
    expect(speakableProduct(product('Select Ingredients Original Value Pack'))).not.toBe('');
  });
});

describe('speakableJoin', () => {
  it.each([
    [[], ''],
    [['milk'], 'milk'],
    [['milk', 'eggs'], 'milk and eggs'],
    [['milk', 'eggs', 'bread'], 'milk, eggs, and bread'],
  ])('joins %j', (parts, expected) => {
    expect(speakableJoin(parts)).toBe(expected);
  });
});

describe('speakableList', () => {
  it('reads a short list in full, with quantities above one', () => {
    const speech = speakableList([line('Fresh Bananas', 2), line('Oatly The Original Oat Milk, 1/2 gal')]);
    expect(speech).toContain('2 items');
    expect(speech).toContain('2 Fresh Bananas');
    expect(speech).not.toContain('1 Oatly'); // "1 x" is noise out loud
  });

  it('says "1 item", not "1 items"', () => {
    expect(speakableList([line('Fresh Bananas')])).toContain('1 item:');
  });

  it('caps a long list and points at the app', () => {
    const items = Array.from({ length: 20 }, (_, i) => line(`Product Number ${i}`));
    const speech = speakableList(items);

    expect(speech).toContain('20 items');
    expect(speech).toContain('Alexa app');
    expect(speech).not.toContain('Product Number 19');
  });

  it('handles an empty list', () => {
    expect(speakableList([])).toContain('empty');
  });
});

describe('cardList', () => {
  it('shows full names and sizes — nothing hidden', () => {
    const card = cardList([line('Hatch Medium Green Chile with Roasted Garlic Enchilada Sauce, 15 oz', 2)]);
    expect(card).toContain('15 oz');
    expect(card).toContain('2 × ');
  });

  it('lists every item, however many', () => {
    const items = Array.from({ length: 20 }, (_, i) => line(`Product Number ${i}`));
    expect(cardList(items).split('\n')).toHaveLength(20);
  });
});

describe('brand names survive shortening', () => {
  it.each([
    ['Old El Paso Mild Green Chile Enchilada Sauce, 10 oz', 'Old El Paso'],
    ['H-E-B Mi Tienda Salsa Verde Para Enchiladas, 16 oz', 'Mi Tienda'],
  ])('%s keeps "%s"', (name, brand) => {
    // Spanish articles look like filler and are not: stripping them turns "Old El Paso"
    // into "Old Paso", which is a different, nonexistent brand.
    expect(speakableProduct(product(name))).toContain(brand);
  });
});

describe('SSML escaping', () => {
  it.each([
    ['H-E-B Half & Half', '&amp;'],
    ['Ben & Jerry’s <Special>', '&lt;'],
  ])('escapes XML-significant characters in %s', (name, expected) => {
    // speak() emits SSML; a raw ampersand makes the whole response invalid, so the product
    // simply fails to be spoken at all.
    expect(escapeSsml(name)).toContain(expected);
  });

  it('leaves ordinary names untouched', () => {
    expect(escapeSsml('Fresh Bananas')).toBe('Fresh Bananas');
  });
});

describe('speakableOffers — offers must be distinguishable by ear', () => {
  it('restores size when two candidates collapse to the same spoken name', () => {
    // Otherwise the dialog asks an unanswerable question: identical words, different
    // product ids, and "yes" picks a variant the user had no way to choose.
    const spoken = speakableOffers([
      product('Hill Country Fare Mild Enchilada Sauce, 10 oz'),
      product('Hill Country Fare Mild Enchilada Sauce, 28 oz'),
    ]);
    expect(spoken[0]).not.toBe(spoken[1]);
    expect(spoken[0]).toContain('10 oz');
    expect(spoken[1]).toContain('28 oz');
  });

  it('leaves already-distinct names short', () => {
    const spoken = speakableOffers([
      product('Hatch Mild Green Enchilada Sauce, 15 oz'),
      product('Old El Paso Red Enchilada Sauce, 10 oz'),
    ]);
    expect(spoken.every((name) => !/\d+\s*oz/.test(name))).toBe(true);
  });

  it.each([
    ['Hatch Mild Green Enchilada Sauce, 15 oz', '15 oz'],
    ['H-E-B Grade AA Large White Eggs, 12 ct', '12 ct'],
    ['Oatly The Original Oat Milk, 1/2 gal', '1/2 gal'],
  ])('extracts the size from %s', (name, expected) => {
    expect(extractSize(name)).toBe(expected);
  });
});

describe('free-text lines have no product', () => {
  const freeText = (text: string, quantity = 1): ListItem => ({ lineId: 'g1', text, quantity });

  it('speaks the note verbatim', () => {
    // Created by the H-E-B mobile app's `Add "<text>" to your list`. There is no catalog
    // product to shorten, and what the user typed is already short.
    expect(speakableItem(freeText('pico de gallo'))).toBe('pico de gallo');
  });

  it('reads alongside product lines without crashing', () => {
    const speech = speakableList([freeText('pico de gallo', 2), line('Fresh Bananas')]);
    expect(speech).toContain('2 pico de gallo');
    expect(speech).toContain('Fresh Bananas');
    expect(speech).toContain('2 items');
  });

  it('appears on the card', () => {
    expect(cardList([freeText('pico de gallo')])).toContain('pico de gallo');
  });

  it('caps unbounded free text so it cannot blow the response budget on its own', () => {
    // The MCP `text` input has no length limit, unlike the mobile app's typed notes.
    const spoken = speakableItem(freeText('x'.repeat(20_000)));
    expect(spoken.length).toBeLessThan(100);
    expect(spoken.endsWith('…')).toBe(true);
  });

  it('does not split a surrogate pair when capping free text', () => {
    // A code-unit cut point can land between an emoji's two UTF-16 halves, leaving a lone
    // surrogate that would render as a corrupted glyph.
    const spoken = speakableItem(freeText(`${'x'.repeat(79)}😀${'y'.repeat(20)}`));
    expect(spoken.endsWith('…')).toBe(true);
    expect(spoken.isWellFormed()).toBe(true);
  });
});

describe('offers are always distinguishable', () => {
  it('falls back to full names when the size does not separate them', () => {
    // Adding the size is not always enough: these two share it, so the shortened forms
    // stay identical and "yes" would pick a product the user could not choose.
    const spoken = speakableOffers([
      product('Acme Original Tomato Sauce, 12 oz'),
      product('Acme Classic Tomato Sauce, 12 oz'),
    ]);
    expect(spoken[0]).not.toBe(spoken[1]);
  });

  it('falls back when neither candidate carries a size', () => {
    const spoken = speakableOffers([
      product('Acme Original Tomato Sauce'),
      product('Acme Classic Tomato Sauce'),
    ]);
    expect(spoken[0]).not.toBe(spoken[1]);
  });
});

describe('the card must fit inside Alexa limits', () => {
  it('truncates a very long list and says how many were dropped', () => {
    // Alexa rejects the whole response if the card is too big, so an unbounded card fails
    // ReadListIntent on exactly the long lists the card exists to serve — and the user
    // hears nothing rather than the seven items prepared for speech.
    const items = Array.from({ length: 500 }, (_, i) =>
      line(`H-E-B Select Ingredients Product Number ${i} With A Long Descriptive Name, 16 oz`),
    );
    const card = cardList(items);

    expect(card.length).toBeLessThanOrEqual(7_000);
    expect(card).toMatch(/and \d+ more \(500 items in total\)/);
  });

  it('budgets by UTF-8 bytes, not UTF-16 length, so emoji-heavy names cannot double the wire size', () => {
    // An emoji is 2 UTF-16 code units but 4 UTF-8 bytes. Budgeting by `.length` would let a
    // card built from these pass a 7,000-character check while serializing to roughly twice
    // that on the wire, where Alexa's cap actually applies.
    const items = Array.from({ length: 500 }, (_, i) => line(`${'😀'.repeat(20)} Product ${i}`));
    const card = cardList(items);

    expect(Buffer.byteLength(card, 'utf8')).toBeLessThanOrEqual(7_000);
  });

  it('accounts for JSON-escaping, so quote-heavy names truncate earlier than plain ones of the same length', () => {
    // The card is JSON-serialized into the response, so a quote or backslash costs an extra
    // escape byte on the wire that raw UTF-8 byte counting misses entirely — budgeting only
    // raw bytes would admit exactly as many quote-heavy lines as plain ones of the same
    // length, then serialize to well past the 7,000-byte cap.
    const plain = Array.from({ length: 500 }, (_, i) => line(`Product Number ${i} padding padding pad`));
    const quoted = Array.from({ length: 500 }, (_, i) => line(`"Product\\Number\\${i}" padding padding p`));

    const plainCount = cardList(plain).split('\n').length;
    const quotedCount = cardList(quoted).split('\n').length;

    expect(quotedCount).toBeLessThan(plainCount);
    expect(Buffer.byteLength(JSON.stringify(cardList(quoted)), 'utf8')).toBeLessThanOrEqual(8_000);
  });

  it('leaves an ordinary list complete', () => {
    const card = cardList([line('Fresh Bananas'), line('H-E-B Half & Half, 32 oz')]);
    expect(card.split('\n')).toHaveLength(2);
    expect(card).not.toContain('more (');
  });

  it('keeps a truncated first line instead of an empty card, when the first item alone exceeds the budget', () => {
    // Previously, hitting the budget broke the loop unconditionally and pushed only the
    // footer, so an oversized first item left the card with zero item names, discarding
    // every already-scheduled and still-to-come line along with the offending one.
    const huge: ListItem = { lineId: 'l0', text: 'X'.repeat(50_000), quantity: 1 };
    const card = cardList([huge, line('Milk')]);

    expect(card.split('\n')[0]).not.toBe('');
    expect(card.split('\n')[0]).toContain('…');
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(8_000);
  });

  it('accounts for the JSON-escaped newline between lines, so many short lines stay under the wire cap', () => {
    // Once the whole card is embedded in the Lambda's JSON response, each `\n` joining lines
    // escapes to a 2-byte sequence, not 1 — undercounting it let enough short lines add up to
    // more encoded bytes than the raw budget check saw.
    const items = Array.from({ length: 3_000 }, (_, i) => line(`${i}`));
    const card = cardList(items);

    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(8_000);
  });
});

describe('speakablePounds', () => {
  // Alexa reads a bare 0.25 as "zero point two five", which is not how deli meat is ordered.
  it('says the fractions a quarter-pound ladder actually produces', () => {
    expect(speakablePounds(0.25)).toBe('a quarter pound');
    expect(speakablePounds(0.5)).toBe('half a pound');
    expect(speakablePounds(0.75)).toBe('three quarters of a pound');
  });

  it('says whole pounds naturally', () => {
    expect(speakablePounds(1)).toBe('a pound');
    expect(speakablePounds(2)).toBe('2 pounds');
  });

  it('combines a whole part with its fraction', () => {
    expect(speakablePounds(1.5)).toBe('a pound and a half');
    expect(speakablePounds(2.25)).toBe('2 pounds and a quarter');
  });

  it('falls back to plain pounds for a weight off the ladder', () => {
    expect(speakablePounds(1.3)).toBe('1.3 pounds');
  });
});

describe('speakableList — weighted lines', () => {
  it('reads a counter line in pounds, not as one unit', () => {
    const item = {
      lineId: 'l1',
      product: { id: 'p1', name: 'H-E-B Deli Honey-Smoked Turkey Breast, Custom Sliced, lb' },
      text: 'H-E-B Deli Honey-Smoked Turkey Breast, Custom Sliced, lb',
      quantity: 1,
      weight: 2,
    };
    expect(speakableList([item])).toContain('2 pounds of');
  });
});
