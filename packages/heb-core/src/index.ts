/**
 * @heb/core — the shared HEB client.
 *
 * Pure library: no AWS imports, and no I/O beyond HTTP and the injected `Store`.
 * The Alexa handler, the MCP server, and the refresher are all thin adapters over this.
 */

export * from './types.js';
export * from './errors.js';
export * from './constants.js';
export * from './capture.js';
export * from './session.js';
export * from './matching.js';
export * from './lists.js';
export * from './graphql/operations.js';
export * from './graphql/client.js';
export * from './store/file-store.js';
// NOTE: `store/store-contract.js` is deliberately NOT re-exported here — it imports vitest,
// and this entry point is bundled into the Lambda. Consumers get it via `@heb/core/testing`.
