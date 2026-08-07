import { describe, expect, it } from 'vitest';
import { filterHebStorageState, isGraphqlUrl } from './capture.js';

describe('isGraphqlUrl', () => {
  it('accepts H-E-B\'s own GraphQL endpoint', () => {
    expect(isGraphqlUrl('https://www.heb.com/graphql')).toBe(true);
  });

  it('rejects another site\'s /graphql path, even during the same capture session', () => {
    // The persistent browser can carry the operator to another site — an email provider,
    // say, while retrieving an emailed OTP. A bare substring test on "/graphql" would accept
    // that site's traffic too and persist its request/response bodies into the capture.
    expect(isGraphqlUrl('https://mail.example.com/graphql')).toBe(false);
  });

  it('rejects a lookalike host that merely contains heb.com', () => {
    expect(isGraphqlUrl('https://www.heb.com.evil.example/graphql')).toBe(false);
  });

  it('rejects a malformed URL instead of throwing', () => {
    expect(isGraphqlUrl('not a url')).toBe(false);
  });
});

describe('filterHebStorageState', () => {
  it('drops cookies and origins from a site visited in the same persistent context', () => {
    const filtered = filterHebStorageState({
      cookies: [
        { domain: '.heb.com', name: 'a' },
        { domain: 'www.heb.com', name: 'b' },
        { domain: 'accounts.heb.com', name: 'c' },
        { domain: 'mail.example.com', name: 'd' },
      ],
      origins: [
        { origin: 'https://www.heb.com', localStorage: [] },
        { origin: 'https://accounts.heb.com', localStorage: [] },
        { origin: 'https://mail.example.com', localStorage: [] },
      ],
    });

    expect(filtered.cookies.map((c) => c.domain)).toEqual([
      '.heb.com',
      'www.heb.com',
      'accounts.heb.com',
    ]);
    expect(filtered.origins.map((o) => o.origin)).toEqual([
      'https://www.heb.com',
      'https://accounts.heb.com',
    ]);
  });
});
