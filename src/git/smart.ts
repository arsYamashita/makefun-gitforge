// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2, with a v0 fallback) and
// receive-pack (v0). Object selection lives in upload.ts, ref updates in receive.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { HttpError, MAX_BODY_BYTES, nextRequestId, readBody, sendJson } from '../http.ts';
import type { Repo } from '../store.ts';
import { store } from '../store.ts';
import { ZERO_SHA, isSha } from './objects.ts';
import { writePack } from './pack.ts';
import { DELIM, FLUSH, lineOf, pkt, readPackets, sideband } from './pktline.ts';
import type { Packet } from './pktline.ts';
import { receivePack } from './receive.ts';
import { peelObject } from './repo.ts';
import { FetchError, planFetch } from './upload.ts';
import type { FetchParams } from './upload.ts';

const AGENT = 'forge/1.0';

function respond(res: ServerResponse, type: string, body: Buffer | readonly Buffer[]): void {
  const data = Buffer.isBuffer(body) ? body : Buffer.concat(body as readonly Buffer[]);
  res.writeHead(200, {
    'content-type': type,
    'content-length': data.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    'x-github-request-id': nextRequestId(),
  });
  res.end(data);
}

function headerOf(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

function wantsV2(req: IncomingMessage): boolean {
  return headerOf(req, 'git-protocol').split(/[:,\s]+/).includes('version=2');
}

function authorizedForGit(req: IncomingMessage): boolean {
  if (store.token === '') return true;
  const header = headerOf(req, 'authorization');
  if (header === '') return false;
  if (store.authorized(header)) return true;
  const basic = /^basic\s+(.+)$/i.exec(header.trim());
  if (basic === null) return false;
  const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const user = colon < 0 ? decoded : decoded.slice(0, colon);
  const password = colon < 0 ? '' : decoded.slice(colon + 1);
  return password === store.token || user === store.token;
}

function denyAuth(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="GitHub"' });
}

function refsOf(repo: Repo): Array<[string, string]> {
  return [...repo.git.refs].filter(([, sha]) => repo.git.objects.has(sha)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headSha(repo: Repo): string | undefined {
  const sha = repo.git.refs.get(repo.git.head);
  return sha !== undefined && repo.git.objects.has(sha) ? sha : undefined;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function advertiseV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const upload = service === 'git-upload-pack';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const head = upload ? headSha(repo) : undefined;
  const caps = upload
    ? `thin-pack side-band-64k ofs-delta shallow deepen-since deepen-not no-progress${head !== undefined ? ` symref=HEAD:${repo.git.head}` : ''} object-format=sha1 agent=${AGENT}`
    : `report-status delete-refs side-band-64k ofs-delta object-format=sha1 agent=${AGENT}`;
  const lines: string[] = [];
  if (head !== undefined) lines.push(`${head} HEAD`);
  for (const [ref, sha] of refsOf(repo)) {
    lines.push(`${sha} ${ref}`);
    if (upload && ref.startsWith('refs/tags/')) {
      const peeled = peelObject(repo, sha);
      if (peeled !== undefined && peeled !== sha) lines.push(`${peeled} ${ref}^{}`);
    }
  }
  if (lines.length === 0) lines.push(`${ZERO_SHA} capabilities^{}`);
  lines.forEach((line, index) => parts.push(pkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 commands
// ---------------------------------------------------------------------------------------------

function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const head = headSha(repo);
  if (keep('HEAD')) {
    if (head !== undefined) out.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${repo.git.head}` : ''}\n`));
    else if (unborn) out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${repo.git.head}` : ''}\n`));
  }
  for (const [ref, sha] of refsOf(repo)) {
    if (!keep(ref)) continue;
    let line = `${sha} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const peeled = peelObject(repo, sha);
      if (peeled !== undefined && peeled !== sha) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function packfileSection(plan: ReturnType<typeof planFetch>): Buffer[] {
  const pack = writePack(plan.objects);
  return [pkt('packfile\n'), ...sideband(1, pack), FLUSH];
}

function errorPacket(message: string): Buffer {
  return Buffer.concat([pkt(`ERR ${message}\n`)]);
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const params = parseFetchArgs(args);
  const done = args.includes('done');
  let plan: ReturnType<typeof planFetch>;
  try {
    plan = planFetch(repo, params);
  } catch (err) {
    if (err instanceof FetchError) return errorPacket(err.message);
    throw err;
  }
  const out: Buffer[] = [];
  if (!done) {
    out.push(pkt('acknowledgments\n'));
    if (plan.common.length === 0) {
      out.push(pkt('NAK\n'), FLUSH);
      return Buffer.concat(out);
    }
    for (const sha of plan.common) out.push(pkt(`ACK ${sha}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  const depthRequested = params.deepen !== undefined || params.deepenSince !== undefined || (params.deepenNot?.length ?? 0) > 0;
  if (depthRequested) {
    out.push(pkt('shallow-info\n'));
    for (const sha of plan.shallow) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(DELIM);
  }
  out.push(...packfileSection(plan));
  return Buffer.concat(out);
}

function parseFetchArgs(args: string[]): FetchParams {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let deepen: number | undefined;
  let deepenSince: number | undefined;
  for (const arg of args) {
    const space = arg.indexOf(' ');
    const key = space < 0 ? arg : arg.slice(0, space);
    const value = space < 0 ? '' : arg.slice(space + 1);
    switch (key) {
      case 'want':
        if (!isSha(value)) throw new HttpError(400, 'bad want');
        wants.push(value);
        break;
      case 'have':
        if (isSha(value)) haves.push(value);
        break;
      case 'shallow':
        if (isSha(value)) clientShallow.push(value);
        break;
      case 'deepen': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad deepen');
        deepen = n;
        break;
      }
      case 'deepen-since':
        deepenSince = Number(value);
        break;
      case 'deepen-not':
        deepenNot.push(value);
        break;
      default:
        break;
    }
  }
  return { wants, haves, clientShallow, deepen, deepenSince, deepenNot };
}

function handleV2(repo: Repo, packets: Packet[]): Buffer {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = lineOf(packet);
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else args.push(line);
  }
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  throw new HttpError(400, `unknown command ${JSON.stringify(command.slice(0, 40))}`);
}

