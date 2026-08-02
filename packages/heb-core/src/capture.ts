/**
 * Pure parsing of GraphQL POST traffic.
 *
 * Kept deliberately transport-agnostic — strings in, data out, no Playwright and no CDP —
 * so the discovery tools and tests can share it.
 *
 * Note this is now a *discovery* aid only. The hash-tracking machinery that once lived
 * here is gone: W0 established that HEB's APQ is non-strict, so we send our own query text
 * and never depend on a persisted hash staying valid.
 */

export interface ParsedOperation {
  operationName: string;
  /** `null` when the client sent full query text instead of a persisted hash. */
  sha256Hash: string | null;
  hasFullQuery: boolean;
  /** The document itself, when the client sent one. Present only in gitignored captures. */
  query?: string;
  variables: unknown;
}

/** Operation name used when a request carries no `operationName` field. */
export const ANONYMOUS_OPERATION = '(anonymous)';

/**
 * Parse a GraphQL request body into zero or more operations.
 *
 * Handles both single operations and batched arrays. Returns `[]` for anything unparseable
 * rather than throwing: this runs against live traffic we don't control, where one
 * malformed body must not take down a capture session.
 */
export function parseGraphqlPost(postData: string): ParsedOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    return [];
  }

  const bodies = Array.isArray(parsed) ? parsed : [parsed];
  const operations: ParsedOperation[] = [];

  for (const body of bodies) {
    if (typeof body !== 'object' || body === null) continue;
    const record = body as Record<string, unknown>;

    const extensions = record['extensions'] as Record<string, unknown> | undefined;
    const persisted = extensions?.['persistedQuery'] as Record<string, unknown> | undefined;

    operations.push({
      operationName:
        typeof record['operationName'] === 'string' ? record['operationName'] : ANONYMOUS_OPERATION,
      sha256Hash: typeof persisted?.['sha256Hash'] === 'string' ? persisted['sha256Hash'] : null,
      hasFullQuery: typeof record['query'] === 'string',
      variables: record['variables'] ?? null,
    });
  }

  return operations;
}

/** True when a URL is a GraphQL endpoint we care about. */
export function isGraphqlUrl(url: string): boolean {
  return url.includes('/graphql');
}
