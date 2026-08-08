/**
 * Binding contracts for the HEB shopping-list system.
 *
 * These shapes are fixed by the plan (§4). Implementations behind them are free to
 * change; these declarations are not. Both surfaces (Alexa, MCP) and the refresher
 * code against this file.
 */

// ---------------------------------------------------------------------------
// Storage port
// ---------------------------------------------------------------------------

/**
 * The seam that makes local development possible.
 *
 * Two implementations: `FileStore` (local dev and tests) and `DynamoDbStore` (prod).
 *
 * RULE: nothing above this layer may import the AWS SDK. If you find yourself needing
 * AWS to test business logic, this seam has been violated.
 */
export interface Store {
  getSession(): Promise<SessionState | null>;
  putSession(session: SessionState): Promise<void>;
}

/** A cookie in Playwright's `storageState` shape. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since epoch; -1 means a session cookie with no expiry. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface SessionState {
  /**
   * MUST span BOTH `www.heb.com` and `accounts.heb.com`.
   *
   * Auth lives on the accounts host — see plan §2.3. Capturing only the storefront
   * appears to work and then fails on renewal, which is a nasty way to find out.
   */
  cookies: Cookie[];
  /** Epoch ms at which this state was captured. */
  capturedAt: number;
  /** Next.js build id of `www.heb.com`. `accounts.heb.com` is not Next.js. */
  buildId: string | null;
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  /** Full display name, e.g. "Oatly Original Oat Milk, 64 oz". */
  name: string;
  brand?: string;
  size?: string;
  price?: number;
  /**
   * Sold at a counter and priced per pound — deli meat and cheese sliced to order,
   * seafood. These lines carry a `weight`, not a `quantity`.
   *
   * A name that quotes a weight does not make a product weighted: "Boneless Chicken
   * Breasts, Avg. 2.85 lbs" is one package and this is false for it.
   */
  pricedByWeight?: boolean;
  /**
   * The weights H-E-B will accept for this product, in pounds, ascending. 0.25-lb steps
   * in practice. An off-ladder weight is refused, so callers must snap onto it — see
   * `snapWeight`. Only meaningful when `pricedByWeight` is true.
   */
  weightIncrements?: number[];
}

export interface MatchResult {
  product: Product;
  /** 0..1. Below `CONFIRMATION_THRESHOLD`, callers must not write. */
  confidence: number;
  /** Ordered, best first. May be empty. */
  alternatives: Product[];
}

/**
 * A list line ranked against spoken text.
 *
 * `confident` is true only for a top candidate that cleared `CONFIRMATION_THRESHOLD` — at
 * most one entry in a result set. A voice surface offers the rest one at a time.
 */
export interface LineMatch {
  item: ListItem;
  confident: boolean;
}

export interface ListItem {
  /** HEB's item UUID for this line; what `updateShoppingListItem` and `deleteShoppingListItems` take. */
  lineId: string;
  /**
   * Absent for a free-text line.
   *
   * H-E-B offers `Add "<what you typed>" to list` — in the app and on the web — producing
   * a `GenericShoppingListItemV2` whose text is in `genericName` and which has no product
   * at all. This project both reads and creates them; see `AddItemInput.text`.
   */
  product?: Product;
  /** What to speak back. Always populated — for a free-text line this is the note itself. */
  text: string;
  quantity: number;
  /**
   * Pounds, for a counter line (`product.pricedByWeight`). Absent on everything else.
   *
   * When present this — not `quantity` — is what the shopper actually asked for, and it is
   * what a surface should speak back.
   */
  weight?: number;
  /** Server-side upper bound for this line. Respect it rather than letting HEB reject the write. */
  maximumQuantity?: number;
}

export interface HebList {
  listId: string;
  name: string;
  storeId: string | null;
  items: ListItem[];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface AddItemInput {
  /**
   * Add a free-text line instead of a catalog product.
   *
   * H-E-B's own UI offers this the moment the search box has text, and it is the only
   * honest answer when nothing in the catalog matches — better a line saying what you
   * asked for than no line at all. Mutually exclusive with `query` and `productId`.
   */
  text?: string;
  listId?: string;
  /** Spoken or typed text that still needs matching. Mutually exclusive with `productId`. */
  query?: string;
  /**
   * An already-resolved product. Mutually exclusive with `query`.
   *
   * This is how a `needs_confirmation` result gets confirmed on the second call,
   * and how MCP adds a product after a search.
   */
  productId?: string;
  quantity?: number;
  /**
   * Pounds, for "add two pounds of sliced turkey".
   *
   * Applied only if the resolved product is actually `pricedByWeight`; for a packaged good
   * a weight is meaningless (you cannot buy 2 lb of a 2.85 lb package), so it is ignored
   * and one package is added. The returned item says which happened — a weighted line
   * comes back with `weight` set.
   */
  weight?: number;
}

/**
 * `quantityRequested`, present on `added`/`already_present`, is the total the line should
 * hold had every unit landed. It differs from `item.quantity` when HEB's own
 * `maximumQuantity` stopped the adds short, so the caller can report the shortfall instead
 * of confirming the full amount as if it had all gone through.
 *
 * On a brand-new line (`status: 'added'`) it can also differ the other way: a household
 * member merging the same previously-absent product into the line mid-request makes
 * `item.quantity` come back *higher* than what this request asked for. `quantityRequested`
 * still names what this request actually asked for, so the caller can say one was added and
 * the list now holds more, instead of crediting the whole merged total to this request.
 *
 * `weightRequested` is the same idea for counter goods: present when the product's own
 * weight ladder tops out below what was asked for, so `item.weight` is the last rung and
 * not the full request. Without it, a 5 lb request against a 2 lb ladder confirms 2 lb as
 * if that were the whole ask instead of reporting the shortfall.
 *
 * `weightRequested` is also present when a weight was asked for but the resolved product
 * turned out to be packaged, not priced by weight — there `item.weight` is undefined
 * entirely, and the caller says one package was added instead of the pounds requested.
 *
 * On a brand-new counter line it can also be *less* than `item.weight`, the weight
 * equivalent of `quantityRequested` reading higher than requested above: a household
 * member's concurrent add merged into the line before this request's write, so
 * `item.weight` is their weight plus this request's. `weightRequested` then names only
 * this request's own contribution, so the caller can say that amount was added and the
 * list now totals `item.weight`, instead of crediting the merged total to this request.
 */
export type AddResult =
  | { status: 'added'; item: ListItem; quantityRequested?: number; weightRequested?: number }
  /** Confidence below threshold. Nothing was written. */
  | { status: 'needs_confirmation'; match: MatchResult }
  /**
   * Already on the list; quantity was incremented instead of adding a line — except when
   * `wrote` is `false`, meaning nothing was sent to HEB at all: blocked by the quantity
   * ceiling, or a counter good asked for again with no weight to apply. Absent (or `true`)
   * for every other case, where a quantity merge or weight adjustment did land.
   */
  | {
      status: 'already_present';
      item: ListItem;
      quantityRequested?: number;
      weightRequested?: number;
      wrote?: boolean;
    };

export interface RemoveItemInput {
  listId?: string;
  lineId: string;
}

/** The operations both surfaces call. Alexa and MCP are thin adapters over this. */
export interface ListOps {
  getLists(): Promise<HebList[]>;
  /** Omit `listId` for the default list; see `resolveDefaultList` rules in the plan §4.2. */
  getList(listId?: string): Promise<HebList>;
  addItem(input: AddItemInput): Promise<AddResult>;
  removeItem(input: RemoveItemInput): Promise<void>;
}
