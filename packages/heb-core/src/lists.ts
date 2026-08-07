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
  addTextDocument,
  type GraphqlDocument,
  buyItAgainDocument,
  updateItemWeightDocument,
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
  tokensMatch,
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
  /** True for counter goods sold per pound. See `WEIGHT_FIELDS` in operations.ts. */
  pricedByWeight?: boolean;
  /** One entry per SKU; the accepted weights live inside. */
  SKUs?: Array<{ weightSelectionIncrements?: number[] }>;
}

interface HebListItem {
  id: string;
  quantity?: number;
  /** Pounds, on a counter line. Null on everything else. */
  weight?: number | null;
  /** The text of a free-text line (GenericShoppingListItemV2). */
  genericName?: string;
  /** A separate annotation — HEB's "Add note" button. Normally null, even on text lines. */
  note?: string;
  maximumQuantity?: number;
  product?: HebProduct;
  /** True once the shopper has checked the line off. H-E-B keeps it on the list either way. */
  checked?: boolean;
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

    const payload = data.getShoppingListV2;
    const items = payload.itemPage?.items ?? [];

    // H-E-B keeps checked-off rows on the list, and `totalItemCount` counts them — so a
    // list with plenty of history can exceed `LIST_PAGE_SIZE` while holding far fewer than
    // 500 still-needed lines, and those needed lines can land on a later page than the
    // history that precedes them in CATEGORY order. Leaving them unfetched silently drops
    // real groceries from reads, removals, and add's existing-line check alike. Rare in
    // practice — most lists fit one page — so this only costs extra round trips on the
    // lists that actually need them.
    if (payload.totalItemCount !== undefined && items.length < payload.totalItemCount) {
      let page = 1;
      while (items.length < payload.totalItemCount) {
        const more = await this.client.execute<{
          getShoppingListV2: HebListPayload & { __typename?: string };
        }>(getShoppingListDocument(id, page));
        assertReadableList(more.getShoppingListV2, 'ShoppingListV2', 'read the list');
        const nextItems = more.getShoppingListV2.itemPage?.items ?? [];
        if (nextItems.length === 0) break;
        items.push(...nextItems);
        page += 1;
      }
      payload.itemPage = { items };
    }

