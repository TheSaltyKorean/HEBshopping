/**
 * The screen half of a response, for Echo Show and other display devices.
 *
 * Speech alone is the whole product on a speaker, but on a Show a spoken list is worse than
 * useless for shopping: `speakableList` caps at seven items and then tells you to open the
 * Alexa app, while the customer is looking straight at a screen that could have shown all
 * twenty-six. This module renders that screen.
 *
 * Everything here is conditional on the device actually having one. A directive naming an
 * interface the device does not support is not ignored politely — Alexa rejects the whole
 * response — so `supportsApl` gates every use, and a plain Echo takes exactly the path it
 * always did.
 */

import type { RequestEnvelope } from 'ask-sdk-model';
import type { HebList, ListItem } from '@heb/core';
import { itemAmountLabel, itemName } from './speech.js';

/** The interface name Alexa reports in `supportedInterfaces` and expects on the directive. */
const APL_INTERFACE = 'Alexa.Presentation.APL';

/** The APL runtime version `listDocument` targets — must match its own `version` field. */
const APL_DOCUMENT_VERSION = '2023.3';

/**
 * A sanity ceiling on how many lines are even considered for the screen.
 *
 * `MAX_ITEMS_CHARS` below is the real, correctness-bearing bound on response size — this
 * just stops the loop that enforces it from walking an unbounded list, and a grocery list
 * this long is already past the point of being read on a screen.
 */
const MAX_DISPLAYED_ITEMS = 120;

/**
 * UTF-8 byte budget for the screen's own share of the response.
 *
 * Alexa caps the entire response at 24 KB — a byte limit — and counts directives toward it,
 * the same trap `MAX_CARD_CHARS` guards against for cards — but unlike a card, a row's
 * `primaryText` and `secondaryText` have no length bound of their own (a long catalog or
 * free-text item name passes straight through), so a fixed row *count* does not bound response
 * *size*. Budgeting the serialized rows' encoded byte size directly, with headroom for the
 * rest of the response (speech, and on `ReadListIntent`, a card up to `MAX_CARD_CHARS`), is
 * what actually keeps the whole thing under the cap.
 */
const MAX_ITEMS_CHARS = 12_000;

/**
 * Whether `a` is at least `b`, comparing APL version strings component-by-component
 * (e.g. "2023.3" vs "1.7") rather than as plain strings, where "1.10" would sort before
 * "1.9" lexicographically.
 */
