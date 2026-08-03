/**
 * Session inspection: is this cookie jar usable, and what should we send?
 *
 * Kept separate from the HTTP client so the "can we even try?" question is answerable
 * without a network call — the surfaces need to fail fast and say something useful.
 */

import { REQUIRED_REQUEST_COOKIES, SESSION_EXPIRY_MARGIN_MS } from './constants.js';
import type { Cookie, SessionState } from './types.js';

/** Playwright stores domain cookies with a leading dot and host-only cookies without. */
export function cookieMatchesHost(cookie: Pick<Cookie, 'domain'>, host: string): boolean {
  if (cookie.domain.startsWith('.')) {
    const bare = cookie.domain.slice(1);
    return host === bare || host.endsWith(`.${bare}`);
  }
  return host === cookie.domain;
}

/** `expires` is seconds since epoch; -1 means a session cookie with no expiry. */
export function cookieIsExpired(cookie: Pick<Cookie, 'expires'>, nowMs: number): boolean {
  if (cookie.expires === -1) return false;
  return cookie.expires * 1_000 <= nowMs;
}

/**
 * Build the `Cookie` header a browser would send to `host`.
 *
 * Expired copies are dropped, and where a name appears more than once the longest-lived
 * survivor wins — the same choice `checkSession` makes. Otherwise the two disagree: health
 * would accept a jar on the strength of a live duplicate while the header still led with
 * the dead one, and a server resolving the first copy would reject a session we had just
 * declared usable. Browsers do not send expired cookies either.
 */
export function cookieHeaderFor(
  session: SessionState,
  host: string,
  path = '/graphql',
  nowMs = Date.now(),
): string {
  const best = new Map<string, Cookie>();

  for (const cookie of session.cookies) {
    if (!cookieMatchesHost(cookie, host)) continue;
    if (!cookiePathMatches(cookie, path)) continue;
    if (cookieIsExpired(cookie, nowMs)) continue;

    const incumbent = best.get(cookie.name);
    if (incumbent === undefined || preferred(cookie, incumbent)) best.set(cookie.name, cookie);
  }

  return [...best.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * RFC 6265 path matching.
 *
 * Without it a cookie scoped to `/account` would be sent to `/graphql` — and, worse, could
 * displace the root-scoped copy that actually applies, so a jar `checkSession` accepted
 * gets rejected upstream.
 */
export function cookiePathMatches(cookie: Pick<Cookie, 'path'>, requestPath: string): boolean {
  const scope = cookie.path === '' ? '/' : cookie.path;
  if (scope === '/' || scope === requestPath) return true;
  if (!requestPath.startsWith(scope)) return false;
  return scope.endsWith('/') || requestPath[scope.length] === '/';
}

/**
 * Which of two same-named cookies to send.
 *
 * Browsers prefer the more specific path first; lifetime only breaks a genuine tie. Using
 * lifetime alone could discard a `/graphql`-scoped cookie in favour of a longer-lived root
 * one, which is not what the server expects to receive.
 */
function preferred(candidate: Cookie, incumbent: Cookie): boolean {
  if (candidate.path.length !== incumbent.path.length) {
    return candidate.path.length > incumbent.path.length;
  }
  return outlives(candidate, incumbent);
}

/** -1 means a session cookie: no expiry, so it outlives every dated one. */
function outlives(candidate: Cookie, incumbent: Cookie): boolean {
  if (candidate.expires === -1) return true;
  if (incumbent.expires === -1) return false;
  return candidate.expires > incumbent.expires;
}

export interface SessionHealth {
  usable: boolean;
  /** Human-readable reason, suitable for a log line. Never contains cookie values. */
  reason?: string;
  /** Epoch ms at which the soonest-expiring required cookie dies, if any has an expiry. */
  expiresAt?: number;
}

/**
 * Judge whether a session can still authenticate a request to `www.heb.com`.
 *
 * Checks the cookies that actually gate a storefront request. `accounts.heb.com` cookies
 * are excluded on purpose — they are never sent to `www.heb.com`, so their state cannot
 * make a request succeed or fail. They matter only for re-login.
 *
 * A margin is applied so we refuse a session that is about to die rather than letting it
 * fail halfway through a voice command.
 */
export function checkSession(
  session: SessionState | null,
  nowMs: number,
  marginMs: number = SESSION_EXPIRY_MARGIN_MS,
): SessionHealth {
  if (session === null) {
    return { usable: false, reason: 'no session stored' };
  }

  const missing: string[] = [];
  const expired: string[] = [];
  let soonestExpiry: number | undefined;

  for (const name of REQUIRED_REQUEST_COOKIES) {
    // All host-matching copies, not the first one. A browser jar legitimately holds the
    // same name for `.heb.com` and `www.heb.com`, and `find` made session health depend on
    // array order — an expired duplicate ahead of a live one forced a needless login while
    // perfectly good credentials sat further down the array.
    const copies = session.cookies.filter(
      (candidate) => candidate.name === name && cookieMatchesHost(candidate, 'www.heb.com'),
    );

    if (copies.length === 0) {
      missing.push(name);
      continue;
    }

    // The longest-lived copy, not the first unexpired one. Otherwise a duplicate expiring
    // inside the safety margin can sit ahead of one good for months, and the whole jar is
    // declared "expires imminently" — usability still hostage to array order, just one
    // step further along than before.
    const usable = copies
      .filter((candidate) => !cookieIsExpired(candidate, nowMs))
      // -1 means a session cookie: no expiry at all, so it outlives every dated one.
      .map((candidate) => (candidate.expires === -1 ? Number.POSITIVE_INFINITY : candidate.expires * 1_000))
      .sort((a, b) => b - a);

    const longest = usable[0];
    if (longest === undefined) {
      expired.push(name);
      continue;
    }
    if (Number.isFinite(longest)) {
      soonestExpiry = soonestExpiry === undefined ? longest : Math.min(soonestExpiry, longest);
    }
  }

  if (missing.length > 0) {
    return { usable: false, reason: `missing cookies: ${missing.join(', ')}` };
  }
  if (expired.length > 0) {
    return { usable: false, reason: `expired cookies: ${expired.join(', ')}` };
  }
  if (soonestExpiry !== undefined && soonestExpiry - nowMs < marginMs) {
    return {
      usable: false,
      reason: 'session expires imminently',
      expiresAt: soonestExpiry,
    };
  }

  return soonestExpiry === undefined
    ? { usable: true }
    : { usable: true, expiresAt: soonestExpiry };
}
