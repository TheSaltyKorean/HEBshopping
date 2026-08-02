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
   * Non-nullable: W0 established that HEB list items always resolve to a catalog product.
   * Adding requires a `productId`, and the per-line `note` field annotates a product rather
   * than standing in for one. The mobile app can create genuinely free-text lines; this
   * project cannot yet, so every line it creates has a product.
   */
  product: Product;
  /** What to speak back to the user. */
  text: string;
  quantity: number;
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
}

export type AddResult =
  | { status: 'added'; item: ListItem }
  /** Confidence below threshold. Nothing was written. */
  | { status: 'needs_confirmation'; match: MatchResult }
  /** Already on the list; quantity was incremented instead of adding a line. */
  | { status: 'already_present'; item: ListItem };

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
