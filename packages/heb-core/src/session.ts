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

/** Build the `Cookie` header a browser would send to `host`. */
export function cookieHeaderFor(session: SessionState, host: string): string {
  return session.cookies
    .filter((cookie) => cookieMatchesHost(cookie, host))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
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
    const cookie = session.cookies.find(
      (candidate) => candidate.name === name && cookieMatchesHost(candidate, 'www.heb.com'),
    );

    if (cookie === undefined) {
      missing.push(name);
      continue;
    }
    if (cookieIsExpired(cookie, nowMs)) {
      expired.push(name);
      continue;
    }
    if (cookie.expires !== -1) {
      const expiresAt = cookie.expires * 1_000;
      soonestExpiry = soonestExpiry === undefined ? expiresAt : Math.min(soonestExpiry, expiresAt);
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
