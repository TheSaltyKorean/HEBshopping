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

    // Best-effort. The broadened search exists to *add* reach; if it times out or is
    // challenged, the candidates already in hand are still perfectly good — failing the
    // whole add would turn every ambiguous multi-word query into an upstream error rather
    // than the confirmation choices we already have.
    const extra = await this.searchProducts(broader, listId).catch(() => []);
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
      // A counter line is measured in pounds, so "add another pound of turkey" adds weight
      // rather than a second line-unit — the same increment semantics, different unit.
      // Never below what is already there, for the same reason quantity is floored.
      if (existing.product?.pricedByWeight === true) {
        if (input.weight === undefined) {
          // "Add sliced turkey" when a counter line already exists. There is no honest
          // amount to add: this line is measured in pounds, and a quantity update on it
          // either gets refused or changes a number nobody buys by. Report what is on the
          // list and let the surface say it — "you already have two pounds" invites the
          // amount, whereas a bogus write invents one.
          return { status: 'already_present', item: existing };
        }
        const target = Math.max(
          existing.weight ?? 0,
          snapWeight((existing.weight ?? 0) + input.weight, existing.product.weightIncrements),
        );
        return {
          status: 'already_present',
          item: await this.adjustWeight(listId, existing, target),
        };
      }

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
          // At *or above*: a household member incrementing the same line before the
          // reconciliation read leaves it higher than asked for, and treating that as a
          // failure sends the user to retry a request that was already fulfilled.
          if (actual !== undefined && actual.quantity >= target) {
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
      // The mutation succeeded; the returned page simply does not contain the new line —
      // a long category-sorted list can place it outside the page. Throwing a retryable
      // error here sends the user to add it again, and the retry finds the line and
      // increments it. Look before saying anything.
      this.cachedList = undefined;
      const seen = await this.getList(listId).catch(() => null);
      added = seen?.items.find((item) => item.product?.id === productId);

      if (added === undefined) {
        throw new HebError(
          'UPSTREAM_ERROR',
          'HEB accepted the add but did not return the item. Check the list before asking again.',
          { retryable: false, details: { indeterminate: true } },
        );
      }
    }

    // A weight request only means something if the product is genuinely sold by the pound.
    // For a packaged good ("Chicken Breasts, Avg. 2.85 lbs") it is not expressible — you
    // buy the package — so the weight is dropped and one package is added. The caller can
    // tell which happened: a weighted line comes back with `weight` set.
    if (added.product?.pricedByWeight === true) {
      if (input.weight === undefined) {
        // Counter goods have no unit to multiply. HEB assigned this line its own default
        // weight on creation, and that is what the surface confirms — the spoken reply
        // states pounds, so the shopper hears the real amount rather than a silent "1".
        return { status: 'added', item: added };
      }
      const target = Math.max(
        added.weight ?? 0,
        snapWeight(input.weight, added.product.weightIncrements),
      );
      return {
        status: 'added',
        item: await this.adjustWeight(listId, added, target, true),
      };
    }

    if (quantity > 1) {
      // Floored by what the add actually returned, exactly as the existing-line branch is.
      // The opening read found no line, but a household member can create the same product
      // in between — HEB then increments *their* line and returns it at, say, six. Writing
      // an absolute two would delete four units somebody else put there.
      const target = Math.max(
        added.quantity,
        Math.min(quantity, added.maximumQuantity ?? quantity),
      );
      try {
        await this.setQuantity(listId, added.lineId, target);
        return { status: 'added', item: { ...added, quantity: target } };
      } catch (error) {
        // The add already succeeded — a line exists — but whether the quantity bump landed
        // is unknown, and `setQuantity` invalidated the cache before writing so a read here
        // reaches HEB. Reporting the stale payload's quantity of one would understate what
        // is on the list and invite another add, over-incrementing it.
        let seen: HebList;
        try {
          seen = await this.getList(listId);
        } catch {
          // Both the quantity write and the readback failed, most likely because the first
          // timeout spent the budget. A line definitely exists and its quantity is unknown,
          // so an unmarked error here would reach Alexa's generic "please try again" — and
          // the retry finds that line and increments it by the whole requested amount.
          throw new HebError(
            'UPSTREAM_ERROR',
            `Added ${added.text}, but could not confirm the amount. Check the list before asking again.`,
            { cause: error, retryable: false, details: { partialAdd: true } },
          );
        }

        const actual = seen.items.find((item) => item.lineId === added.lineId);

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
    this.cachedList = undefined;

    let payload: HebListPayload;
    try {
      const data = await this.client.execute<{ addShoppingListItemsV2: HebListPayload }>(
        addTextDocument(id, trimmed),
      );
      assertMutationSucceeded(data.addShoppingListItemsV2, 'add the note');
      payload = data.addShoppingListItemsV2;
    } catch (error) {
      // Indeterminate exactly like a product add: the line may exist. Match on the text,
      // which is the only identity a free-text line has.
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') throw error;

      let seen: HebList;
      try {
        seen = await this.getList(id);
      } catch {
        // The reconciliation read failed too, most likely because the first timeout spent
        // the budget. Nothing is known, and "try again" is the one answer that can make it
        // worse: the retry would write a *second* copy of the same line, since a written
        // line has no product id to deduplicate against.
        throw new HebError(
          'UPSTREAM_ERROR',
          'HEB did not confirm the note. Check the list before asking again — it may have worked.',
          { cause: error, retryable: false, details: { indeterminate: true } },
        );
      }

      const committed = seen.items.find(
        (item) => item.product === undefined && item.text === trimmed,
      );
      if (committed === undefined) throw error;
      return this.applyTextQuantity(id, committed, quantity);
    }

    const added = toHebList(payload).items.find(
      (item) => item.product === undefined && item.text === trimmed,
    );
    if (added === undefined) {
      throw new HebError('UPSTREAM_ERROR', 'HEB accepted the note but did not return it.', {
        retryable: false,
        details: { indeterminate: true },
      });
    }
    return this.applyTextQuantity(id, added, quantity);
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
    quantity: number,
  ): Promise<AddResult> {
    const target = Math.max(line.quantity, Math.trunc(quantity));
    if (target <= line.quantity) return { status: 'added', item: line };

    try {
      await this.setQuantity(listId, line.lineId, target);
      return { status: 'added', item: { ...line, quantity: target } };
    } catch (error) {
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') throw error;

      const seen = await this.getList(listId).catch(() => null);
      const actual = seen?.items.find((item) => item.lineId === line.lineId);
      if (actual !== undefined && actual.quantity >= target) {
        return { status: 'added', item: actual };
      }
      throw new HebError(
        'UPSTREAM_ERROR',
        `Wrote ${line.text} on the list, but could not set the amount to ${target}.`,
        { cause: error, retryable: false, details: { partialAdd: true } },
      );
    }
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
      // An expired session must survive as itself. The reconciliation read below would hit
      // the same refusal and be reported as an indeterminate upstream failure, costing both
      // the "run the login tool" remedy and the log line the expiry alarm matches on.
      if (isHebError(error) && error.code === 'SESSION_EXPIRED') throw error;

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

function toListItem(item: HebListItem): ListItem | null {
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