    const list = toHebList(payload);
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
    return (await this.searchProductsPage(query, listId)).items;
  }

  /**
   * Same search, but also surfaces the catalog's own count of matches — not just how many
   * came back on this page. `searchProducts` above drops it because its callers only ever
   * consume the resolved candidates, never the total; MCP's `heb_search_product`, and
   * `tools/verify-mcp.ts`'s ambiguity probe, need the real number rather than the page length,
   * which under-reports whenever more than one page of results exists.
   */
  async searchProductsPage(query: string, listId?: string): Promise<{ items: Product[]; total: number }> {
    const storeId = await this.resolveStoreId(listId);

    const data = await this.client.execute<{
      productSearchItems: {
        __typename?: string;
        searchGrid?: { items?: HebProduct[]; total?: number };
      };
    }>(searchProductsDocument(query, storeId));

    // The *outer* union, distinct from the item union filtered below. A refused search
    // would otherwise read as "no products matched", so we would tell the user to try
    // different words when the words were never the problem.
    assertUnion(data.productSearchItems, 'ProductSearchItemsResult', 'search the catalog');

    // `searchGrid.items` is a union — sponsored placements and banners appear alongside
    // products. Those come back as a bare `__typename`, and mapping one produces a
    // "Unknown product" with an undefined id: MCP would hand that id back as a real
    // productId, and Alexa would offer it in a confirmation whose "yes" cannot succeed.
    const items = (data.productSearchItems.searchGrid?.items ?? [])
      .filter((item) => item.__typename === 'Product' && typeof item.id === 'string')
      .map(toProduct);
    return { items, total: data.productSearchItems.searchGrid?.total ?? items.length };
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

    // Best-effort only when there is already a match to fall back on. The broadened search
    // exists to *add* reach; if it times out or is challenged while candidates are already in
    // hand, failing the whole add would turn every ambiguous multi-word query into an upstream
    // error rather than the confirmation choices we already have. But when the initial search
    // found nothing, degrading a failed recovery search to an empty result is indistinguishable
    // from a genuine no-match — `addItem` would treat a transient search failure as
    // PRODUCT_NOT_FOUND and write the spoken request as a plain list line. Propagate instead.
    const extra = match !== null
      ? await this.searchProducts(broader, listId).catch(() => [])
      : await this.searchProducts(broader, listId);
    if (extra.length === 0) return match;

    const merged = mergeCandidates(candidates, extra);
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
    const given = [input.query, input.productId, input.text].filter(
      (value) => value !== undefined,
    ).length;
    if (given !== 1) {
      throw new TypeError('addItem requires exactly one of `query`, `productId`, or `text`.');
    }

    if (input.text !== undefined) {
      if (input.weight !== undefined) {
        // A written line has no product behind it, so nothing about it can be sold by the
        // pound. Silently dropping the weight would misreport what landed.
        throw new TypeError('addItem `weight` needs a product; it cannot apply to `text`.');
      }
      return this.addText(input.text, input.quantity ?? 1, input.listId);
    }

    if (input.query !== undefined && input.query.trim() === '') {
      // "Add some" reduces to nothing once filler is stripped. Searching for an empty
      // string cannot match, and the resulting PRODUCT_NOT_FOUND would reach the voice
      // fallback and write the filler itself onto the list.
      throw new TypeError('addItem `query` cannot be blank.');
    }

    const listId = await this.resolveListId(input.listId);
    const quantity = Math.max(1, Math.trunc(input.quantity ?? 1));

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
      // "Zero bananas" is a refusal, not a count of bananas — but a match here is matching
      // on "bananas", the word the request actually named a quantity of zero. A real product
      // can legitimately start with the word ("zero sugar dr pepper"), and its own name says
      // so; only a match whose name does *not* mention it is the spurious one. This has to run
      // before the confidence check below: a below-threshold "zero bananas" match still hands
      // back a `needs_confirmation` whose pending add bypasses this guard entirely on "yes".
      //
      // Tokenized rather than a `\b0\b` scan on the raw name: a sub-unit package size like
      // "Turkey, 0.5 lb" has a "0" bounded by a word boundary against the following "." just
      // as a standalone "0" would be, so the naive regex reads the decimal's leading digit as
      // the product itself saying zero and lets the refusal through as a live one-unit add.
      const nameTokens: string[] = match.product.name.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
      if (
        /^(?:zero|0)\b/i.test(input.query!.trim()) &&
        !nameTokens.includes('zero') &&
        !nameTokens.includes('0')
      ) {
        throw new HebError('PRODUCT_NOT_FOUND', `"${input.query}" asks for zero.`, {
          details: { query: input.query, zeroCount: true },
        });
      }

      // Below the threshold we write nothing and hand the decision back. Silently adding
      // the wrong product is the failure users actually notice.
      if (!isConfident(match)) return { status: 'needs_confirmation', match };

      productId = match.product.id;
    }

    // Dropped first: `resolveQuery` above already populated `cachedList` while resolving
    // the product, so serving that snapshot here would decide new-vs-existing from a read
    // taken before the search even ran — a far wider window than the add call that follows.
    // A household member's concurrent add of the same product lands inside that window and
    // is exactly what makes the merged-line case below unrecoverable; this shrinks it to the
    // one round trip between this read and the add mutation.
    this.cachedList = undefined;
    const existing = (await this.getList(listId)).items.find(
      (item) => item.product?.id === productId,
    );
    const wasPresent = existing !== undefined;

    // ── Counter goods ────────────────────────────────────────────────────────────────
    // Weight is absolute at HEB — there is no additive form — so an existing counter line
    // is handled on its own terms and never through the quantity path below.
    if (existing?.product?.pricedByWeight === true) {
      if (input.weight === undefined) {
        // "Add sliced turkey" when a counter line already exists. There is no honest
        // amount to add, and a quantity update on a line measured in pounds either gets
        // refused or changes a number nobody buys by.
        //
        // A caller that also asked for `quantity > 1` (an MCP client resending a
        // productId, or a count-led spoken phrase resolving to a counter item) gets the
        // same silent-refusal treatment `quantityRequested` exists to prevent elsewhere:
        // reporting bare `already_present` reads identically to a request that never
        // asked for more, so surface the ignored count instead of dropping it quietly.
        return quantity > 1
          ? { status: 'already_present', item: existing, quantityRequested: quantity }
          : { status: 'already_present', item: existing };
      }
      // Re-read immediately before computing the target. The absolute write cannot be made
      // atomic, so the best available is to shrink the window between observing the weight
      // and overwriting it — otherwise a household member raising 1 lb to 2 lb between the
      // opening read and here has most of their order removed.
      //
      // The cache must be dropped first, or `getList` serves the very snapshot this is
      // trying to get past and the "refresh" changes nothing at all.
      this.cachedList = undefined;
      const refreshed = await this.getList(listId); // failure propagates: see below
      const fresh = refreshed.items.find((item) => item.lineId === existing.lineId);
      if (fresh === undefined) {
        // The line went away between the two reads. There is nothing to add weight to, and
        // recreating it is not what was asked for.
        throw new HebError('ITEM_NOT_ON_LIST', 'That counter item is no longer on the list.', {
          retryable: false,
        });
      }
      // Deliberately no `?? existing` fallback. Falling back to the opening snapshot means
      // writing an absolute weight derived from a value already known to be stale — which
      // is precisely the overwrite this refresh exists to prevent. A read failure must stop
      // the write, not license it.
      const base = fresh.weight ?? 0;
      const requested = base + input.weight;
      const increments = fresh.product?.weightIncrements;
      const target = Math.max(base, snapWeight(requested, increments));
      // The ladder tops out below what was asked for: report the shortfall the same way a
      // blocked quantity ceiling does, rather than confirming the last rung as the full ask.
      const shortfall =
        increments !== undefined && increments.length > 0 && requested > increments[increments.length - 1]!
          ? { weightRequested: requested }
          : {};
      return {
        status: 'already_present',
        item: await this.adjustWeight(listId, fresh, target),
        ...shortfall,
      };
    }

    // Already at the server's ceiling: adding cannot raise it, and issuing the mutation
    // only invites a refusal. Report what is there.
    const ceiling = existing?.maximumQuantity ?? Number.POSITIVE_INFINITY;
    if (existing !== undefined && existing.quantity >= ceiling) {
      // Blocked outright — none of `quantity` can land. Reporting only `already_present`
      // reads identically to a request that never asked for more, so both surfaces would
      // confirm the unchanged line as if it were the full ask instead of flagging the
      // shortfall, the same gap `addRemainingUnits` closes for a partially fulfilled add.
      //
      // `input.weight` is carried the same way the caller at the bottom of this method
      // carries it past a packaged-product add: a weight request against a packaged good
      // that is also at its quantity ceiling would otherwise return here first and lose the
      // "sold by the package, not the pound" guidance entirely, reporting only a blocked
      // quantity increment as if pounds were never asked for.
      return {
        status: 'already_present',
        item: existing,
        quantityRequested: existing.quantity + quantity,
        ...(input.weight === undefined ? {} : { weightRequested: input.weight }),
      };
    }

    // ── The add itself ───────────────────────────────────────────────────────────────
    // Issued whether or not the line already exists, because `addShoppingListItemsV2` is
    // the only *additive* operation HEB offers: it merges into an existing line and
    // increments it by one, server-side, with no read-modify-write. That is what makes a
    // one-unit add — overwhelmingly the common case, and all a voice request ever produces
    // for an existing line — incapable of overwriting a concurrent change.
    //
    // The previous shape read the line, computed an absolute target from that snapshot and
    // wrote it back, so a household member raising a line from 1 to 4 in between had two of
    // their units deleted by "add one more". Everything below now works from the quantity
    // the mutation itself returned, which is post-merge and authoritative.
    //
    // (Batching the same product N times in one call is not an option — HEB rejects a
    // duplicate inside `listItems` outright. Verified against the live API.)
    this.cachedList = undefined;

    let added: ListItem | undefined;
    try {
      const data = await this.client.execute<{ addShoppingListItemsV2: HebListPayload }>(
        addItemsDocument(listId, [productId]),
      );
      // A refused add — a confirmed productId gone stale, say — returns a different union
      // member with only a __typename, which would otherwise map to an empty list and
      // surface as a *retryable* failure, inviting repeats of a mutation HEB rejected.
      assertMutationSucceeded(data.addShoppingListItemsV2, 'add the item');

      added = toHebList(data.addShoppingListItemsV2).items.find(
        (item) => item.product?.id === productId,
      );
    } catch (error) {
      // An expired session is a definitive non-write from the client's own side: the
      // request never authenticated. Reconciling would re-read with the same dead cookies
      // and downgrade this to an indeterminate upstream failure, costing the login remedy
      // on both surfaces and the log line the expiry alarm matches on.
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') throw error;

      // A definitive refusal likewise has nothing to reconcile.
      if (isHebError(error) && error.details?.['rejected'] === true) throw error;

      // A schema-drift failure is definitive too: GraphQL validation runs before the
      // mutation resolver, so the write never reached it. Funnelling this into the
      // indeterminate case below would tell the caller the add may have landed, and would
      // suppress Alexa's "skill must be updated" guidance that only fires off this code.
      if (isHebError(error) && error.details?.['schemaDrift'] === true) throw error;

      // A transport failure is genuinely ambiguous and *cannot* be resolved by looking at
      // the list. A line that appeared may be this call's lost write or a household
      // member's concurrent add of the same product — the two are indistinguishable, and
      // guessing "ours" would report a write that never happened and then adjust somebody
      // else's line. Say what is actually known instead, and do not invite a retry: if the
      // write did land, repeating it merges another unit.
      throw new HebError(
        'UPSTREAM_ERROR',
        'HEB did not confirm the add. Check the list before asking again — it may have worked.',
        { cause: error, retryable: false, details: { indeterminate: true } },
      );
    }

    if (added === undefined) {
      // The mutation succeeded; the returned page simply does not contain the line — a long
      // category-sorted list can place it outside the page. Re-read rather than reporting a
      // failure for a write that plainly committed.
      this.cachedList = undefined;
      added = (await this.getList(listId).catch(() => null))?.items.find(
        (item) => item.product?.id === productId,
      );

      if (added === undefined) {
        throw new HebError(
          'UPSTREAM_ERROR',
          'HEB accepted the add but did not return the item. Check the list before asking again.',
          { retryable: false, details: { indeterminate: true } },
        );
      }
    }

    const status = wasPresent ? 'already_present' : 'added';

    // A counter line the add just created: give it the requested weight.
    if (added.product?.pricedByWeight === true) {
      if (input.weight === undefined) {
        // Counter goods have no unit to multiply. HEB assigned this line its own default
        // weight, and the surface confirms in pounds, so nothing is reported as a silent "1".
        //
        // A count-led request ("three sliced turkeys", or an MCP `quantity: 3`) still asked
        // for more than this one default-weight line delivers. The existing-line branch
        // above already surfaces the ignored count as `quantityRequested`; a newly created
        // line drops it just as silently otherwise.
        return quantity > 1 ? { status, item: added, quantityRequested: quantity } : { status, item: added };
      }
      // Deliberately NO re-read here, unlike the existing-line path above. The two look
      // symmetrical and are not.
      //
      // That path re-reads because its observation — the opening snapshot — is arbitrarily
      // old: a search and a resolve can sit between it and the write, so refreshing shrinks
      // the window from "however long this call has been running" to one round trip.
      //
      // `added` is not an old observation. It comes from the add mutation's own response, so
      // it already *is* the freshest reading obtainable, and the gap to the write below is
      // one round trip. Re-reading cannot make it fresher: the refresh would sit one round
      // trip after the add and the write one round trip after that, leaving an
      // equally-long unprotected window — the same exposure, one extra call later. HEB
      // offers no ETag or compare-and-set on `updateShoppingListItemV2` (§2.1), so this last
      // round trip is irreducible, and the README documents it as such.
      //
      // The extra call is not free: this is the Alexa critical path, where a weight add
      // already costs resolve + search + add + write against a ~8s ceiling (§3.2).
      //
      // `Math.max` is what bounds the damage. It never lowers the line below the weight the
      // add response reported, so the only value at risk is one written inside that final
      // window.
      //
      // But a fresh line and a merge look the same here unless quantity is checked: when a
      // household member creates the counter line between the opening read and this call's
      // own mutation, HEB merges by bumping only the line's quantity and leaves its weight
      // untouched — `added.quantity` above 1 is that tell, the same one `addRemainingUnits`
      // uses for the same reason. Treating it as fresh takes `added.weight` (their existing
      // weight) as the floor and snaps the request on its own, so a request for 0.5 lb on
      // top of their 2 lb never lands: `Math.max(2, 0.5) === 2`. The merged case instead adds
      // the request to their weight, same as the pre-existing-line path above.
      const merged = status === 'added' && added.quantity > 1;
      const increments = added.product.weightIncrements;
      const requested = merged ? (added.weight ?? 0) + input.weight : input.weight;
      const target = Math.max(added.weight ?? 0, snapWeight(requested, increments));
      // Same shortfall reporting as the existing-line path above: the ladder's top rung is
      // not the full request.
      // Same merge case as `quantityRequested` above, one unit type over: a household
      // member's concurrent add landed first, so `item.weight` is their weight plus this
      // request's, not this request's contribution alone. Surface what this request itself
      // asked for so the caller can report the contribution and the merged total separately,
      // instead of crediting the whole merged weight to this request.
      //
      // The ladder-shortfall case is checked *first*, not the merge case: when the concurrent
      // add already sat the line on its last rung, `target` cannot move — `snapWeight` clamps
      // `requested` right back down to `added.weight` — so none of this request's own weight
      // landed either. Reporting `input.weight` there would have `weightMergedNotice` claim
      // this request's own share was written when it was not; reporting the merged `requested`
      // total instead — the same shape the existing-line ladder-shortfall case above uses —
      // makes `weightCappedNotice` fire the correct "could not bring it up to" wording.
      const shortfall =
        increments !== undefined && increments.length > 0 && requested > increments[increments.length - 1]!
          ? { weightRequested: requested }
          : merged
            ? { weightRequested: input.weight }
            : {};
      return {
        status,
        item: await this.adjustWeight(listId, added, target, !wasPresent && !merged),
        ...shortfall,
      };
    }

    // The mutation contributed the first unit; the rest go the same way.
    const result = await this.addRemainingUnits(listId, added, quantity - 1, status, () =>
      addItemsDocument(listId, [productId]),
    );
    // A packaged product has no unit to apply a weight request to — HEB sells it by the
    // package, not the pound — so the branch above is skipped and one package is added
    // instead. Report the weight that went unhonoured rather than confirming a bare "added"
    // as if the pounds asked for were irrelevant.
    return input.weight !== undefined && result.status !== 'needs_confirmation'
      ? { ...result, weightRequested: input.weight }
      : result;
  }

  /**
   * Put the remaining units on a line the caller has just added to.
   *
   * One additive mutation per unit, deliberately — *not* one absolute write of the total.
   *
   * The absolute write is a single round trip and looks obviously better, but it encodes a
   * number that was true when the previous response arrived. A household member
   * incrementing the same line in that gap gets their unit overwritten: the line reads 3,
   * this writes the 4 it computed from a 2 it saw earlier, and one of their groceries is
   * gone. `addShoppingListItemsV2` merges server-side, so N adds always land N units on
   * whatever the line currently holds, whoever else is touching it.
   *
   * The cost is N-1 extra round trips. Voice requests are almost always one or two units,
   * and the client's invocation budget bounds the rest — a budget exhaustion mid-way is
   * reported as a partial add rather than silently truncated.
   */
  private async addRemainingUnits(
    listId: string,
    added: ListItem,
    remaining: number,
    status: 'added' | 'already_present',
    document: () => GraphqlDocument,
  ): Promise<AddResult> {
    let line = added;
    const cap = added.maximumQuantity ?? Number.POSITIVE_INFINITY;
    // For a brand-new line (`status === 'added'`), what was actually asked for is `remaining
    // + 1` — the one unit this call's first mutation contributed plus the rest it is about to
    // add. `added.quantity` is not that number: a household member merging the same
    // previously-absent product into this line between the opening read and the first
    // mutation inflates it, and basing the request total on it would credit their unit to
    // this request instead of flagging the merge below. An existing line has no such
    // ambiguity — `added.quantity` there already is the pre-existing total plus this call's
    // first unit, which is exactly the baseline the shortfall check needs.
    const totalRequested = status === 'added' ? remaining + 1 : added.quantity + remaining;

    for (let unit = 0; unit < remaining; unit += 1) {
      // The server's own ceiling. Adding past it is refused, and asking is pointless.
      if (line.quantity >= cap) break;

      try {
        const data = await this.client.execute<{ addShoppingListItemsV2: HebListPayload }>(
          document(),
        );
        assertMutationSucceeded(data.addShoppingListItemsV2, 'add the item');
        this.cachedList = undefined;

        // A household member can remove the line between two additive calls; the next add
        // then recreates it under a new lineId. Matching on lineId alone would miss that row
        // and fall back to fabricating another unit on the now-deleted line, so match on the
        // product (or free-text) identity instead — whichever line this add actually landed
        // on carries the same one.
        const items = toHebList(data.addShoppingListItemsV2).items;
        const matches = (item: ListItem): boolean =>
          line.product !== undefined ? item.product?.id === line.product.id : item.text === line.text;
        let seen = items.find(matches);
        if (seen === undefined) {
          // The mutation succeeded but the returned page doesn't contain the line — same
          // long-list truncation the initial add re-reads for. Re-reading here for the same
          // reason: falling back to `line.quantity + 1` would fabricate a number from before
          // this call, which is exactly wrong if a household member removed the line between
          // additive calls and this mutation recreated it — the recreated line holds one unit,
          // not the old quantity plus one.
          this.cachedList = undefined;
          const relist = await this.getList(listId).catch(() => undefined);
          // A failed re-read is not proof the mutation only added one unit — it is simply
          // unknown. Falling through to `line.quantity + 1` here would fabricate the old
          // total plus one, which is exactly wrong if a household member removed the old line
          // and this mutation recreated it at quantity 1: subsequent units then chase a stale
          // ceiling and report a total the list never held. Report indeterminate instead, the
          // same as every other point this call cannot confirm its own write.
          if (relist === undefined) {
            throw new HebError(
              'UPSTREAM_ERROR',
              `Added ${line.text}, but the amount is not confirmed — a required re-read failed.`,
              { retryable: false, details: { partialAdd: true, indeterminate: true } },
            );
          }
          seen = relist.items.find(matches);
          // The re-read is authoritative — unlike the mutation response, it cannot be a
          // truncated page (`getList` itself pages through the whole list). If the line is
          // genuinely absent here, a household member removed it after this mutation
          // recreated it, and `line.quantity + 1` would fabricate a unit count for a line
          // that no longer exists. That is indistinguishable from this call's own write
          // never having landed, so it is reported the same way as every other point this
          // call cannot confirm its own write, rather than assumed successful.
          if (seen === undefined) {
            throw new HebError(
              'UPSTREAM_ERROR',
              `Added ${line.text}, but the amount is not confirmed — the line was not found ` +
                'on a required re-read.',
              { retryable: false, details: { partialAdd: true, indeterminate: true } },
            );
          }
        }
        // Trust the response (or the re-read), which is always defined by this point — the
        // mutation's own page found it, or the re-read above did, or the re-read's absence
        // was already reported as indeterminate.
        line = seen;
      } catch (error) {
        // A line exists either way, so a blind retry of the whole request would add the
        // full amount again. This holds even for an expired session, whose remedy alone
        // would send someone back to repeat everything.
        //
        // `line.quantity` is only the last *confirmed* reading — this mutation's own response
        // is what's missing. A lost response is not proof the write never landed: the same
        // ambiguity that makes the very first add's failure "indeterminate" (see the
        // `added === undefined` branch above) applies to every later unit too. Asserting the
        // amount as exact would tell an MCP client to over-correct or misreport on a total
        // that might already be one higher.
        const done = line.quantity;
        if (isHebError(error) && error.code === 'SESSION_EXPIRED') {
          throw new HebError('SESSION_EXPIRED', error.message, {
            cause: error,
            retryable: false,
            details: { ...error.details, partialAdd: true },
          });
        }
        throw new HebError(
          'UPSTREAM_ERROR',
          `Added ${line.text}, but the amount is at least ${done}, not confirmed at ` +
            `${totalRequested}.`,
          { cause: error, retryable: false, details: { partialAdd: true, indeterminate: true } },
        );
      }
    }

    // The server's cap can stop this short of what was asked. Reporting it here — rather
    // than letting the caller confirm `line.quantity` as if it were the full amount — is
    // what tells a household member their five-unit request only picked up two.
    if (line.quantity < totalRequested) return { status, item: line, quantityRequested: totalRequested };
    // A new line can also come back *higher* than requested: a household member adding the
    // same previously-absent product between the opening read and this call's mutations
    // merges into the same line server-side. `quantityRequested` here still means "what this
    // request asked for" — the surface uses it to say one was added and the list now holds
    // more, instead of crediting the whole merged total to this one request.
    if (status === 'added' && line.quantity > totalRequested) {
      return { status, item: line, quantityRequested: totalRequested };
    }
    return { status, item: line };
  }

  /**
   * Add a free-text line.
   *
   * No search, no matching, no confirmation: the text is the item. This is what H-E-B's
   * own "Add \"…\" to list" affordance does, and it is the right answer when the catalog
   * has nothing — a line saying what someone asked for beats no line at all.
   */
  private async addText(text: string, quantity: number, listId?: string): Promise<AddResult> {
    const trimmed = text.trim();
    if (trimmed === '') throw new TypeError('addItem `text` cannot be blank.');

    const id = await this.resolveListId(listId);
    // Snapshot BEFORE the write. Verified against the live list: adding a genericName that
    // is already on the list does NOT create a second line — HEB merges it into the
    // existing one and increments its quantity. So neither the text nor a new line id can
    // prove this mutation committed; the quantity of any pre-existing line is the only
    // evidence there is. Without this, a failed add reconciles against somebody else's
    // identical line and is reported as a success that never happened.
    const before = (await this.getList(id)).items.find(isTextLine(trimmed));
    const base = before?.quantity ?? 0;
    const wasPresent = before !== undefined;
    // The mutation itself contributes the first unit, so only the rest is left to apply —
    // and it is applied to whatever the write *returned*, never to a target derived from
    // the snapshot. A household member merging the same text in between makes the returned
    // quantity higher than the snapshot predicts, and an absolute target computed up front
    // would overwrite their increment with a smaller number, quietly taking a unit off
    // somebody's shopping.
    const remaining = Math.max(1, Math.trunc(quantity)) - 1;

    this.cachedList = undefined;

    let payload: HebListPayload;
    try {
      const data = await this.client.execute<{ addShoppingListItemsV2: HebListPayload }>(
        addTextDocument(id, trimmed),
      );
      assertMutationSucceeded(data.addShoppingListItemsV2, 'add the note');
      payload = data.addShoppingListItemsV2;
    } catch (error) {
      // Definitive failures keep their own classification: an expired session never
      // authenticated, and a `rejected` union member is HEB saying no. Neither wrote
      // anything, and neither needs evidence gathered about it.
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') throw error;
      if (isHebError(error) && error.details?.['rejected'] === true) throw error;
      if (isHebError(error) && error.details?.['schemaDrift'] === true) throw error;

      // Everything else is a transport failure, and the list cannot resolve it. A quantity
      // above the snapshot is not proof this write landed: a household member merging the
      // same text produces exactly the same observation, and the two are indistinguishable
      // — the identical reasoning that made the product path stop guessing. Claiming it
      // reports a write that may never have happened, and a multi-unit request then edits
      // their line.
      //
      // Non-retryable, because if the write *did* land the retry merges another unit.
      throw new HebError(
        'UPSTREAM_ERROR',
        'HEB did not confirm the note. Check the list before asking again — it may have worked.',
        { cause: error, retryable: false, details: { indeterminate: true } },
      );
    }

    let added = toHebList(payload).items.find(isTextLine(trimmed));
    if (added === undefined) {
      // The mutation succeeded; the returned page simply does not contain the line — a
      // long category-sorted list can place it outside the page. The product path already
      // re-reads here, and reporting an indeterminate failure for a write that plainly
      // committed sends the user to add it again, merging a second unit.
      this.cachedList = undefined;
      added = (await this.getList(id).catch(() => null))?.items.find(isTextLine(trimmed));
    }
    if (added === undefined) {
      throw new HebError('UPSTREAM_ERROR', 'HEB accepted the note but did not return it.', {
        retryable: false,
        details: { indeterminate: true },
      });
    }
    return this.applyTextQuantity(id, added, remaining, wasPresent);
  }

  /**
   * Raise a freshly written line to the requested quantity.
   *
   * Generic lines carry a quantity just as product lines do — verified against the live
   * list, which accepted an update and read back 3 — so "add three birthday candles"
   * is honoured rather than silently becoming one.
   *
   * A failure here is a *partial* add: the line exists, only the amount is wrong. Saying
   * "try again" would write a second copy, because a written line has no product id to
   * deduplicate against.
   */
  private async applyTextQuantity(
    listId: string,
    line: ListItem,
    remaining: number,
    wasPresent: boolean,
  ): Promise<AddResult> {
    const status = wasPresent ? 'already_present' : 'added';
    // Additive, one unit per call, for the same reason the product path is: an absolute
    // write encodes a total that was true when the previous response arrived, and a
    // household member merging into the same text line in that gap loses their unit.
    return this.addRemainingUnits(listId, line, remaining, status, () =>
      addTextDocument(listId, line.text),
    );
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

  /**
   * Drive a counter line to `pounds`, reconciling an indeterminate write.
   *
   * Same hazard as the quantity path and the same answer: a lost response may still have
   * committed, and a bare failure makes the surface say "try again", whereupon the retry
   * adds the requested weight *on top of* what already landed. So re-read and report what
   * is actually on the list.
   */
  private async adjustWeight(
    listId: string,
    line: ListItem,
    pounds: number,
    /**
     * True when this line was created moments ago by the caller.
     *
     * It changes what a failure *means*. On a pre-existing line, "try again" is safe. On a
     * line the add just created, HEB has already assigned its default weight, so a retry
     * takes the existing-line path and adds the whole request on top of that default —
     * 0.25 lb becomes 2.25 lb. Callers must be told to look instead of repeat.
     */
    justCreated = false,
  ): Promise<ListItem> {
    if (pounds === line.weight) return line;

    try {
      await this.setWeight(listId, line.lineId, pounds);
      return { ...line, weight: pounds };
    } catch (error) {
      // An expired session must survive as itself: the reconciliation read below would hit
      // the same refusal and be reported as an indeterminate upstream failure, costing both
      // the "run the login tool" remedy and the log line the expiry alarm matches on.
      //
      // But on a line the add just created, the remedy alone is not enough. HEB has already
      // given that line its default weight, so repeating the request after logging in takes
      // the existing-line path and adds the whole amount on top — 0.25 lb becomes 2.25 lb.
      // Both facts have to travel together.
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') {
        if (!justCreated) throw error;
        throw new HebError('SESSION_EXPIRED', error.message, {
          cause: error,
          retryable: false,
          details: { ...error.details, partialAdd: true },
        });
      }

      // A definitive refusal likewise has nothing to reconcile — the reconciliation read
      // below would re-read the unchanged line and repackage this as a generic
      // UPSTREAM_ERROR, losing the `rejected` marker and sending the caller back to retry a
      // request HEB has already, definitively, said no to.
      if (isHebError(error) && error.details?.['rejected'] === true) {
        if (!justCreated) throw error;
        throw new HebError(error.code, error.message, {
          cause: error.cause,
          retryable: false,
          details: { ...error.details, partialAdd: true },
        });
      }

      // A schema-drift failure is definitive too, same as the add-item catches above: GraphQL
      // validation runs before the mutation resolver, so the write never reached it.
      // Reconciling below would repackage this as a generic UPSTREAM_ERROR, losing the
      // "skill must be updated" guidance that only fires off this code.
      if (isHebError(error) && error.details?.['schemaDrift'] === true) {
        if (!justCreated) throw error;
        throw new HebError(error.code, error.message, {
          cause: error.cause,
          retryable: false,
          details: { ...error.details, partialAdd: true },
        });
      }

      let current: HebList;
      try {
        current = await this.getList(listId);
      } catch {
        throw new HebError(
          'UPSTREAM_ERROR',
          'HEB did not confirm the weight. Check the list before asking again — it may have worked.',
          {
            cause: error,
            retryable: false,
            details: { indeterminate: true, ...(justCreated ? { partialAdd: true } : {}) },
          },
        );
      }

      const actual = current.items.find((item) => item.lineId === line.lineId);
      // At or above, for the same reason as the quantity path: a household member bumping
      // the same line leaves it heavier than asked, and calling that a failure sends the
      // user to retry a request that was already fulfilled.
      if (actual?.weight !== undefined && actual.weight >= pounds) return actual;
      throw new HebError(
        'UPSTREAM_ERROR',
        actual === undefined
          ? 'HEB did not confirm the weight; check the list before trying again.'
          : `HEB did not confirm the weight. The list still shows ${actual.weight ?? 0} lb.`,
        {
          cause: error,
          retryable: false,
          ...(justCreated ? { details: { partialAdd: true } } : {}),
        },
      );
    }
  }

  /**
   * Set a counter line's weight, in pounds.
   *
   * Same cache and success-union discipline as `setQuantity`; `pounds` must already be
   * snapped onto the product's ladder.
   */
  private async setWeight(listId: string, lineId: string, pounds: number): Promise<void> {
    this.cachedList = undefined;

    const data = await this.client.execute<{
      updateShoppingListItemV2?: { __typename?: string };
    }>(updateItemWeightDocument(listId, lineId, pounds));

    assertMutationSucceeded(data.updateShoppingListItemV2, 'change the weight');
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

    try {
      assertMutationSucceeded(data.deleteShoppingListItemsV2, 'remove the item');
    } catch (error) {
      // A refusal for a stale line id is not a failure if the line is already gone —
      // somebody removing it in the app between the confirmation question and the delete
      // leaves exactly this. Reporting failure sends the user to retry a removal whose
      // end state already holds, and the retry then says the item is not on the list.
      // Authentication and other refusals still propagate.
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') throw error;

      const stillThere = (await this.getList(listId).catch(() => null))?.items.some(
        (item) => item.lineId === input.lineId,
      );
      if (stillThere === false) return;
      throw error;
    }
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
    //
    // Membership alone is not enough either: "milk chocolate" against a line named
    // "H-E-B Chocolate Milk" has every spoken token present, so plain coverage is
    // satisfied — but the phrase names a different product, in the opposite order.
    // Requiring the spoken words to appear on the line *in the order they were said*
    // keeps the shortcut from authorizing a removal for a reordering of the line's words.
    const productTokens = meaningfulTokens(match.product.name);
    const isOrderedSubsequence = (needle: readonly string[], haystack: readonly string[]): boolean => {
      let cursor = 0;
      for (const token of needle) {
        const found = haystack.findIndex(
          (candidate, index) => index >= cursor && tokensMatch(token, candidate),
        );
        if (found === -1) return false;
        cursor = found + 1;
      }
      return true;
    };
    const namesTheLine =
      head !== undefined &&
      coverage([head], match.product) === 1 &&
      isOrderedSubsequence(spokenTokens, productTokens);

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
  if (typename === expected) return;

  // A missing `__typename` is not "the selection did not ask" — every document in this
  // file requests it. It means a null or malformed payload, which would otherwise be
  // mapped into a list with undefined identity, or throw a bare TypeError further down
  // instead of the actionable upstream error.
  if (typename === undefined) {
    throw new HebError('UPSTREAM_ERROR', `HEB returned nothing usable when asked to ${attempted}.`, {
      retryable: true,
      details: { returned: 'missing' },
    });
  }

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
  if (typename === expected) return;

  // A dead session is diagnosed, not generic. The catalog search is reached on every
  // query-based add, and often *after* a list read that still succeeded on cached
  // credentials — so classifying it as UPSTREAM_ERROR costs the login-and-upload remedy,
  // suggests a retry no retry can fix, and keeps the expiry alarm silent.
  if (/auth|unauthori|forbidden|session|login|denied/i.test(typename ?? '')) {
    throw new HebError('SESSION_EXPIRED', 'HEB rejected the stored session.', {
      details: { returned: typename },
    });
  }

  // Absent is a failure, not a shrug: every document here selects `__typename`, so its
  // absence means a null or malformed payload. Accepting it let `productSearchItems`
  // report "no products matched" for a response that contained nothing at all.
  if (typename === undefined) {
    throw new HebError('UPSTREAM_ERROR', `HEB returned nothing usable when asked to ${attempted}.`, {
      retryable: true,
      details: { returned: 'missing' },
    });
  }

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
  // `attempted` rides along so a surface can word the refusal for what was actually being
  // done — "would not set that amount" only makes sense for a weight/quantity change, not
  // for an add or a remove, which set no amount at all.
  throw new HebError('UPSTREAM_ERROR', `HEB refused to ${attempted}.`, {
    retryable: false,
    details: { returned: payload?.__typename ?? 'null', rejected: true, attempted },
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
  const mapped: Product = { id: product.id, name };
  if (brand !== undefined) mapped.brand = brand;

  if (product.pricedByWeight === true) {
    mapped.pricedByWeight = true;
    // Flattened across SKUs and de-duplicated: the ladder is a property of the product as
    // the shopper experiences it, and every SKU we have seen carries the same steps.
    const increments = [
      ...new Set(
        (product.SKUs ?? []).flatMap((sku) => sku.weightSelectionIncrements ?? []),
      ),
    ]
      .filter((pounds) => Number.isFinite(pounds) && pounds > 0)
      .sort((left, right) => left - right);
    if (increments.length > 0) mapped.weightIncrements = increments;
  }

  return mapped;
}

/**
 * Round a requested weight onto what HEB will actually accept.
 *
 * The increments are a closed ladder, not a step size — an off-ladder weight is refused
 * outright, so this is the difference between "two pounds of turkey" working and failing.
 * Ties round *up*: sending someone home with less deli meat than they asked for is the
 * worse of the two errors, and the overshoot is a quarter pound.
 *
 * With no ladder (a weighted product that reported none) the request passes through
 * unchanged; HEB is then the judge, which is the honest fallback.
 */
export function snapWeight(pounds: number, increments?: readonly number[]): number {
  if (increments === undefined || increments.length === 0) return pounds;

  let best = increments[0]!;
  for (const candidate of increments) {
    const closer = Math.abs(candidate - pounds) < Math.abs(best - pounds);
    const tieButLarger =
      Math.abs(candidate - pounds) === Math.abs(best - pounds) && candidate > best;
    if (closer || tieButLarger) best = candidate;
  }
  return best;
}

/**
 * A written line carrying exactly this text.
 *
 * Free-text lines have no product id, so the text is their whole identity — which is
 * precisely why matching on it cannot, on its own, prove a mutation committed.
 */
function isTextLine(text: string): (item: ListItem) => boolean {
  return (item) => item.product === undefined && item.text === text;
}

function toListItem(item: HebListItem): ListItem | null {
  // H-E-B retains checked-off lines on the list instead of deleting them. Surfacing them as
  // still needed would let Alexa and MCP report an item already gathered, and would let
  // removal matching offer a checked line as a candidate to remove again.
  if (item.checked === true) return null;

  const quantity = item.quantity ?? 1;
  const ceiling = item.maximumQuantity === undefined ? {} : { maximumQuantity: item.maximumQuantity };

  // A free-text line: what H-E-B's own "Add \"<text>\" to list" affordance creates, in the
  // app and on the web. The text is in `genericName`; `note` is a separate annotation and
  // is normally null, so reading that instead silently dropped these lines — under-
  // reporting a list H-E-B displays correctly, and letting removal claim the item is not
  // there. `note` is kept only as a fallback.
  if (item.product === undefined) {
    const name = (item.genericName ?? item.note)?.trim();
    if (name === undefined || name === '') return null;
    return { lineId: item.id, text: name, quantity, ...ceiling };
  }

  const product = toProduct(item.product);
  // `weight` is null on every packaged line, so only a real number becomes a weight.
  const weight =
    typeof item.weight === 'number' && item.weight > 0 ? { weight: item.weight } : {};
  return { lineId: item.id, product, text: product.name, quantity, ...weight, ...ceiling };
}

export function toHebList(payload: HebListPayload): HebList {
  return {
    listId: payload.id,
    name: payload.name,
    storeId: payload.fulfillment?.store?.storeNumber?.toString() ?? null,
    items: (payload.itemPage?.items ?? []).map(toListItem).filter((item) => item !== null),
  };
}
