/**
 * The feature: add, read, and remove items on an HEB shopping list.
 *
 * Both surfaces (Alexa, MCP) are thin adapters over this class. Any behaviour that differs
 * between them beyond phrasing belongs here instead, or it will drift.
 */

import { HebError } from './errors.js';
import { HebClient } from './graphql/client.js';
import {
  addItemsDocument,
  buyItAgainDocument,
  deleteItemsDocument,
  getShoppingListDocument,
  getShoppingListsDocument,
  searchProductsDocument,
  updateItemQuantityDocument,
} from './graphql/operations.js';
import {
  broadenQuery,
  coverage,
  isConfident,
  matchProducts,
  meaningfulTokens,
  mergeCandidates,
} from './matching.js';
import type {
  AddItemInput,
  AddResult,
  HebList,
  LineMatch,
  ListItem,
  ListOps,
  MatchResult,
  Product,
  RemoveItemInput,
} from './types.js';

/**
 * How much of a removal request a sole list line must account for.
 *
 * Below this the shortcut does not apply and normal confidence rules resume, so an
 * unrelated request against a one-item list reports "not on the list" rather than
 * deleting the only thing there.
 */
const SOLE_LINE_COVERAGE = 0.6;

// ---------------------------------------------------------------------------
// HEB response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

interface HebProduct {
  __typename?: string;
  id: string;
  fullDisplayName?: string;
  displayName?: string;
  /** Object on list items, plain string in search results. */
  brand?: string | { name?: string };
  maximumOrderQuantity?: number;
}

interface HebListItem {
  id: string;
  quantity?: number;
  /** Free-text content on a GenericShoppingListItemV2; absent on product lines. */
  note?: string;
  maximumQuantity?: number;
  product?: HebProduct;
}

interface HebListPayload {
  id: string;
  name: string;
  totalItemCount?: number;
  fulfillment?: { store?: { storeNumber?: number } };
  itemPage?: { items?: HebListItem[] };
}

// ---------------------------------------------------------------------------

export interface HebListOpsOptions {
  client: HebClient;
  /** Pin a list explicitly (HEB_LIST_ID). Otherwise resolved per the default-list rule. */
  listId?: string;
}

export class HebListOps implements ListOps {
  private readonly client: HebClient;
  private readonly pinnedListId: string | undefined;

  /**
   * Per-instance cache of the resolved list.
   *
   * A voice command has ~8s and an add already costs a search plus a mutation; re-reading
   * the list to discover its id and store on every step would not fit. Instances are
   * created per invocation, so this never goes stale across commands.
   */
  private cachedList: HebList | undefined;
  private cachedStoreId: number | undefined;
  /** Which list `cachedStoreId` belongs to — stores are per-list, not per-account. */
  private cachedStoreListId: string | undefined;
  private cachedPurchasedIds: ReadonlySet<string> | undefined;
  /** Which store `cachedPurchasedIds` was fetched for — the carousel is per-store. */
  private cachedPurchasedStoreId: number | undefined;
  /**
   * The list request currently in flight, if any.
   *
   * `resolveQuery` deliberately runs the search and the purchase-history fetch in
   * parallel, and both need the list first. Without this they each miss the empty cache
   * and issue an identical `getShoppingListV2` — a redundant round trip on Alexa's
   * critical path, plus the throttle delay it earns.
   */
  private inFlightList: Map<string, Promise<HebList>> = new Map();

  constructor(options: HebListOpsOptions) {
    this.client = options.client;
    this.pinnedListId = options.listId;
  }

  async getLists(): Promise<HebList[]> {
    const data = await this.client.execute<{
      getShoppingListsV2: { __typename?: string; lists?: HebListPayload[] };
    }>(getShoppingListsDocument());

    // A refused read returns a different union member carrying only `__typename`, and the
    // `?? []` below would turn that into "this account has no shopping lists" — a
    // confident, wrong, and unactionable answer to a question we never got to ask.
    assertUnion(data.getShoppingListsV2, 'ShoppingListsWithHeaderPageV2', 'list your lists');

    return (data.getShoppingListsV2.lists ?? []).map((list) => ({
      listId: list.id,
      name: list.name,
      storeId: list.fulfillment?.store?.storeNumber?.toString() ?? null,
      items: [],
    }));
  }