// ---------------------------------------------------------------------------------------------
// v0 upload-pack
// ---------------------------------------------------------------------------------------------

function handleV0Upload(repo: Repo, packets: Packet[]): Buffer {
  const params: { wants: string[]; haves: string[]; shallow: string[]; deepen?: number; since?: number; not: string[] } = {
    wants: [],
    haves: [],
    shallow: [],
    not: [],
  };
  let caps: string[] = [];
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = lineOf(packet);
    if (line.startsWith('want ')) {
      const rest = line.slice(5).split(' ');
      if (!isSha(rest[0])) throw new HttpError(400, 'bad want');
      params.wants.push(rest[0]);
      if (caps.length === 0 && rest.length > 1) caps = rest.slice(1);
    } else if (line.startsWith('have ')) {
      if (isSha(line.slice(5))) params.haves.push(line.slice(5));
    } else if (line.startsWith('shallow ')) {
      params.shallow.push(line.slice(8));
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7));
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad deepen');
      params.deepen = n;
    } else if (line.startsWith('deepen-since ')) params.since = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) params.not.push(line.slice(11));
    else if (line === 'done') done = true;
  }
  if (params.wants.length === 0) return FLUSH;
  let plan: ReturnType<typeof planFetch>;
  try {
    plan = planFetch(repo, {
      wants: params.wants,
      haves: params.haves,
      clientShallow: params.shallow,
      deepen: params.deepen,
      deepenSince: params.since,
      deepenNot: params.not,
    });
  } catch (err) {
    if (err instanceof FetchError) return errorPacket(err.message);
    throw err;
  }
  const out: Buffer[] = [];
  if (params.deepen !== undefined || params.since !== undefined || params.not.length > 0) {
    for (const sha of plan.shallow) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(FLUSH);
  }
  if (!done) {
    out.push(pkt('NAK\n'));
    return Buffer.concat(out);
  }
  out.push(pkt(plan.common.length > 0 ? `ACK ${plan.common[plan.common.length - 1]}\n` : 'NAK\n'));
  const pack = writePack(plan.objects);
  if (caps.includes('side-band-64k') || caps.includes('side-band')) out.push(...sideband(1, pack), FLUSH);
  else out.push(pack);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

const ROUTE = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const ROUTE_BARE = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const match = ROUTE.exec(url.pathname) ?? ROUTE_BARE.exec(url.pathname);
  if (match === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const [, owner, name, endpoint] = match;
  const method = req.method ?? 'GET';
  if (method === 'POST') await readBodyOf(req); // drained below by the handler that needs it
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (endpoint === 'info/refs') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 403, { message: 'The dumb HTTP protocol is not supported' });
      return;
    }
    if (!authorizedForGit(req)) {
      denyAuth(res);
      return;
    }
    const body = service === 'git-upload-pack' && wantsV2(req) ? advertiseV2() : advertiseV0(repo, service);
    respond(res, `application/x-${service}-advertisement`, body);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const service = endpoint;
  if (!authorizedForGit(req)) {
    denyAuth(res);
    return;
  }
  const gzipped = /gzip/i.test(headerOf(req, 'content-encoding'));
  const raw = await readBodyOf(req);
  try {
    if (service === 'git-receive-pack') {
      respond(res, 'application/x-git-receive-pack-result', receivePack(repo, raw, gzipped));
      return;
    }
    let body = raw;
    if (gzipped) {
      try {
        body = gunzipSync(raw, { maxOutputLength: MAX_BODY_BYTES });
      } catch {
        throw new HttpError(400, 'bad gzip body');
      }
    }
    const { packets } = readPackets(body);
    const reply = wantsV2(req) ? handleV2(repo, packets) : handleV0Upload(repo, packets);
    respond(res, 'application/x-git-upload-pack-result', reply);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    throw err;
  }
}

// A request body can be read once; keep it so the early-404 path and the handler share it.
const bodies = new WeakMap<IncomingMessage, Promise<Buffer>>();
function readBodyOf(req: IncomingMessage): Promise<Buffer> {
  let pending = bodies.get(req);
  if (pending === undefined) {
    pending = readBody(req);
    bodies.set(req, pending);
  }
  return pending;
}
