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
  path = '/graphql',
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
    // Path-filtered, exactly as `cookieHeaderFor` is. Judging health on a copy the request
    // will not carry is worse than not judging it: a long-lived `/account` duplicate would
    // vouch for a jar whose eligible root copy has expired, and the call then goes upstream
    // missing a required cookie instead of failing fast with SESSION_EXPIRED.
    const copies = session.cookies.filter(
      (candidate) =>
        candidate.name === name &&
        cookieMatchesHost(candidate, 'www.heb.com') &&
        cookiePathMatches(candidate, path),
    );

    if (copies.length === 0) {
      missing.push(name);
      continue;
    }

    // *The copy the request will actually carry* — chosen by `preferred`, exactly as
    // `cookieHeaderFor` chooses it: more specific path first, lifetime only breaking a tie.
    //
    // Judging by lifetime alone silently grades a different cookie than the one being sent.
    // A `/graphql`-scoped copy expiring in a minute is what goes on the wire, while a
    // root-scoped copy good for months makes the jar look healthy — so instead of the fast
    // SESSION_EXPIRED path and its login prompt, the call goes upstream and is rejected.
    const live = copies.filter((candidate) => !cookieIsExpired(candidate, nowMs));

    let sent: Cookie | undefined;
    for (const candidate of live) {
      if (sent === undefined || preferred(candidate, sent)) sent = candidate;
    }

    if (sent === undefined) {
      expired.push(name);
      continue;
    }
    // -1 means a session cookie: no expiry at all, so it never bounds the jar's life.
    if (sent.expires !== -1) {
      const dies = sent.expires * 1_000;
      soonestExpiry = soonestExpiry === undefined ? dies : Math.min(soonestExpiry, dies);
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
