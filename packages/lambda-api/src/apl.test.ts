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

/** An older APL device that reports a runtime below the document's version. */
const oldScreen = {
  context: {
    System: {
      device: { supportedInterfaces: { 'Alexa.Presentation.APL': { runtime: { maxVersion: '1.7' } } } },
    },
  },
} as never;

/** A current-generation Show, whose reported runtime matches the document's version. */
const currentScreen = {
  context: {
    System: {
      device: {
        supportedInterfaces: { 'Alexa.Presentation.APL': { runtime: { maxVersion: '2023.3' } } },
      },
    },
  },
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

  it('is false for a device whose reported runtime cannot render this document', () => {
    // Sending the directive anyway does not degrade — Alexa rejects the whole response —
    // so an under-versioned device has to be treated the same as no screen at all.
    expect(supportsApl(oldScreen)).toBe(false);
  });

  it('is true for a device whose reported runtime matches the document version', () => {
    expect(supportsApl(currentScreen)).toBe(true);
  });
});

describe('listRenderDirective', () => {
  it('returns null for a speaker, leaving its response exactly as it was', () => {
    expect(listRenderDirective(speaker, list([item({ text: 'Milk' })]))).toBeNull();
  });

  it('returns null for a device too old to render this document, same as a speaker', () => {
    expect(listRenderDirective(oldScreen, list([item({ text: 'Milk' })]))).toBeNull();
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

  describe('a list within the row cap but over the size budget', () => {
    // Long free-text names have no length bound of their own, so well under 120 rows can
    // still serialize past the size budget — the row count alone cannot be trusted.
    const longNamed = list(
      Array.from({ length: 100 }, (_, i) => item({ text: `${'X'.repeat(200)} ${i}` })),
    );

    it('stops before the row cap once the serialized size budget is spent', () => {
      const shown = render(screen, longNamed).datasources.hebList.items;
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(100);
    });

    it('keeps at least one row, truncated to fit the budget, when the name alone would exceed it', () => {
      // A row-count-only cap would exempt this one row from the size budget entirely — the
      // MCP `text` input has no length limit, so an oversized first item still has to be
      // trimmed rather than sent whole, or it alone could blow Alexa's 24 KB response cap.
      const huge = list([item({ text: 'Y'.repeat(50_000) })]);
      const items = render(screen, huge).datasources.hebList.items;
      expect(items).toHaveLength(1);
      expect(items[0]?.primaryText.length).toBeLessThan(50_000);
      expect(items[0]?.primaryText.endsWith('…')).toBe(true);
    });

    it('truncates by encoded size, not raw length, when the name needs JSON escaping', () => {
      // Each `"` or `\` costs two characters once serialized, not one — a raw-length budget
      // would let a row like this come out roughly double the intended size.
      const escapeHeavy = list([item({ text: '"\\'.repeat(30_000) })]);
      const row = render(screen, escapeHeavy).datasources.hebList.items[0];
      expect(row).toBeDefined();
      expect(JSON.stringify(row).length).toBeLessThan(12_100);
    });

    it('never cuts a surrogate pair in half, even when one straddles the truncation point', () => {
      // A code-unit cut point can land between an emoji's two UTF-16 halves, leaving a lone
      // surrogate that renders as a corrupted glyph on the Show instead of the character.
      const withEmoji = list([item({ text: `${'X'.repeat(11_999)}😀${'X'.repeat(1_000)}` })]);
      const row = render(screen, withEmoji).datasources.hebList.items[0];
      expect(row).toBeDefined();
      expect(row?.primaryText.isWellFormed()).toBe(true);
      expect(row?.primaryText.endsWith('…')).toBe(true);
    });
  });
});
