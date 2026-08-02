/**
 * Product names here are copied verbatim from real HEB search results, because the whole
 * problem is that they are longer and noisier than anyone would invent for a fixture.
 */

import { describe, expect, it } from 'vitest';
import type { ListItem } from '@heb/core';
import { cardList, speakableJoin, speakableList, speakableProduct } from './speech.js';

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
