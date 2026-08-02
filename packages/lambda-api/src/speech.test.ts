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
});