  /**
   * Resolve which list to act on.
   *
   * Order per the default-list rule: an explicit id, then a pinned one, then the sole list
   * if there is exactly one. Never guess between several — picking the wrong list puts the
   * shopping on a list nobody reads, which is worse than being asked.
   */
  private async resolveListId(explicit?: string): Promise<string> {
    if (explicit !== undefined) return explicit;
    if (this.pinnedListId !== undefined) return this.pinnedListId;

    const lists = await this.getLists();
    if (lists.length === 1) return lists[0]!.listId;
    if (lists.length === 0) {
      // Same code, different remedy — `listCount` is what lets a surface tell the two
      // apart. "Pick one of your lists" is impossible advice for an account that has none.
      throw new HebError('AMBIGUOUS_LIST', 'This HEB account has no shopping lists.', {
        details: { listCount: 0 },
      });
    }
    throw new HebError(
      'AMBIGUOUS_LIST',
      `This account has ${lists.length} lists (${lists.map((l) => l.name).join(', ')}). ` +
        'Set HEB_LIST_ID to choose one.',
      { details: { listCount: lists.length } },
    );
  }

  async getList(listId?: string): Promise<HebList> {
    const id = await this.resolveListId(listId);

    // Serve the cache when it is for *this* list. Without this, a query-based add costs
    // list + search + search + list + mutation rather than the documented search + search
    // + mutation, because `resolveStoreId` already fetched the list a moment earlier. Two
    // redundant round trips is a large fraction of Alexa's ~8s ceiling.
    if (this.cachedList !== undefined && this.cachedList.listId === id) return this.cachedList;

    // Keyed by list id: sharing one promise across ids would hand a caller asking for
    // list B the contents — and the store — of list A, and a query-based add would then
    // search A's store while mutating B.
    const inFlight = this.inFlightList.get(id);
    if (inFlight !== undefined) return inFlight;

    const request = this.fetchList(id).finally(() => this.inFlightList.delete(id));
    this.inFlightList.set(id, request);
    return request;
  }

  private async fetchList(id: string): Promise<HebList> {
    const data = await this.client.execute<{
      getShoppingListV2: HebListPayload & { __typename?: string };
    }>(getShoppingListDocument(id));

    // A deleted or inaccessible list comes back as a different union member carrying only
    // a `__typename`, which `HebClient` sees as a perfectly good data envelope. Mapping it
    // would manufacture an empty list, and we would cheerfully tell someone their shopping
    // list is empty when in fact the read was refused.
    assertMutationSucceeded(data.getShoppingListV2, 'read the list');

    const list = toHebList(data.getShoppingListV2);
    this.cachedList = list;
    if (list.storeId !== null) {
      this.cachedStoreId = Number(list.storeId);
      this.cachedStoreListId = list.listId;
    }
    return list;
  }

  /**
   * Search the catalog.
   *
   * Uses the **list's** store, not whatever store the website header happens to advertise —
   * those are independent, and searching the wrong one yields products the user can't
   * actually buy where they shop.
   */
  async searchProducts(query: string, listId?: string): Promise<Product[]> {
    const storeId = await this.resolveStoreId(listId);

    const data = await this.client.execute<{
      productSearchItems: { __typename?: string; searchGrid?: { items?: HebProduct[] } };
    }>(searchProductsDocument(query, storeId));

    // The *outer* union, distinct from the item union filtered below. A refused search
    // would otherwise read as "no products matched", so we would tell the user to try
    // different words when the words were never the problem.
    assertUnion(data.productSearchItems, 'ProductSearchItemsResult', 'search the catalog');

    // `searchGrid.items` is a union — sponsored placements and banners appear alongside
    // products. Those come back as a bare `__typename`, and mapping one produces a
    // "Unknown product" with an undefined id: MCP would hand that id back as a real
    // productId, and Alexa would offer it in a confirmation whose "yes" cannot succeed.
    return (data.productSearchItems.searchGrid?.items ?? [])
      .filter((item) => item.__typename === 'Product' && typeof item.id === 'string')
      .map(toProduct);
  }