function isAtLeastVersion(a: string, b: string): boolean {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/**
 * Whether this device has a screen that can render the document `listDocument` builds.
 *
 * Read from the request rather than assumed from the device type: the same skill serves
 * Echo speakers, Shows, Fire TV and the phone app, and only some of those can display
 * anything. Absent interfaces are absent, not false, so presence alone is checked when the
 * device does not report a runtime version at all.
 *
 * A device that *does* report one but below `APL_DOCUMENT_VERSION` cannot render this
 * document — sending it anyway does not degrade, it makes Alexa reject the whole response,
 * so an under-versioned device is treated the same as one with no screen at all.
 */
export function supportsApl(envelope: RequestEnvelope): boolean {
  const support = envelope.context?.System?.device?.supportedInterfaces?.[APL_INTERFACE];
  if (support === undefined) return false;
  const maxVersion = support.runtime?.maxVersion;
  return maxVersion === undefined || isAtLeastVersion(maxVersion, APL_DOCUMENT_VERSION);
}

type Row = { primaryText: string; secondaryText?: string };

/** One row on screen: the product on the left, its amount on the right. */
function listRow(item: ListItem): Row {
  const amount = itemAmountLabel(item);
  return amount === undefined
    ? { primaryText: itemName(item) }
    : { primaryText: itemName(item), secondaryText: amount };
}

/**
 * How many UTF-8 bytes a single Unicode code point occupies once JSON-encoded as part of a
 * string, excluding the surrounding quotes. Alexa's 24 KB response cap is a byte limit, not a
 * character-count limit, so a code unit is the wrong unit here — an emoji is two UTF-16 code
 * units but four UTF-8 bytes, and even a plain non-ASCII letter can be two or three bytes.
 * Free-text item names are not guaranteed to be free of either, so encoded byte length has to
 * be measured directly rather than approximated from `.length`.
 *
 * `ch` must be a whole code point, not a lone UTF-16 surrogate half — JSON.stringify escapes an
 * unpaired surrogate to a 6-byte `\uXXXX` sequence, wildly overcounting an astral character
 * (e.g. an emoji) whose two halves are costed separately instead of as the single 4-byte
 * sequence they serialize to together.
 */
function jsonByteLength(ch: string): number {
  return Buffer.byteLength(JSON.stringify(ch), 'utf8') - 2;
}

/**
 * Shortens `row`'s primary text so its serialized form fits within `maxChars`.
 *
 * Only applied to a first row that alone exceeds the whole screen budget: the loop below
 * always keeps at least one row so the screen is never empty, but "kept" cannot mean
 * "exempt from the budget" — item names are free text with no length bound of their own
 * (reachable through the MCP `text` input), so an oversized first row could otherwise push
 * the directive past Alexa's 24 KB response cap on its own. Alexa's cap is a byte limit, so
 * the cut point is found by walking the encoded UTF-8 byte cost rather than raw character
 * count, which undercounts both escaped characters and non-ASCII text.
 *
 * Walked by Unicode code point, not UTF-16 code unit: a code unit boundary can fall between
 * the two halves of a surrogate pair (an astral character, e.g. an emoji), leaving a lone
 * surrogate in `primaryText` that renders as a corrupted glyph on the Show.
 */
function truncateRow(row: Row, maxChars: number): Row {
  const overhead = Buffer.byteLength(JSON.stringify({ ...row, primaryText: '' }), 'utf8');
  const budget = Math.max(1, maxChars - overhead);
  const chars = Array.from(row.primaryText);

  let fullCost = 0;
  for (const ch of chars) fullCost += jsonByteLength(ch);
  if (fullCost <= budget) return row;

  const ellipsisCost = jsonByteLength('…');
  let cost = 0;
  let cut = 0;
  while (cut < chars.length) {
    const chCost = jsonByteLength(chars[cut] as string);
    if (cost + chCost + ellipsisCost > budget) break;
    cost += chCost;
    cut++;
  }
  return { ...row, primaryText: `${chars.slice(0, cut).join('')}…` };
}

/**
 * The document itself.
 *
 * `AlexaTextList` from `alexa-layouts` rather than a hand-built `Container`: it already
 * handles the shapes this has to survive — round Echo Spot, wide Show 15, Fire TV — and
 * reimplementing that responsiveness by hand is a large amount of layout code to own for no
 * gain. The import is resolved by the device, so it costs nothing in the response.
 */
function listDocument(): unknown {
  return {
    type: 'APL',
    version: APL_DOCUMENT_VERSION,
    import: [{ name: 'alexa-layouts', version: '1.7.0' }],
    mainTemplate: {
      parameters: ['payload'],
      items: [
        {
          type: 'AlexaTextList',
          headerTitle: '${payload.hebList.title}',
          headerSubtitle: '${payload.hebList.subtitle}',
          headerDivider: true,
          backButton: 'NONE',
          listItems: '${payload.hebList.items}',
        },
      ],
    },
  };
}

/**
 * The `RenderDocument` directive for a list, or null when this device has no screen.
 *
 * Returning null rather than throwing keeps the call site a single conditional spread: a
 * speaker gets a response identical to the one it got before this module existed.
 */
export function listRenderDirective(envelope: RequestEnvelope, list: HebList): unknown | null {
  if (!supportsApl(envelope)) return null;

  // Row count alone does not bound response size — item names are free text — so rows are
  // added only while their serialized form still fits `MAX_ITEMS_CHARS`. The first row is
  // always kept even if it alone would not fit, the same way `cardList` always keeps at
  // least a footer — but truncated to the budget rather than exempted from it, so an
  // oversized name can't push the response past Alexa's cap on its own.
  const shown: Row[] = [];
  let usedChars = 0;
  for (const item of list.items) {
    if (shown.length >= MAX_DISPLAYED_ITEMS) break;
    let row = listRow(item);
    let rowChars = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (shown.length === 0 && rowChars > MAX_ITEMS_CHARS) {
      row = truncateRow(row, MAX_ITEMS_CHARS);
      rowChars = Buffer.byteLength(JSON.stringify(row), 'utf8');
    } else if (shown.length > 0 && usedChars + rowChars > MAX_ITEMS_CHARS) {
      break;
    }
    shown.push(row);
    usedChars += rowChars;
  }
  const dropped = list.items.length - shown.length;

  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    // Stable, so a second read replaces the document already on screen instead of stacking
    // another one behind it.
    token: 'hebList',
    document: listDocument(),
    datasources: {
      hebList: {
        title: list.name,
        // Says what is on screen, including what is not: a silently truncated list looks
        // complete, and someone shopping from it would leave without the rest.
        subtitle:
          list.items.length === 0
            ? 'Empty'
            : dropped > 0
              ? `Showing ${shown.length} of ${list.items.length} items`
              : `${list.items.length} item${list.items.length === 1 ? '' : 's'}`,
        items: shown,
      },
    },
  };
}
