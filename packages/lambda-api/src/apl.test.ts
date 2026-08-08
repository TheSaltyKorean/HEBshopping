import { describe, expect, it } from 'vitest';
import type { HebList, ListItem } from '@heb/core';
import { listRenderDirective, supportsApl } from './apl.js';

function item(partial: Partial<ListItem> & { text: string }): ListItem {
  return { lineId: `l-${partial.text}`, quantity: 1, ...partial };
}

function list(items: ListItem[], name = 'Shopping'): HebList {
  return { listId: 'list-1', name, storeId: null, items };
}

/** A plain Echo: no `device` block at all, which is what a real speaker request looks like. */
const speaker = { context: { System: {} } } as never;

/** An Echo Show. Alexa advertises the interface by presence; the value itself is opaque. */
const screen = {
  context: { System: { device: { supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
} as never;

interface Directive {
  type: string;
  token: string;
  datasources: {
    hebList: {
      title: string;
      subtitle: string;
      items: Array<{ primaryText: string; secondaryText?: string }>;
    };
  };
}

const render = (envelope: never, l: HebList): Directive =>
  listRenderDirective(envelope, l) as Directive;

describe('supportsApl', () => {
  it('is false for a speaker, so no directive is ever aimed at a device without a screen', () => {
    // Not cosmetic: Alexa rejects the entire response when a directive names an unsupported
    // interface, so getting this wrong would break the skill on plain Echoes rather than
    // degrade it.
    expect(supportsApl(speaker)).toBe(false);
  });

  it('is true when the device advertises the interface', () => {
    expect(supportsApl(screen)).toBe(true);
  });

  it('treats a request with no context at all as no screen', () => {
    expect(supportsApl({} as never)).toBe(false);
  });
});

describe('listRenderDirective', () => {
  it('returns null for a speaker, leaving its response exactly as it was', () => {
    expect(listRenderDirective(speaker, list([item({ text: 'Milk' })]))).toBeNull();
  });

  it('renders one row per line, titled with the list name', () => {
    const directive = render(screen, list([item({ text: 'Milk' }), item({ text: 'Eggs' })]));

    expect(directive.type).toBe('Alexa.Presentation.APL.RenderDocument');
    expect(directive.datasources.hebList.title).toBe('Shopping');
    expect(directive.datasources.hebList.items.map((row) => row.primaryText)).toEqual([
      'Milk',
      'Eggs',
    ]);
  });

  it('uses a stable token, so a second read replaces the screen instead of stacking', () => {
    const first = render(screen, list([item({ text: 'Milk' })]));
    const second = render(screen, list([item({ text: 'Eggs' })]));
    expect(first.token).toBe(second.token);
  });

  it('prefers the catalog name over the free text, which is what is on the shelf', () => {
    const withProduct = item({
      text: 'half and half',
      product: { id: 'p1', name: 'H-E-B Half & Half' } as ListItem['product'],
    });
    expect(render(screen, list([withProduct])).datasources.hebList.items[0]?.primaryText).toBe(
      'H-E-B Half & Half',
    );
  });

  describe('the amount column', () => {
    it('is absent for a single item, because "× 1" on every line is noise', () => {
      expect(
        render(screen, list([item({ text: 'Milk' })])).datasources.hebList.items[0],
      ).not.toHaveProperty('secondaryText');
    });

    it('shows a count above one', () => {
      expect(
        render(screen, list([item({ text: 'Rolls', quantity: 2 })])).datasources.hebList.items[0]
          ?.secondaryText,
      ).toBe('× 2');
    });

    it('shows weight in pounds, and prefers it over quantity', () => {
      // A weighed line's quantity is not the thing being bought — two pounds of turkey is
      // one line with a weight, and reading back "× 1" would be actively wrong.
      expect(
        render(screen, list([item({ text: 'Turkey', quantity: 1, weight: 2 })])).datasources
          .hebList.items[0]?.secondaryText,
      ).toBe('2 lb');
    });
  });

  describe('the subtitle', () => {
    it('says the list is empty rather than showing a blank screen', () => {
      expect(render(screen, list([])).datasources.hebList.subtitle).toBe('Empty');
    });

    it('counts a single item without pluralising', () => {
      expect(render(screen, list([item({ text: 'Milk' })])).datasources.hebList.subtitle).toBe(
        '1 item',
      );
    });

    it('counts several', () => {
      expect(
        render(screen, list([item({ text: 'Milk' }), item({ text: 'Eggs' })])).datasources.hebList
          .subtitle,
      ).toBe('2 items');
    });
  });

  describe('a list longer than the screen budget', () => {
    // The cap exists because Alexa counts directives toward a 24 KB response limit, and an
    // unbounded list would fail the read outright on exactly the lists worth displaying.
    const many = list(Array.from({ length: 200 }, (_, i) => item({ text: `Item ${i}` })));

    it('stops at the cap', () => {
      expect(render(screen, many).datasources.hebList.items).toHaveLength(120);
    });

    it('says what it dropped, so a truncated list cannot pass for a complete one', () => {
      // Someone shopping from a silently truncated list leaves the shop without the rest.
      expect(render(screen, many).datasources.hebList.subtitle).toBe('Showing 120 of 200 items');
    });
  });
});
