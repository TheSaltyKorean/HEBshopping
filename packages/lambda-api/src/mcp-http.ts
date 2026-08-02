/**
 * Streamable HTTP MCP endpoint, served from a Lambda Function URL.
 *
 * The same four tools as the stdio server, over the transport Gemini Spark requires. The
 * SDK's web-standard transport takes a `Request` and returns a `Response`, which is very
 * nearly what a Function URL hands us — this file is mostly that adaptation plus the
 * authentication a public URL demands.
 *
 * **A Function URL is open to the internet.** Nothing else stands between this endpoint
 * and a stranger's shopping list, so the bearer check happens before anything is parsed,
 * compares in constant time, and the token itself comes from SSM rather than an
 * environment variable — Lambda env vars are readable by anyone holding
 * `lambda:GetFunctionConfiguration`.
 */

import { timingSafeEqual } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { HebClient, HebListOps } from '@heb/core';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createHebMcpServer } from '@heb/mcp-server';
import { MCP_BUDGET_MS, listId, resolveStore } from './config.js';

interface FunctionUrlEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface FunctionUrlResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

const store = resolveStore();
const pinnedList = listId();

/**
 * How long a fetched token may be reused.
 *
 * Caching forever would mean rotation does not revoke anything: a warm container keeps
 * honouring the *old* token — the one you rotated because it leaked — and rejects the new
 * one, for as long as AWS keeps that container alive. Since this token is the only thing
 * guarding a public URL, rotation has to take effect on a schedule we control rather than
 * on Lambda's recycling whims. Five minutes costs at most a dozen SSM reads an hour.
 */
const TOKEN_TTL_MS = 5 * 60 * 1_000;

/**
 * The bearer token, fetched at most once per TTL per container.
 *
 * Deliberately not cached across a failure — a transient SSM error should not permanently
 * disable authentication.
 */
let cachedToken: Promise<string> | undefined;
let cachedAt = 0;

function bearerToken(): Promise<string> {
  if (cachedToken !== undefined && Date.now() - cachedAt > TOKEN_TTL_MS) {
    cachedToken = undefined;
  }

  if (cachedToken === undefined) cachedAt = Date.now();

  cachedToken ??= (async () => {
    const name = process.env['HEB_MCP_TOKEN_PARAM'];
    if (name === undefined || name.trim() === '') {
      throw new Error('HEB_MCP_TOKEN_PARAM is required: the Function URL is public.');
    }
    const result = await new SSMClient({}).send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    if (value === undefined || value.trim() === '') {
      throw new Error(`SSM parameter ${name} is empty.`);
    }
    return value;
  })().catch((error: unknown) => {
    cachedToken = undefined; // let the next invocation try again
    throw error;
  });

  return cachedToken;
}

/**
 * Constant-time comparison that does not leak length.
 *
 * `timingSafeEqual` throws on differing lengths, and branching on that would itself be an
 * oracle, so both sides are hashed to a fixed width first — cheap, and removes the whole
 * category.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(presented);
  const b = encoder.encode(expected);
  if (a.length !== b.length) {
    // Still do the work, so a wrong-length token costs the same as a wrong one.
    timingSafeEqual(Buffer.from(b), Buffer.from(b));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function unauthorized(): FunctionUrlResult {
  return {
    statusCode: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
    body: JSON.stringify({ error: 'unauthorized' }),
  };
}

export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  // Authenticate before parsing anything. An unauthenticated caller should not be able to
  // reach the JSON-RPC layer at all, let alone the HEB session behind it.
  const presented = (event.headers?.['authorization'] ?? '').replace(/^Bearer\s+/i, '');
  if (presented === '') return unauthorized();

  let expected: string;
  try {
    expected = await bearerToken();
  } catch (error) {
    // Never echo the reason: it would distinguish "misconfigured" from "wrong token".
    console.error('MCP auth unavailable:', error instanceof Error ? error.name : 'unknown');
    return { statusCode: 503, body: JSON.stringify({ error: 'unavailable' }) };
  }

  if (!tokensMatch(presented, expected)) return unauthorized();

  // Stateless: no sessionIdGenerator, so each request is self-contained. Lambda gives no
  // continuity between invocations anyway, and pretending otherwise would strand sessions
  // on whichever container happened to serve `initialize`.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  const server = createHebMcpServer({
    createListOps: () =>
      new HebListOps({
        client: new HebClient({ store, budgetMs: MCP_BUDGET_MS }),
        ...(pinnedList === undefined ? {} : { listId: pinnedList }),
      }),
  });

  await server.connect(transport);

  try {
    const body =
      event.body === undefined
        ? undefined
        : event.isBase64Encoded === true
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body;

    const request = new Request(`https://lambda${event.rawPath ?? '/'}`, {
      method: event.requestContext?.http?.method ?? 'POST',
      headers: Object.fromEntries(
        Object.entries(event.headers ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ...(body === undefined ? {} : { body }),
    });

    const response = await transport.handleRequest(request);
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  } finally {
    await server.close().catch(() => undefined);
  }
};
