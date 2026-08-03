/**
 * Session health must judge the cookie the request will actually carry.
 *
 * `cookieHeaderFor` and `checkSession` are two halves of one decision. When they disagree
 * about which duplicate applies, the jar is graded on a credential that never goes on the
 * wire — and the fast SESSION_EXPIRED path, with its login prompt, is skipped in favour of
 * an upstream rejection.
 */

import { describe, expect, it } from 'vitest';
import { checkSession, cookieHeaderFor } from './session.js';
import type { Cookie, SessionState } from './types.js';

const NOW = 1_800_000_000_000;
const seconds = (ms: number) => Math.floor(ms / 1_000);

function cookie(name: string, path: string, expiresMs: number): Cookie {
  return {
    name,
    value: `${name}-at-${path}`,
    domain: 'www.heb.com',
    path,
    expires: seconds(expiresMs),
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

/** The cookies `checkSession` insists on, all healthy, plus whatever a test adds. */
function jarWith(...extra: Cookie[]): SessionState {
  const far = NOW + 30 * 24 * 3_600_000;
  return {
    cookies: [
      cookie('sat', '/', far),
      cookie('sst', '/', far),
      cookie('sst.sig', '/', far),
      { ...cookie('reese84', '/', far), domain: '.heb.com' },
      ...extra,
    ],
    capturedAt: NOW,
    buildId: null,
  };
}

describe('checkSession agrees with cookieHeaderFor', () => {
  it('grades the path-specific copy that is actually sent, not the longest-lived one', () => {
    // `sat` exists twice: a `/graphql` copy dying in a minute, and a root copy good for a
    // month. The browser rule sends the more specific one, so that is the one whose expiry
    // decides whether this jar is usable.
    const session = jarWith(cookie('sat', '/graphql', NOW + 60_000));

    const header = cookieHeaderFor(session, 'www.heb.com', '/graphql', NOW);
    expect(header).toContain('sat=sat-at-/graphql');

    const health = checkSession(session, NOW);
    // Whatever the verdict, it must be derived from the cookie in that header — so the
    // reported expiry cannot be the root copy's month away.
    expect(health.expiresAt).toBe(NOW + 60_000);
  });

  it('falls back to the root copy when the specific one is dead — on both sides', () => {
    // A fully expired path-specific copy is skipped by `cookieHeaderFor` too, so the root
    // copy is what goes on the wire and the jar really is healthy. The two halves have to
    // agree here as well: grading this as expired would demand a login nobody needs.
    const session = jarWith(cookie('sat', '/graphql', NOW - 60_000));

    expect(cookieHeaderFor(session, 'www.heb.com', '/graphql', NOW)).toContain('sat=sat-at-/');
    expect(checkSession(session, NOW).usable).toBe(true);
  });

  it('still prefers the longer-lived copy when paths are equally specific', () => {
    // Lifetime only breaks a genuine tie — the rule `preferred` encodes.
    const soon = NOW + 60_000;
    const later = NOW + 10 * 24 * 3_600_000;
    const session = jarWith(cookie('sat', '/', soon), cookie('sat', '/', later));

    // The base jar already holds a 30-day `sat` at `/`, so the soonest expiry among the
    // *required* cookies is whichever the tie-break keeps — never the 60-second one.
    expect(checkSession(session, NOW).expiresAt).toBeGreaterThan(soon);
  });
});
