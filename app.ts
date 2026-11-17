// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and MCP from one
// in-memory store (src/store.ts). This file only routes; each surface lives in its own module.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpError, sendJson } from './src/http.ts';
import { handleGit } from './src/git/smart.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql/index.ts';
import { handleMcp } from './src/mcp.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('http://entry/');
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = urlOf(req);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, url);
    return;
  }
  if (path === '/api/graphql' || path === '/api/graphql/' || path === '/graphql') {
    await handleGraphql(req, res, url);
    return;
  }
  if (path === '/mcp' || path === '/mcp/') {
    await handleMcp(req, res, url);
    return;
  }
  if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path) || /^\/[^/]+\/[^/]+\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
    await handleGit(req, res, url);
    return;
  }
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message, ...err.extra });
        return;
      }
      process.stderr.write(`[forge] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
