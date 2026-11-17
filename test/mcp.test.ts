import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.MAKEFUN_SHOP_TOKEN = 'unit-token';

let server: Server;
let base = '';
const AUTH = { authorization: 'Bearer unit-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

before(async () => {
  const { handleMcp } = await import('../src/mcp.ts');
  server = createServer((req, res) => {
    handleMcp(req, res, new URL(req.url ?? '/', 'http://x')).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

after(() => {
  server.close();
});

async function rpc(body: unknown, headers: Record<string, string> = AUTH): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text), headers: res.headers };
}

test('no Authorization answers 401', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
});

test('non-JSON body answers 400 with -32700', async () => {
  const r = await rpc('{"jsonrpc": "2.0", "id": 1, "method": "tools/list"');
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, -32700);
});

test('server/discover lists supported versions and identity', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, 'd');
  assert.ok(r.json.result.supportedVersions.length > 0);
  assert.ok(r.json.result.supportedVersions.every((v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)));
  assert.ok(r.json.result.supportedVersions.includes('2026-07-28'));
  assert.ok(r.json.result.serverInfo.name);
  assert.ok(r.json.result.capabilities.tools);
});

test('initialize hands out counter session ids and echoes a supported revision', async () => {
  const a = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const b = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(a.json.result.protocolVersion, '2025-06-18');
  assert.equal(b.json.result.protocolVersion, '2025-11-25');
  assert.match(a.headers.get('mcp-session-id') ?? '', /^mcp-session-\d+$/);
  assert.notEqual(a.headers.get('mcp-session-id'), b.headers.get('mcp-session-id'));
  assert.ok(a.json.result.capabilities.tools);
});

test('notifications answer 202 with no body', async () => {
  const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  assert.equal(r.json, null);
});

test('tools/list: required tools, descriptions, object schemas, byte-identical', async () => {
  const a = await fetch(base, { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((r) => r.text());
  const b = await fetch(base, { method: 'POST', headers: AUTH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((r) => r.text());
  assert.equal(a, b);
  const tools = JSON.parse(a).result.tools as any[];
  assert.ok(tools.length >= 6);
  const names = tools.map((t) => t.name);
  for (const n of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) assert.ok(names.includes(n), n);
  for (const t of tools) {
    assert.ok(t.description.length > 0);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(Array.isArray(t.inputSchema.required));
  }
});

test('unknown tool answers -32602', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(r.status, 200);
  assert.equal(r.json.error.code, -32602);
});

test('missing required arguments answer isError', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_issue', arguments: {} } });
  assert.equal(r.json.result.isError, true);
});

test('unknown method answers -32601', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 5, method: 'bogus/method' });
  assert.equal(r.json.error.code, -32601);
});

test('batch keeps each id and drops notifications', async () => {
  const r = await rpc([
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((x: any) => x.id), ['a', 'b']);
});

test('concurrent calls keep their own ids', async () => {
  const [x, y] = await Promise.all([
    rpc({ jsonrpc: '2.0', id: 'left', method: 'tools/call', params: { name: 'nope1' } }),
    rpc({ jsonrpc: '2.0', id: 'right', method: 'tools/call', params: { name: 'nope2' } }),
  ]);
  assert.equal(x.json.id, 'left');
  assert.equal(y.json.id, 'right');
});

test('GET answers 405', async () => {
  const res = await fetch(base, { headers: AUTH });
  assert.equal(res.status, 405);
});
