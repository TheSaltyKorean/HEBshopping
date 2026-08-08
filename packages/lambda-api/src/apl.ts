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

/**
 * How many lines reach the screen.
 *
 * Not a display limit — a response-size one. Alexa caps the entire response at 24 KB and
 * counts directives toward it, so an unbounded list would fail `ReadListIntent` outright on
 * exactly the long lists this exists to serve, the same trap `MAX_CARD_CHARS` guards against
 * for cards. At roughly 60 bytes a row, 120 rows is comfortably inside the budget, and a
 * grocery list that long is already past the point of being read on a screen.
 */
const MAX_DISPLAYED_ITEMS = 120;

/**
 * Whether this device has a screen that can render APL.
 *
 * Read from the request rather than assumed from the device type: the same skill serves
 * Echo speakers, Shows, Fire TV and the phone app, and only some of those can display
 * anything. Absent interfaces are absent, not false, so this is a presence check.
 */
export function supportsApl(envelope: RequestEnvelope): boolean {
  return envelope.context?.System?.device?.supportedInterfaces?.[APL_INTERFACE] !== undefined;
}

/** One row on screen: the product on the left, its amount on the right. */
function listRow(item: ListItem): { primaryText: string; secondaryText?: string } {
  const amount = itemAmountLabel(item);
  return amount === undefined
    ? { primaryText: itemName(item) }
    : { primaryText: itemName(item), secondaryText: amount };
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
    version: '2023.3',
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

  const shown = list.items.slice(0, MAX_DISPLAYED_ITEMS);
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
        items: shown.map(listRow),
      },
    },
  };
}
