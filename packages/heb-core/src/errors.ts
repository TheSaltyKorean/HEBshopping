/**
 * Error taxonomy (plan §4.1).
 *
 * The codes are fixed so both surfaces can branch on them identically. The spoken or
 * written copy for each is the surface's business, not this module's.
 *
 * Note what is deliberately NOT here: low-confidence product matching on add. That is
 * the `needs_confirmation` branch of `AddResult`, not an error — nothing went wrong and
 * nothing was written. Errors are for states the user cannot resolve by answering a
 * question.
 */
export type HebErrorCode =
  /** Cookies are dead. Needs `tools/login.ts` run by a human; passkey/OTP block automation. */
  | 'SESSION_EXPIRED'
  /** Hit the Imperva interstitial. */
  | 'BOT_CHALLENGE'
  /**
   * No catalog match for the query.
   *
   * Recoverable, not terminal: H-E-B's own `Add "<text>" to list` affordance puts the
   * request on the list as a plain written line, and this project can now create those —
   * `addItem({ text })`, `heb_add_item` with `text`. Surfaces should offer that rather
   * than reporting a dead end, because a line saying what someone asked for beats no line.
   */
  | 'PRODUCT_NOT_FOUND'
  /** Several lists exist and none is clearly the default. */
  | 'AMBIGUOUS_LIST'
  /** The spoken item matches several lines on the list. */
  | 'AMBIGUOUS_REMOVAL'
  /** Removal target is not on the list. */
  | 'ITEM_NOT_ON_LIST'
  /** HEB 5xx, timeout, or open circuit. Never leak internals to the user. */
  | 'UPSTREAM_ERROR';

export interface HebErrorOptions {
  cause?: unknown;
  /**
   * Whether an immediate retry could plausibly succeed. `QUERY_HASH_STALE` is retryable
   * once the registry has relearned; `SESSION_EXPIRED` is not retryable by a machine.
   */
  retryable?: boolean;
  /** Structured context for logs. Must never contain cookies, tokens, or request bodies. */
  details?: Record<string, unknown>;
}

export class HebError extends Error {
  readonly code: HebErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: HebErrorCode, message: string, options: HebErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HebError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.details = options.details;
  }
}

const DEFAULT_RETRYABLE: Record<HebErrorCode, boolean> = {
  SESSION_EXPIRED: false,
  BOT_CHALLENGE: true,
  PRODUCT_NOT_FOUND: false,
  AMBIGUOUS_LIST: false,
  AMBIGUOUS_REMOVAL: false,
  ITEM_NOT_ON_LIST: false,
  UPSTREAM_ERROR: true,
};

export function isHebError(error: unknown): error is HebError {
  return error instanceof HebError;
}

/** Narrow an unknown throw to a specific code, for `catch` blocks and tests. */
export function hasCode(error: unknown, code: HebErrorCode): error is HebError {
  return isHebError(error) && error.code === code;
}
