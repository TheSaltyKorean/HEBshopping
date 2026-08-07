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
      // The document itself, not just the fact that there was one. `tools/lib/browser.ts`
      // spreads this straight into the saved capture, so dropping it left the operation
      // files without the one thing a schema-drift repair needs — while the interface
      // advertised that it was kept.
      ...(typeof record['query'] === 'string' ? { query: record['query'] } : {}),
      variables: record['variables'] ?? null,
    });
  }

  return operations;
}

/**
 * True when a URL is H-E-B's GraphQL endpoint.
 *
 * The persistent browser used for capture can carry the operator to other sites — an email
 * provider, say, while retrieving an emailed OTP. A bare substring test on `/graphql` would
 * accept that site's traffic too, and the capture would persist its request variables and
 * response bodies alongside H-E-B's. Requiring the exact origin keeps the capture to the one
 * site it is documented to cover.
 */
export function isGraphqlUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === 'https://www.heb.com' && parsed.pathname.includes('/graphql');
}

/** Hosts the storage state a capture is documented to cover: the storefront and its login host. */
const HEB_HOSTS = ['heb.com', 'www.heb.com', 'accounts.heb.com'];

function isHebHost(host: string): boolean {
  const bare = host.replace(/^\./, '');
  return HEB_HOSTS.includes(bare);
}

export interface StorageStateLike {
  cookies: Array<{ domain: string; [key: string]: unknown }>;
  origins: Array<{ origin: string; [key: string]: unknown }>;
}

/**
 * Drop cookies and origin storage that don't belong to H-E-B before a capture is written.
 *
 * The persistent browser can carry the operator to another site — an email provider, say,
 * while retrieving an emailed OTP. `context.storageState()` serializes whatever cookies and
 * origin storage exist at that moment, so without this filter that other site's session
 * would be written into the capture alongside H-E-B's.
 */
export function filterHebStorageState<T extends StorageStateLike>(storageState: T): T {
  return {
    ...storageState,
    cookies: storageState.cookies.filter((c) => isHebHost(c.domain)),
    origins: storageState.origins.filter((o) => {
      try {
        return isHebHost(new URL(o.origin).hostname);
      } catch {
        return false;
      }
    }),
  };
}