  /**
   * Catalog ids this account buys regularly, fetched once per instance.
   *
   * Best-effort: a personalisation signal is never worth failing an add over, so any
   * error here degrades to "no purchase history" rather than propagating.
   */
  private async purchasedIds(listId?: string): Promise<ReadonlySet<string>> {
    const storeId = await this.resolveStoreId(listId);
    // Keyed by store, because the carousel is queried by store: reusing list A's history
    // for list B would personalise B's ranking with products bought somewhere else.
    if (this.cachedPurchasedIds !== undefined && this.cachedPurchasedStoreId === storeId) {
      return this.cachedPurchasedIds;
    }

    try {
      const data = await this.client.execute<{
        getBuyItAgainCarousel?: { items?: Array<{ id?: string }> };
      }>(buyItAgainDocument(storeId));

      this.cachedPurchasedIds = new Set(
        (data.getBuyItAgainCarousel?.items ?? [])
          .map((item) => item.id)
          .filter((id): id is string => id !== undefined),
      );
    } catch {
      this.cachedPurchasedIds = new Set();
    }
    this.cachedPurchasedStoreId = storeId;
    return this.cachedPurchasedIds;
  }

  /**
   * Resolve free text to a best match, retrying with a broader query when unsure.
   *
   * A specific phrase can make HEB's search *narrower and worse* — it treats each extra
   * word as a constraint — so a low-confidence first result is as often a bad candidate
   * set as a genuinely ambiguous request. One broadened retry distinguishes the two.
   *
   * Cost is one extra ~700ms call, paid only on the unsure path, and only when the query
   * is long enough to broaden. Worst case is search + search + mutation, which still sits
   * inside Alexa's ceiling (plan §3.2).
   */
  private async resolveQuery(query: string, listId?: string): Promise<MatchResult | null> {
    // Fetched alongside the search rather than before it: the personalisation signal costs
    // no extra wall-clock this way, which matters inside Alexa's ceiling.
    const [candidates, purchasedIds] = await Promise.all([
      this.searchProducts(query, listId),
      this.purchasedIds(listId),
    ]);
    const match = matchProducts(query, candidates, { purchasedIds });

    if (match !== null && isConfident(match)) return match;

    const broader = broadenQuery(query);
    if (broader === null) return match;

    const merged = mergeCandidates(candidates, await this.searchProducts(broader, listId));
    if (merged.length === candidates.length) return match;

    // Re-score the union against the *original* wording — broadening was a way to find
    // candidates, never a redefinition of what the user asked for.
    const retried = matchProducts(query, merged, { purchasedIds });
    if (retried === null) return match;
    if (match === null) return retried;

    // Ties go to the broadened result. It was scored against a strictly larger candidate
    // set, so an equal confidence there is better supported — and if the top product
    // changed, the merged set found something the narrow search had hidden, which is the
    // entire reason for retrying.
    return retried.confidence >= match.confidence ? retried : match;
  }

  /**
   * The store to search, for a specific list.
   *
   * Keyed by list id, not global. Lists carry their own store, so reusing list A's store
   * for a later explicit call against list B would search the wrong location — returning
   * products that cannot be bought where the mutation is actually writing.
   */
  private async resolveStoreId(listId?: string): Promise<number> {
    const list = await this.getList(listId);
    if (this.cachedStoreId !== undefined && this.cachedStoreListId === list.listId) {
      return this.cachedStoreId;
    }
    if (list.storeId === null) {
      throw new HebError('UPSTREAM_ERROR', 'The HEB list has no store, so search is impossible.');
    }
    return Number(list.storeId);
  }

  async addItem(input: AddItemInput): Promise<AddResult> {
    if ((input.query === undefined) === (input.productId === undefined)) {
      throw new TypeError('addItem requires exactly one of `query` or `productId`.');
    }

    const listId = await this.resolveListId(input.listId);
    const quantity = input.quantity ?? 1;

    let productId = input.productId;

    if (productId === undefined) {
      const match = await this.resolveQuery(input.query!, listId);

      if (match === null) {
        throw new HebError(
          'PRODUCT_NOT_FOUND',
          `No HEB product matches "${input.query}".`,
          { details: { query: input.query } },
        );
      }
      // Below the threshold we write nothing and hand the decision back. Silently adding
      // the wrong product is the failure users actually notice.
      if (!isConfident(match)) return { status: 'needs_confirmation', match };
      productId = match.product.id;
    }

    // Quantity is a property of a list line, so a repeat add increments rather than
    // creating a duplicate line — matching what HEB's own UI does.
    const existing = (await this.getList(listId)).items.find(
      (item) => item.product?.id === productId,
    );

    if (existing !== undefined) {
      const ceiling = existing.maximumQuantity ?? Number.POSITIVE_INFINITY;
      // Never below what is already there. If HEB lowers a product's ceiling after the
      // line was created, clamping alone turns "add one more" into "take four away" —
      // an add that silently removes groceries is the worst possible reading of the verb.
      const target = Math.max(existing.quantity, Math.min(existing.quantity + quantity, ceiling));
      if (target !== existing.quantity) {
        await this.setQuantity(listId, existing.lineId, target);
      }
      return { status: 'already_present', item: { ...existing, quantity: target } };
    }

    const data = await this.client.execute<{ addShoppingListItemsV2: HebListPayload }>(
      addItemsDocument(listId, [productId]),
    );

    this.cachedList = undefined; // the list just changed underneath us

    const added = toHebList(data.addShoppingListItemsV2).items.find(
      (item) => item.product?.id === productId,
    );
    if (added === undefined) {
      throw new HebError('UPSTREAM_ERROR', 'HEB accepted the add but did not return the item.');
    }

    if (quantity > 1) {
      const target = Math.min(quantity, added.maximumQuantity ?? quantity);
      try {
        await this.setQuantity(listId, added.lineId, target);
        return { status: 'added', item: { ...added, quantity: target } };
      } catch {
        // The add already succeeded — a quantity-one line exists. Throwing here would
        // report total failure for a partial success, and a retry would then find that
        // line and increment it, landing on three when two was asked for. Report what is
        // actually on the list instead; the user can say "add another" if they want more.
        return { status: 'added', item: added };
      }
    }

    return { status: 'added', item: added };
  }

