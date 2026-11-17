// POST /api/graphql: authentication, body handling and operation batching.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, parseJsonBody, readBody, sendJson } from '../http.ts';
import { store } from '../store.ts';
import { executeDocument } from './execute.ts';
import type { ExecContext, ExecutionResult } from './execute.ts';
import { GraphQLSyntaxError, parse } from './parser.ts';
import { RESOLVERS } from './resolvers.ts';

/** Run one {query, variables, operationName} request body and answer its JSON result. */
export function runOperation(request: unknown, ctx: ExecContext): ExecutionResult {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  const { query, variables, operationName } = request as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  }
  let doc;
  try {
    doc = parse(query);
  } catch (e) {
    if (e instanceof GraphQLSyntaxError) return { errors: [{ message: e.message, locations: e.locations }] };
    throw e;
  }
  let vars = variables;
  if (typeof vars === 'string') {
    try {
      vars = JSON.parse(vars);
    } catch {
      return { errors: [{ message: 'Variables must be a JSON object' }] };
    }
  }
  try {
    return executeDocument(doc, typeof operationName === 'string' ? operationName : null, vars, ctx, RESOLVERS);
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

/** A JSON array body answers one result per operation, in order; an object answers one result. */
export function runBody(body: unknown, ctx: ExecContext): ExecutionResult | ExecutionResult[] {
  if (Array.isArray(body)) return body.map((op) => runOperation(op, ctx));
  return runOperation(body, ctx);
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, _url: URL): Promise<void> {
  if (!store.authorized(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch (e) {
    if (e instanceof HttpError) {
      sendJson(res, 400, { message: e.message });
      return;
    }
    throw e;
  }
  const host = req.headers.host ?? 'localhost';
  sendJson(res, 200, runBody(body, { origin: `http://${host}` }));
}
