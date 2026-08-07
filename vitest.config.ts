import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A package can have no test files yet (e.g. mcp-server) without failing a scoped run.
    passWithNoTests: true,
  },
});
