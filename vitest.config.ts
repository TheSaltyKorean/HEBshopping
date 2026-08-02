import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Live tests hit the real HEB API and are opt-in via HEB_LIVE=1. CI must be able to
    // pass with no network access at all — see plan §6.1.
    passWithNoTests: true,
  },
});
