/**
 * MCP server exposing the HEB shopping list.
 *
 * A thin adapter over `HebListOps` — all behaviour lives there so this surface and the
 * Alexa one cannot drift. What *is* this layer's job: writing tool descriptions a model
 * can act on correctly, since they are the only documentation it ever sees.
 *
 * Two rules the descriptions must convey:
 *   - which tools write (add/remove) versus read (list/search);
 *   - that a low-confidence add returns candidates instead of writing, and the way to
 *     resolve it is a second call with `productId`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HebListOps, isHebError, type AddResult, type ListItem } from '@heb/core';

export const SERVER_NAME = 'heb-shopping-list';
export const SERVER_VERSION = '0.1.0';

type TextResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const text = (body: string, isError = false): TextResult =>
  isError ? { content: [{ type: 'text', text: body }], isError: true } : { content: [{ type: 'text', text: body }] };

function describeItem(item: ListItem): string {
  // A counter line is measured in pounds; its `quantity` is an artefact of how HEB stores
  // the row and reporting "1 ×" beside a 2 lb order of sliced turkey is simply wrong.
  if (item.weight !== undefined) return `${item.weight} lb ${item.text}`;
  return item.quantity > 1 ? `${item.quantity} × ${item.text}` : item.text;
}

/**
 * Turn a failure into something a model can act on.
 *
 * Error codes carry a specific remedy each; a generic "something went wrong" would make
 * the model retry the same doomed call. `SESSION_EXPIRED` in particular needs a human, so
 * say so rather than implying a retry might work.
 */
