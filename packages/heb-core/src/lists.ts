/**
 * The feature: add, read, and remove items on an HEB shopping list.
 *
 * Both surfaces (Alexa, MCP) are thin adapters over this class. Any behaviour that differs
 * between them beyond phrasing belongs here instead, or it will drift.
 */

import { HebError, isHebError } from './errors.js';
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

/** How long the optional purchase-history signal may hold up a command. */
const PREFERENCE_DEADLINE_MS = 900;

/** Resolve to `fallback` if `work` has not finished in time. Never rejects. */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work.catch(() => fallback), expiry]);
  } finally {
    clearTimeout(timer!);
  }
}

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
  __typename?: string;
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
    assertReadableList(data.getShoppingListsV2);

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
    //
    // Uses the authentication-aware classifier, not the generic one: a deployment with
    // HEB_LIST_ID never calls `getLists`, so this is the *only* read a dead session
    // reaches — and misclassifying it costs the retry advice, the MCP login guidance, and
    // the expiry alarm all at once.
    assertReadableList(data.getShoppingListV2, 'ShoppingListV2', 'read the list');

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
      // Bounded separately, and much tighter. This is a *ranking* signal: waiting a full
      // per-call timeout for it would spend a third of Alexa's whole budget on something
      // that only reorders near-ties, and could turn a working add into a timeout because
      // an optional carousel was slow.
      withDeadline(this.purchasedIds(listId), PREFERENCE_DEADLINE_MS, new Set<string>()),
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
        try {
          await this.setQuantity(listId, existing.lineId, target);
        } catch (error) {
          // A timeout here is *indeterminate*: HEB may well have committed the update
          // before the response was lost. Propagating a bare failure makes the surface say
          // "try again", and the retry reads the already-incremented line and increments it
          // a second time. So re-read and report what is actually there.
          let current: HebList;
          try {
            current = await this.getList(listId);
          } catch {
            // The reconciliation read failed as well — likely because the first timeout
            // spent the budget. Nothing is known, and "try again" is the one answer that
            // can make it worse.
            throw new HebError(
              'UPSTREAM_ERROR',
              'HEB did not confirm the change. Check the list before asking again — it may have worked.',
              { cause: error, retryable: false, details: { indeterminate: true } },
            );
          }

          const actual = current.items.find((item) => item.lineId === existing.lineId);
          if (actual !== undefined && actual.quantity === target) {
            return { status: 'already_present', item: actual };
          }
          throw new HebError(
            'UPSTREAM_ERROR',
            actual === undefined
              ? 'HEB did not confirm the change; check the list before trying again.'
              : `HEB did not confirm the change. The list still shows ${actual.quantity}.`,
            { cause: error, retryable: false },
          );
        }
      }
      return { status: 'already_present', item: { ...existing, quantity: target } };
    }

    this.cachedList = undefined; // the list is about to change underneath us

    let added: ListItem | undefined;
    try {
      const data = await this.client.execute<{ addShoppingListItemsV2: HebListPayload }>(
        addItemsDocument(listId, [productId]),
      );
      // Same success-union check as the other mutations. A refused add — a confirmed
      // productId gone stale, say — returns a different member with only a __typename,
      // which would otherwise map to an empty list and surface as the *retryable*
      // "accepted the add but did not return the item", inviting repeats of a mutation
      // the server conclusively rejected.
      assertMutationSucceeded(data.addShoppingListItemsV2, 'add the item');

      added = toHebList(data.addShoppingListItemsV2).items.find(
        (item) => item.product?.id === productId,
      );
    } catch (error) {
      // Indeterminate, exactly like the quantity update: HEB may have created the line
      // before the response was lost. A bare failure makes the surface say "try again",
      // and the retry finds that line and *increments* it — so "add milk" twice leaves
      // two. Look before inviting a retry.
      // If the reconciliation read *also* fails — most likely because the first timeout
      // exhausted the invocation budget — we genuinely do not know what happened. Saying
      // "try again" is the one answer that can make it worse, since a committed line gets
      // incremented by the retry.
      let current: HebList;
      try {
        current = await this.getList(listId);
      } catch {
        throw new HebError(
          'UPSTREAM_ERROR',
          'HEB did not confirm the add. Check the list before asking again — it may have worked.',
          { cause: error, retryable: false, details: { indeterminate: true } },
        );
      }

      added = current.items.find((item) => item.product?.id === productId);
      if (added === undefined) throw error;
      // Deliberately falls through rather than returning: the mutation only ever creates
      // one unit, so "add five avocados" still needs the quantity step below. Returning
      // here reported a one-unit success for a five-unit request.
    }

    if (added === undefined) {
      throw new HebError('UPSTREAM_ERROR', 'HEB accepted the add but did not return the item.');
    }

    if (quantity > 1) {
      const target = Math.min(quantity, added.maximumQuantity ?? quantity);
      try {
        await this.setQuantity(listId, added.lineId, target);
        return { status: 'added', item: { ...added, quantity: target } };
      } catch (error) {
        // The add already succeeded — a line exists — but whether the quantity bump landed
        // is unknown, and `setQuantity` invalidated the cache before writing so a read here
        // reaches HEB. Reporting the stale payload's quantity of one would understate what
        // is on the list and invite another add, over-incrementing it.
        const actual = (await this.getList(listId)).items.find(
          (item) => item.lineId === added.lineId,
        );

        // A *definitive* refusal is not an indeterminate failure: there is nothing to
        // reconcile, and reporting success would claim five units while one is on the
        // list. Say what actually happened, and do not invite a retry — retrying the whole
        // add would create a second line.
        if (isHebError(error) && error.details?.['rejected'] === true) {
          throw new HebError(
            'UPSTREAM_ERROR',
            `Added ${added.text}, but HEB refused to set the quantity to ${target}. ` +
              `The list has ${actual?.quantity ?? added.quantity}.`,
            { cause: error, retryable: false, details: { partialAdd: true } },
          );
        }

        // A readback that still shows less than was asked for is not a success. Saying
        // "added five" over a line holding one is the same lie the reconciliation exists to
        // prevent, just arrived at from the other direction.
        if ((actual?.quantity ?? added.quantity) < target) {
          throw new HebError(
            'UPSTREAM_ERROR',
            `Added ${added.text}, but only ${actual?.quantity ?? added.quantity} of ${target}.`,
            { cause: error, retryable: false, details: { partialAdd: true } },
          );
        }

        return { status: 'added', item: actual ?? added };
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
    // Invalidated *before* the call, not after. A write whose response is lost has still
    // very likely happened, so the cache is already wrong the moment the request leaves —
    // and clearing only on success means any reconciliation afterwards re-reads the
    // pre-mutation snapshot and concludes, wrongly, that nothing was committed.
    this.cachedList = undefined;

    const data = await this.client.execute<{
      updateShoppingListItemV2?: { __typename?: string };
    }>(updateItemQuantityDocument(listId, lineId, quantity));

    assertMutationSucceeded(data.updateShoppingListItemV2, 'change the quantity');
  }

  async removeItem(input: RemoveItemInput): Promise<void> {
    const listId = await this.resolveListId(input.listId);

    // Invalidated before sending, for the same reason as the other mutations: a request
    // whose response is lost has probably still happened, so the cache is wrong from the
    // moment it leaves.
    this.cachedList = undefined;

    let data: { deleteShoppingListItemsV2?: { __typename?: string } };
    try {
      data = await this.client.execute(deleteItemsDocument(listId, [input.lineId]));
    } catch (error) {
      // The line may already be gone. Reporting failure here sends the user to retry a
      // removal that succeeded, and the retry then says the item is not on the list —
      // which reads as though the first attempt did nothing.
      const stillThere = (await this.getList(listId)).items.some(
        (item) => item.lineId === input.lineId,
      );
      if (!stillThere) return;
      throw error;
    }

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
    // Coverage alone is not enough. "Organic chocolate cake" against a list holding only
    // "organic chocolate milk" covers two of three tokens — comfortably over the floor —
    // and the shortcut would delete the milk without asking. The *head* token is what
    // names the thing, so it has to match as well.
    const spokenTokens = meaningfulTokens(spoken);
    const head = spokenTokens.at(-1);

    // The head token gates *every* automatic removal, not just the sole-line shortcut.
    // Scoring alone is not enough on a multi-item list either: "organic dark chocolate
    // cake" covers three of four tokens of "organic dark chocolate milk" and separates
    // cleanly from an unrelated second line, so ordinary confidence deletes the milk — for
    // a request whose category word was never on the list at all.
    const namesTheLine = head !== undefined && coverage([head], match.product) === 1;

    const soleLine =
      list.items.length === 1 && coverage(spokenTokens, match.product) >= SOLE_LINE_COVERAGE;

    const confident = namesTheLine && (soleLine || isConfident(match));
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
/**
 * A refused list read is almost always a dead session — say so.
 *
 * Classifying it as a generic upstream failure has three consequences that all point the
 * wrong way: Alexa suggests retrying something no retry can fix, the CloudWatch expiry
 * filter never sees `SESSION_EXPIRED` so no alert is sent, and MCP withholds the
 * login-and-upload guidance that is the actual remedy.
 */
function assertReadableList(
  payload: { __typename?: string } | undefined,
  expected = 'ShoppingListsWithHeaderPageV2',
  attempted = 'list your lists',
): void {
  const typename = payload?.__typename;
  if (typename === undefined || typename === expected) return;

  if (/auth|unauthori|forbidden|session|login|denied/i.test(typename)) {
    throw new HebError('SESSION_EXPIRED', 'HEB rejected the stored session.', {
      details: { returned: typename },
    });
  }
  throw new HebError('UPSTREAM_ERROR', `HEB refused to ${attempted}.`, {
    details: { returned: typename },
  });
}

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

  // An authentication refusal is not a generic rejection. With a pinned list, an MCP
  // `heb_remove_item` carrying a lineId reaches the delete mutation with no preceding
  // read — so this is the only place a dead session surfaces, and calling it
  // UPSTREAM_ERROR costs the login-and-upload guidance and the expiry alarm together.
  const typename = payload?.__typename;
  if (typename !== undefined && /auth|unauthori|forbidden|session|login|denied/i.test(typename)) {
    throw new HebError('SESSION_EXPIRED', 'HEB rejected the stored session.', {
      details: { returned: typename },
    });
  }

  // `rejected` marks this as a *definitive* refusal rather than a lost response. Callers
  // reconcile indeterminate failures by re-reading; a refusal has nothing to reconcile.
  throw new HebError('UPSTREAM_ERROR', `HEB refused to ${attempted}.`, {
    retryable: false,
    details: { returned: payload?.__typename ?? 'null', rejected: true },
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