  /**
   * Set a line's quantity outright.
   *
   * Exposed for callers that need to *restore* prior state rather than add to it — the
   * verification tools use it to undo an increment against a line they did not create.
   */
  async setItemQuantity(lineId: string, quantity: number, listId?: string): Promise<void> {
    await this.setQuantity(await this.resolveListId(listId), lineId, quantity);
  }

  private async setQuantity(listId: string, lineId: string, quantity: number): Promise<void> {
    const data = await this.client.execute<{
      updateShoppingListItemV2?: { __typename?: string };
    }>(updateItemQuantityDocument(listId, lineId, quantity));
    this.cachedList = undefined;
    assertMutationSucceeded(data.updateShoppingListItemV2, 'change the quantity');
  }

  async removeItem(input: RemoveItemInput): Promise<void> {
    const listId = await this.resolveListId(input.listId);
    const data = await this.client.execute<{ deleteShoppingListItemsV2?: { __typename?: string } }>(
      deleteItemsDocument(listId, [input.lineId]),
    );
    this.cachedList = undefined;
    assertMutationSucceeded(data.deleteShoppingListItemsV2, 'remove the item');
  }

  /**
   * Find a line on the list from spoken text, for removal.
   *
   * Matches against what is actually on the list rather than the whole catalog, which is a
   * much smaller and more forgiving problem — and refuses to guess when two lines are
   * equally plausible.
   */
  async findLine(spoken: string, listId?: string): Promise<ListItem> {
    const ranked = await this.rankLines(spoken, listId);
    const best = ranked[0];

    if (best === undefined) {
      throw new HebError('ITEM_NOT_ON_LIST', `"${spoken}" is not on the list.`);
    }
    if (!best.confident) {
      throw new HebError(
        'AMBIGUOUS_REMOVAL',
        `"${spoken}" could mean more than one item on the list.`,
        { details: { candidates: ranked.map((entry) => entry.item.text) } },
      );
    }
    return best.item;
  }

  /**
   * Rank the list's own lines against spoken text, best first.
   *
   * `findLine` collapses this to "the answer, or an error", which suits a caller that can
   * ask a follow-up question in the same breath. A voice surface cannot: it has to offer
   * candidates one at a time and needs the `lineId` of each to act on a "yes". Both go
   * through this one ranking so they can never disagree about what matches.
   *
   * Returns `[]` when nothing matches at all.
   */
  async rankLines(spoken: string, listId?: string): Promise<LineMatch[]> {
    const list = await this.getList(listId);
    if (list.items.length === 0) {
      throw new HebError('ITEM_NOT_ON_LIST', 'The list is empty.');
    }

    // Match against a synthetic product per *line*, keyed by lineId, so free-text items
    // are removable by voice too. Keying by product id would drop them entirely, and
    // would also collapse two lines that somehow share a product.
    const match = matchProducts(
      spoken,
      list.items.map((item) => ({ id: item.lineId, name: item.text })),
    );
    if (match === null) return [];

    // Catalog separation semantics are wrong for a one-item list. `separation()` returns
    // zero for a singleton — correct for search, where a lone result usually means an
    // over-constrained query hid better ones — but a list is a closed set: nothing else
    // could be meant. Without this, "remove the milk" from a one-item list asks a
    // pointless question, and MCP claims several items match when only one exists.
    //
    // "Nothing else could be meant" is not "anything goes", though. `matchProducts`
    // returns a result on a single shared word, so an unguarded shortcut turns
    // "remove chocolate cake" against a list holding only "chocolate milk" into a silent
    // deletion of the milk. The shortcut therefore still requires the request to be
    // substantially accounted for by the line.
    const soleLine =
      list.items.length === 1 &&
      coverage(meaningfulTokens(spoken), match.product) >= SOLE_LINE_COVERAGE;

    const confident = soleLine || isConfident(match);
    const byLineId = new Map(list.items.map((item) => [item.lineId, item] as const));

    return [match.product, ...match.alternatives]
      .map((product) => byLineId.get(product.id))
      .filter((item): item is ListItem => item !== undefined)
      // Only the top candidate can be "the confident answer"; the rest are alternatives.
      .map((item, index) => ({ item, confident: index === 0 && confident }));
  }
}

