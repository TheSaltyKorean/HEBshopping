/**
 * Tunables and well-known HEB endpoints.
 *
 * Every number here is a named constant precisely so it is greppable and reviewable.
 * If you find yourself writing a bare number in a call site, it probably belongs here.
 */

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const HEB_ORIGIN = 'https://www.heb.com';
export const HEB_GRAPHQL_URL = `${HEB_ORIGIN}/graphql`;

/**
 * Auth is a *separate host* from the storefront (plan §2.3). Session capture must span
 * both, and `/interaction/{uid}/login` is `node-oidc-provider`'s signature URL shape.
 */
export const HEB_ACCOUNTS_ORIGIN = 'https://accounts.heb.com';

/** Both hosts whose cookies make up a valid session. */
export const HEB_SESSION_HOSTS = [HEB_ORIGIN, HEB_ACCOUNTS_ORIGIN] as const;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Below this confidence we return `needs_confirmation` and write nothing.
 *
 * Erring low is the safe direction: an unnecessary "did you mean X?" is a minor
 * annoyance, whereas silently adding the wrong product is the failure users notice.
 */
export const CONFIRMATION_THRESHOLD = 0.7;

/**
 * The largest count any surface will act on, and the largest weight in pounds.
 *
 * Lives here because three places have to agree: the MCP tool schema, the Alexa pending-state
 * validator, and the spoken-request parser. They did not — the parser accepted an unbounded
 * digit, so "21 bananas" was read as a count of 21, which the schema and the validator both
 * reject. That mismatch is not merely inconsistent: `addRemainingUnits` issues one live
 * mutation per unit, so an unbounded count is a burst of real writes against someone's list,
 * and an ambiguous one leaves pending state the next turn refuses to read.
 *
 * A number above the ceiling is not clamped. Silently turning "21 bananas" into 20 writes an
 * amount nobody asked for; leaving it in the query keeps the words the speaker said, and the
 * confirmation reads them back.
 */
export const MAX_QUANTITY = 20;
export const MAX_WEIGHT_LB = 20;

// ---------------------------------------------------------------------------
// Timing — derived from Alexa's ~8s response ceiling (plan §3.2)
// ---------------------------------------------------------------------------

/**
 * Hard timeout on any single outbound HEB call. Never await one unbounded: failing fast
 * inside budget and speaking a graceful error beats Alexa timing out silently.
 *
 * Worst case to design against is search + mutation, i.e. two of these in sequence.
 */
export const HEB_REQUEST_TIMEOUT_MS = 3_000;

/**
 * Cookies that must be present and unexpired for an authenticated request to www.heb.com.
 *
 * `accounts.heb.com` cookies are deliberately absent: they are not sent to the storefront
 * host, so they cannot gate a request. They still matter for re-login, which is why the
 * session captures both hosts.
 *
 * `sst.sig` is the signature over `sst` and expires on its own schedule. Requiring only
 * the unsigned value would let `checkSession` call a jar usable — and `tools/login.ts`
 * persist it — while every authenticated request is rejected. Failing here costs nothing;
 * failing at the network call costs a voice command.
 */
export const REQUIRED_REQUEST_COOKIES = ['sat', 'sst', 'sst.sig', 'reese84'] as const;

/**
 * Refuse a session this close to its cookie expiry, rather than letting a request fail
 * mid-command. A voice user would rather hear "you need to log in" than a generic error.
 */
export const SESSION_EXPIRY_MARGIN_MS = 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Politeness toward an upstream that did not invite us
// ---------------------------------------------------------------------------

export const MAX_CONCURRENT_REQUESTS = 2;
export const MIN_REQUEST_DELAY_MS = 250;
export const REQUEST_JITTER_MS = 150;
export const MAX_RETRIES = 2;
