import { describe, expect, it } from 'vitest';
import { HebError, hasCode, isHebError } from './errors.js';

describe('HebError', () => {
  it('defaults retryability per code rather than requiring every call site to decide', () => {
    // The distinction that matters operationally: a bot challenge may pass on a retry,
    // but a dead session needs a human (passkey/OTP cannot be replayed headlessly).
    expect(new HebError('BOT_CHALLENGE', 'challenged').retryable).toBe(true);
    expect(new HebError('SESSION_EXPIRED', 'expired').retryable).toBe(false);
  });

  it('allows an explicit override of the default', () => {
    expect(new HebError('UPSTREAM_ERROR', 'down', { retryable: false }).retryable).toBe(false);
  });

  it('preserves the underlying cause for logs', () => {
    const cause = new Error('ECONNRESET');
    expect(new HebError('UPSTREAM_ERROR', 'wrapped', { cause }).cause).toBe(cause);
  });

  it('narrows correctly', () => {
    const error: unknown = new HebError('ITEM_NOT_ON_LIST', 'nope');
    expect(isHebError(error)).toBe(true);
    expect(hasCode(error, 'ITEM_NOT_ON_LIST')).toBe(true);
    expect(hasCode(error, 'BOT_CHALLENGE')).toBe(false);
    expect(hasCode(new Error('plain'), 'BOT_CHALLENGE')).toBe(false);
  });
});
