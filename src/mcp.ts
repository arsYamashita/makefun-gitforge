// Model Context Protocol endpoint: JSON-RPC 2.0 over the Streamable HTTP transport, answered as
// application/json. Both protocol eras are served: the 2026-07-28 revision (server/discover, every
// request declares its revision, no session) and the handshake revisions (initialize,
// notifications/initialized, an optional Mcp-Session-Id). The tools act through src/actions.ts, so a
// repository or issue made here reads back over REST as the same object.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readBody, sendJson } from './http.ts';
import { store } from './store.ts';
import { TOOLS, callTool, ToolFailure } from './mcp/tools.ts';

export const MODERN_REVISION = '2026-07-28';
export const SUPPORTED_REVISIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_DEFAULT = '2025-11-25';

const SERVER_INFO = { name: 'makefun-gitforge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Id = string | number | null;
type Json = Record<string, unknown>;

interface RpcOutcome {
  /** The JSON-RPC response object, or null for a notification. */
  response: Json | null;
  headers?: Record<string, string>;
}

let sessionCounter = 0;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResponse(id: Id, code: number, message: string, data?: unknown): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function resultResponse(id: Id, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

/** Handle one JSON-RPC message (request or notification). Never throws. */
async function dispatch(message: unknown, origin: string): Promise<RpcOutcome> {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    const id = isRecord(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    return { response: errorResponse(id, INVALID_REQUEST, 'Invalid Request') };
  }
  const hasId = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number');
  const id: Id = hasId ? (message.id as string | number) : null;
  const method = message.method;
  const params: Json = isRecord(message.params) ? message.params : {};

  if (!hasId) {
    // a notification (initialized, cancelled, ...): accepted, no answer
    return { response: null };
  }

  try {
    switch (method) {
      case 'server/discover': {
        return {
          response: resultResponse(id, {
            resultType: 'complete',
            supportedVersions: [...SUPPORTED_REVISIONS],
            capabilities: CAPABILITIES,
            serverInfo: SERVER_INFO,
            instructions: 'A GitHub-compatible forge. Tools act on the same repositories, issues and pull requests as the REST API.',
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          }),
        };
      }
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const chosen = SUPPORTED_REVISIONS.includes(asked) ? asked : LEGACY_DEFAULT;
        sessionCounter += 1;
        return {
          response: resultResponse(id, {
            protocolVersion: chosen,
            capabilities: CAPABILITIES,
            serverInfo: SERVER_INFO,
            instructions: 'A GitHub-compatible forge. Tools act on the same repositories, issues and pull requests as the REST API.',
          }),
          headers: { 'mcp-session-id': `mcp-session-${sessionCounter}` },
        };
      }
      case 'ping':
        return { response: resultResponse(id, {}) };
      case 'tools/list':
        return { response: resultResponse(id, { tools: TOOLS }) };
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || name === '') return { response: errorResponse(id, INVALID_PARAMS, 'tools/call requires a tool name') };
        if (params.arguments !== undefined && !isRecord(params.arguments)) return { response: errorResponse(id, INVALID_PARAMS, 'arguments must be an object') };
        try {
          const result = await callTool(name, isRecord(params.arguments) ? params.arguments : {}, origin);
          return { response: resultResponse(id, result) };
        } catch (err) {
          if (err instanceof ToolFailure) {
            if (err.rpcCode !== undefined) return { response: errorResponse(id, err.rpcCode, err.message) };
            return { response: resultResponse(id, { content: [{ type: 'text', text: err.message }], isError: true }) };
          }
          if (err instanceof HttpError) {
            return { response: resultResponse(id, { content: [{ type: 'text', text: `${err.message}${err.extra.errors ? ' ' + JSON.stringify(err.extra.errors) : ''}` }], isError: true }) };
          }
          return { response: resultResponse(id, { content: [{ type: 'text', text: `internal error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }) };
        }
      }
      default:
        return { response: errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
    }
  } catch (err) {
    return { response: errorResponse(id, INTERNAL_ERROR, err instanceof Error ? err.message : 'internal error') };
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, _url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    if (!store.authorized(req.headers.authorization)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Bearer' });
      return;
    }
    sendJson(res, 204, undefined);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Method not allowed' } }, { allow: 'POST, DELETE' });
    return;
  }
  if (!store.authorized(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Bearer' });
    return;
  }

  const raw = (await readBody(req)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, errorResponse(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  const host = req.headers.host ?? 'localhost';
  const origin = `http://${host}`;

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(res, 400, errorResponse(null, INVALID_REQUEST, 'Invalid Request: empty batch'));
      return;
    }
    const outcomes = await Promise.all(parsed.map((m) => dispatch(m, origin)));
    const responses = outcomes.map((o) => o.response).filter((r): r is Json => r !== null);
    if (responses.length === 0) {
      sendJson(res, 202, undefined);
      return;
    }
    sendJson(res, 200, responses);
    return;
  }

  const outcome = await dispatch(parsed, origin);
  if (outcome.response === null) {
    sendJson(res, 202, undefined);
    return;
  }
  sendJson(res, 200, outcome.response, outcome.headers ?? {});
}
