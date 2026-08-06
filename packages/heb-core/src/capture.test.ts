import { describe, expect, it } from 'vitest';
import { isGraphqlUrl } from './capture.js';

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