/**
 * The union member every list mutation returns on success.
 *
 * `ShoppingListResponseV2` is a union, and HEB signals a rejected mutation by returning a
 * *different* member rather than a GraphQL error — so the response looks structurally fine
 * to `HebClient` and carries only a `__typename`. Without this check a stale line id
 * produces a cheerful "Removed it" while the item stays on the list, which is worse than
 * an error because the user stops thinking about it.
 */
const MUTATION_SUCCESS_TYPENAME = 'ShoppingListV2';

/**
 * Fail unless a union payload is the member that means success.
 *
 * HEB signals refusal by returning a *different* member rather than a GraphQL error, so
 * every one of these reads structurally fine to `HebClient` while carrying nothing but a
 * `__typename`. Mapping one produces a confident empty answer — no lists, no search
 * results, an empty shopping list — which is worse than an error, because the user stops
 * looking for the problem.
 */
function assertUnion(
  payload: { __typename?: string } | undefined,
  expected: string,
  attempted: string,
): void {
  const typename = payload?.__typename;
  // Absent means the selection did not ask for one; that is not evidence of failure.
  if (typename === undefined || typename === expected) return;

  throw new HebError('UPSTREAM_ERROR', `HEB refused to ${attempted}.`, {
    details: { returned: typename },
  });
}

function assertMutationSucceeded(
  payload: { __typename?: string } | undefined,
  attempted: string,
): void {
  // A missing __typename means the selection did not ask for one; treat that as success
  // rather than inventing a failure, since the request itself did not error.
  // These documents always request `__typename`, so a null payload or a missing typename
  // is not "the selection did not ask" — it is a mutation that did not happen. Treating it
  // as success means confirming a deletion or a quantity change that never took place.
  if (payload?.__typename === MUTATION_SUCCESS_TYPENAME) return;

  throw new HebError('UPSTREAM_ERROR', `HEB refused to ${attempted}.`, {
    details: { returned: payload?.__typename ?? 'null' },
  });
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function brandName(brand: HebProduct['brand']): string | undefined {
  if (brand === undefined) return undefined;
  return typeof brand === 'string' ? brand : brand.name;
}

export function toProduct(product: HebProduct): Product {
  const name = product.fullDisplayName ?? product.displayName ?? 'Unknown product';
  const brand = brandName(product.brand);
  return brand === undefined ? { id: product.id, name } : { id: product.id, name, brand };
}

function toListItem(item: HebListItem): ListItem | null {
  const quantity = item.quantity ?? 1;
  const ceiling = item.maximumQuantity === undefined ? {} : { maximumQuantity: item.maximumQuantity };

  // A free-text line: created in the H-E-B mobile app for a search that matched nothing,
  // carrying its text in `note` and no product. Dropping it would under-report a list the
  // app itself displays correctly, and would let removal claim the item is not there.
  if (item.product === undefined) {
    const note = item.note?.trim();
    if (note === undefined || note === '') return null;
    return { lineId: item.id, text: note, quantity, ...ceiling };
  }

  const product = toProduct(item.product);
  return { lineId: item.id, product, text: product.name, quantity, ...ceiling };
}

export function toHebList(payload: HebListPayload): HebList {
  return {
    listId: payload.id,
    name: payload.name,
    storeId: payload.fulfillment?.store?.storeNumber?.toString() ?? null,
    items: (payload.itemPage?.items ?? []).map(toListItem).filter((item) => item !== null),
  };
}