function toErrorText(error: unknown): TextResult {
  if (isHebError(error)) {
    // The code only — never the message or details, which carry list contents. This exact
    // string is what the CloudWatch metric filter matches, so an expired session raises
    // the same alert from the MCP endpoint as from Alexa. Without it, an MCP-only
    // deployment gets no expiry notification at all: the tool returns `isError`, which
    // Lambda still counts as a successful invocation.
    console.error(`HebError ${error.code}`);
  }

  if (!isHebError(error)) {
    return text(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const guidance: Partial<Record<string, string>> = {
    SESSION_EXPIRED:
      'The HEB session has expired. A human must re-run `npm run login` — this cannot be ' +
      'fixed automatically. If this server is the deployed one (a Function URL rather than ' +
      'a local stdio process), they must also run `npm run push:session`, because the ' +
      'Lambda reads DynamoDB and a local login alone will not reach it.',
    BOT_CHALLENGE: 'HEB served a bot check. Wait a moment and try once more.',
    PRODUCT_NOT_FOUND:
      'No catalog product matched. Try a brand name, or Spanish wording — much of this ' +
      'catalog is named in Spanish. If nothing matches, call heb_add_item again with ' +
      '`text` to put the request on the list as a plain written line, exactly as the ' +
      "H-E-B app's own \"Add … to list\" button does.",
    AMBIGUOUS_LIST_EMPTY:
      'This HEB account has no shopping lists at all. Tell the user to create one in the ' +
      'H-E-B app; nothing can be added until they do.',
    // Not "ask which list": no tool here accepts a listId, so the user's answer could not
    // change the next call and the same error would recur. HEB_LIST_ID is the only lever.
    AMBIGUOUS_LIST:
      'Several lists exist and this server is not pinned to one. Tell the user to set ' +
      'HEB_LIST_ID in the server configuration and restart it; asking which list to use ' +
      'cannot help, because these tools take no list argument.',
    AMBIGUOUS_REMOVAL: 'Several list items match; ask the user which one they meant.',
    ITEM_NOT_ON_LIST: 'That item is not on the list.',
  };
  // AMBIGUOUS_LIST covers both "several lists" and "none at all", and the remedies are
  // opposites: telling a model to ask which list to use is unactionable for an account
  // that has none, and contradicts the message it is printed beneath.
  const key =
    error.code === 'AMBIGUOUS_LIST' && error.details?.['listCount'] === 0
      ? 'AMBIGUOUS_LIST_EMPTY'
      : error.code;

  const extra = guidance[key];

  // A partial write outranks the code's own advice. `SESSION_EXPIRED` tells the agent to
  // get a human to log in — perfectly correct, and actively harmful on its own here,
  // because the obvious next step afterwards is to repeat the original request, which
  // increments the line this call already created. Alexa says this; MCP must too.
  const partial =
    error.details?.['partialAdd'] === true
      ? '\nIMPORTANT: the item IS already on the list — only its amount was not set. Do ' +
        'NOT repeat this add; adding it again increases the amount further. Read the list ' +
        'and correct the amount instead.'
      : '';

  return text(`${error.code}: ${error.message}${extra ? `\n${extra}` : ''}${partial}`, true);
}

function describeAddResult(result: AddResult, requested: { quantity?: number; weight?: number } = {}): TextResult {
  // The server's per-item cap can stop a multi-unit add short of what was requested. Say so
  // rather than reporting the capped quantity as if it were the full amount — an agent
  // relaying "added" back to the user would otherwise claim a bigger add than actually
  // happened.
  const cappedNotice =
    (result.status === 'added' || result.status === 'already_present') &&
    result.quantityRequested !== undefined &&
    result.quantityRequested > result.item.quantity
      ? ` (HEB only allows ${result.item.quantity} of this item — the remainder of the ` +
        `requested ${result.quantityRequested} could not be added)`
      : '';

  // Same idea for a counter product whose weight ladder tops out below the ask — the item
  // was written at its last rung, not the pounds actually requested.
  const weightCappedNotice =
    (result.status === 'added' || result.status === 'already_present') &&
    result.weightRequested !== undefined &&
    result.item.weight !== undefined &&
    result.weightRequested > result.item.weight
      ? ` (HEB only sells this item up to ${result.item.weight} lb — the remainder of the ` +
        `requested ${result.weightRequested} lb could not be added)`
      : '';

  switch (result.status) {
    case 'added':
      return text(`Added to the HEB list: ${describeItem(result.item)}${cappedNotice}${weightCappedNotice}`);
    case 'already_present':
      return text(
        (result.item.weight === undefined
          ? `Already on the list — quantity is now ${result.item.quantity}: ${result.item.text}`
          : `Already on the list — now ${result.item.weight} lb of ${result.item.text}`) +
          cappedNotice +
          weightCappedNotice,
      );
    case 'needs_confirmation': {
      // Candidates are returned inline precisely so the model does not need a separate
      // search round trip before confirming.
      const { product, alternatives, confidence } = result.match;
      const options = [product, ...alternatives]
        .map((candidate, index) => `  ${index + 1}. ${candidate.name}  [productId: ${candidate.id}]`)
        .join('\n');
      // The server keeps no pending state between calls — the confirming call is a fresh
      // `addItem`, so any `quantity`/`weight` from this request is lost unless the caller
      // resends it. Without this reminder, a confirmed "three avocados" or "two pounds of
      // turkey" silently becomes quantity 1 or the counter's default weight.
      const amountReminder =
        requested.quantity !== undefined || requested.weight !== undefined
          ? ` Resend ${[
              requested.quantity !== undefined ? `quantity: ${requested.quantity}` : null,
              requested.weight !== undefined ? `weight: ${requested.weight}` : null,
            ]
              .filter((part) => part !== null)
              .join(' and ')} with it — it is not remembered from this call.`
          : '';
      return text(
        `NOT added — the request was ambiguous (confidence ${confidence.toFixed(2)}).\n` +
          `Ask the user which they meant, then call heb_add_item again with that productId.${amountReminder}\n\n` +
          `Candidates:\n${options}`,
      );
    }
  }
}

export interface CreateServerOptions {
  /**
   * Built fresh for every tool call, never shared.
   *
   * `HebListOps` caches the resolved list, which is correct within one operation and wrong
   * across two. A stdio server lives for the whole client session, so a single shared
   * instance would answer `heb_read_list` from a snapshot taken hours earlier and never
   * see edits made in the H-E-B app — and free-text removal would match against that
   * stale list too.
   */
  createListOps: () => HebListOps;
}

export function createHebMcpServer({ createListOps }: CreateServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'heb_read_list',
    {
      title: 'Read the HEB shopping list',
      description:
        'Read every item currently on the H-E-B shopping list, with quantities. ' +
        'Read-only. Call this before removing something, to get its lineId.',
      inputSchema: {},
    },
    async (): Promise<TextResult> => {
      try {
        const list = await createListOps().getList();
        if (list.items.length === 0) return text(`The HEB list "${list.name}" is empty.`);
        const lines = list.items
          .map((item) => `• ${describeItem(item)}  [lineId: ${item.lineId}]`)
          .join('\n');
        return text(`HEB list "${list.name}" — ${list.items.length} item(s):\n${lines}`);
      } catch (error) {
        return toErrorText(error);
      }
    },
  );

  server.registerTool(
    'heb_search_product',
    {
      title: 'Search the HEB catalog',
      description:
        'Search H-E-B for products matching a phrase, at the store the list belongs to. ' +
        'Read-only; nothing is added. Use this to resolve a vague request into a specific ' +
        'productId before calling heb_add_item.',
      inputSchema: {
        query: z.string().min(1).describe('What to search for, e.g. "oat milk" or "flour tortillas".'),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum results (default 10).'),
      },
    },
    async ({ query, limit }): Promise<TextResult> => {
      try {
        const products = await createListOps().searchProducts(query);
        if (products.length === 0) return text(`No HEB products matched "${query}".`);
        const shown = products.slice(0, limit ?? 10);
        const lines = shown
          .map((product) => `• ${product.name}  [productId: ${product.id}]`)
          .join('\n');
        return text(
          `${products.length} match(es) for "${query}" (showing ${shown.length}):\n${lines}`,
        );
      } catch (error) {
        return toErrorText(error);
      }
    },
  );

  server.registerTool(
    'heb_add_item',
    {
      title: 'Add an item to the HEB shopping list',
      description:
        'WRITES to the H-E-B shopping list. Supply exactly one of `query` (free text to be ' +
        'matched against the catalog), `productId` (an exact product, e.g. from ' +
        'heb_search_product), or `text` (a plain written line, matched against nothing). ' +
        'If `query` is too vague, nothing is written and candidate products are returned — ' +
        'ask the user which they meant and call again with that productId. ' +
        'Adding something already on the list increases its quantity rather than duplicating it.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .optional()
          .describe('Free text to match, e.g. "oat milk". Mutually exclusive with productId and text.'),
        productId: z
          .string()
          .min(1)
          .optional()
          .describe('Exact HEB product id. Mutually exclusive with query and text.'),
        text: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Add a plain written line instead of a catalog product — no search, no ' +
              'matching. Use this when the catalog has nothing (PRODUCT_NOT_FOUND) or the ' +
              'user asks for something generic like "birthday candles". Mutually ' +
              'exclusive with query and productId.',
          ),
        quantity: z.number().int().min(1).max(20).optional().describe('How many (default 1).'),
        weight: z
          .number()
          .positive()
          .max(20)
          .optional()
          .describe(
            'Pounds, for counter goods sold by weight (deli meat and cheese sliced to ' +
              'order, seafood) — e.g. 2 for "two pounds of sliced turkey". Rounded to the ' +
              'nearest weight H-E-B accepts, usually a quarter pound. Ignored for packaged ' +
              'goods, which are bought by the package; the reply says which happened.',
          ),
      },
    },
    async ({ query, productId, text: line, quantity, weight }): Promise<TextResult> => {
      const given = [query, productId, line].filter((value) => value !== undefined).length;
      if (given !== 1) {
        return text('Provide exactly one of `query`, `productId`, or `text`.', true);
      }
      if (line !== undefined && weight !== undefined) {
        // A written line has no product behind it, so there is nothing that could be sold
        // by the pound. Silently dropping the weight would misreport what landed.
        return text('`weight` needs a catalog product; use `query` or `productId`.', true);
      }
      try {
        const result = await createListOps().addItem({
          ...(query === undefined ? {} : { query }),
          ...(productId === undefined ? {} : { productId }),
          ...(line === undefined ? {} : { text: line }),
          ...(quantity === undefined ? {} : { quantity }),
          ...(weight === undefined ? {} : { weight }),
        });
        return describeAddResult(result, { quantity, weight });
      } catch (error) {
        return toErrorText(error);
      }
    },
  );

  server.registerTool(
    'heb_remove_item',
    {
      title: 'Remove an item from the HEB shopping list',
      description:
        'WRITES to the H-E-B shopping list, removing an item entirely. Supply either ' +
        '`lineId` (exact, from heb_read_list) or `item` (free text matched against what is ' +
        'actually on the list). If the text matches several items, nothing is removed and ' +
        'you are told to disambiguate.',
      inputSchema: {
        lineId: z
          .string()
          .min(1)
          .optional()
          .describe('Exact list line id from heb_read_list. Mutually exclusive with item.'),
        item: z
          .string()
          .min(1)
          .optional()
          .describe('Free text to match against list contents. Mutually exclusive with lineId.'),
      },
    },
    async ({ lineId, item }): Promise<TextResult> => {
      if ((lineId === undefined) === (item === undefined)) {
        return text('Provide exactly one of `lineId` or `item`.', true);
      }
      try {
        // Resolving free text against the list (not the whole catalog) is a much smaller
        // problem, and findLine refuses to guess between equally plausible lines.
        const listOps = createListOps();
        const target = lineId ?? (await listOps.findLine(item!)).lineId;
        const label = lineId === undefined ? item : lineId;
        await listOps.removeItem({ lineId: target });
        return text(`Removed from the HEB list: ${label}`);
      } catch (error) {
        return toErrorText(error);
      }
    },
  );

  return server;
}
