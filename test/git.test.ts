import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { store } from '../src/store.ts';
import type { Repo } from '../src/store.ts';
import { handleGit } from '../src/git/smart.ts';
import { FLUSH, pkt, readPackets, lineOf } from '../src/git/pktline.ts';
import { PackError, applyDelta, readPack, writePack } from '../src/git/pack.ts';
import { serializeCommit, serializeTree, hashObject as hashRaw } from '../src/git/objects.ts';
import {
  commitChange, diffCommits, hashObject, isAncestor, listBranches, listCommits, mergeBase, mergeable, parseCommit,
  parseSignature, parseTree, readObject, readPath, resolveRef, squashMerge, updateRef, writeObject,
} from '../src/git/repo.ts';

let counter = 0;
function freshRepo(): Repo {
  counter += 1;
  return store.createRepo({ name: `t${counter}` });
}
const text = (value: string): Buffer => Buffer.from(value, 'utf8');

test('hashing matches git', () => {
  assert.equal(hashObject('blob', text('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(hashObject('tree', Buffer.alloc(0)), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

test('commitChange builds nested trees, readPath reads them back, deletes prune empty directories', () => {
  const repo = freshRepo();
  const first = commitChange(repo, { branch: 'main', path: 'a/b/c.txt', content: text('one\n'), message: 'first' });
  assert.equal(repo.git.refs.get('refs/heads/main'), first.commitSha);
  assert.equal(first.blobSha, hashObject('blob', text('one\n')));
  const info = parseCommit(readObject(repo, first.commitSha)!.body);
  assert.deepEqual(info.parents, []);
  assert.equal(info.message, 'first\n');
  assert.equal(parseSignature(info.author).email, store.viewer.email);
  const second = commitChange(repo, { branch: 'main', path: 'a/top.txt', content: text('two'), message: 'second\n' });
  assert.deepEqual(parseCommit(readObject(repo, second.commitSha)!.body).parents, [first.commitSha]);
  const blob = readPath(repo, second.commitSha, 'a/b/c.txt');
  assert.equal(blob?.kind, 'blob');
  assert.equal(blob?.kind === 'blob' && blob.data.toString(), 'one\n');
  const dir = readPath(repo, second.commitSha, 'a');
  assert.equal(dir?.kind === 'tree' && dir.entries.map((entry) => entry.name).join(','), 'b,top.txt');
  assert.equal(readPath(repo, second.commitSha, 'nope'), undefined);
  assert.equal(readPath(repo, second.commitSha, '')?.kind, 'tree');
  const deleted = commitChange(repo, { branch: 'main', path: 'a/b/c.txt', content: null, message: 'rm' });
  assert.equal(deleted.blobSha, null);
  assert.equal(readPath(repo, deleted.commitSha, 'a/b'), undefined);
  assert.ok(readPath(repo, deleted.commitSha, 'a/top.txt'));
  assert.deepEqual(listCommits(repo, deleted.commitSha, 10).map((entry) => entry.sha), [deleted.commitSha, second.commitSha, first.commitSha]);
  assert.equal(listCommits(repo, deleted.commitSha, 2).length, 2);
});

test('trees sort directories as if they ended in a slash', () => {
  const body = serializeTree([
    { mode: '40000', name: 'a', sha: 'a'.repeat(40) },
    { mode: '100644', name: 'a.txt', sha: 'b'.repeat(40) },
    { mode: '100644', name: 'a0', sha: 'c'.repeat(40) },
  ]);
  assert.deepEqual(parseTree(body).map((entry) => entry.name), ['a.txt', 'a', 'a0']);
});

test('refs: resolve, update, list', () => {
  const repo = freshRepo();
  const { commitSha } = commitChange(repo, { branch: 'main', path: 'f', content: text('x'), message: 'm' });
  assert.equal(resolveRef(repo, 'main'), commitSha);
  assert.equal(resolveRef(repo, 'HEAD'), commitSha);
  assert.equal(resolveRef(repo, 'refs/heads/main'), commitSha);
  assert.equal(resolveRef(repo, commitSha), commitSha);
  assert.equal(resolveRef(repo, commitSha.slice(0, 8)), commitSha);
  assert.equal(resolveRef(repo, 'missing'), undefined);
  updateRef(repo, 'refs/heads/zed', commitSha);
  updateRef(repo, 'alpha', commitSha);
  assert.deepEqual(listBranches(repo), [
    { name: 'alpha', sha: commitSha },
    { name: 'main', sha: commitSha },
    { name: 'zed', sha: commitSha },
  ]);
  updateRef(repo, 'alpha', null);
  assert.equal(resolveRef(repo, 'alpha'), undefined);
});

test('history helpers: isAncestor and mergeBase', () => {
  const repo = freshRepo();
  const root = commitChange(repo, { branch: 'main', path: 'f', content: text('0'), message: 'root' }).commitSha;
  updateRef(repo, 'side', root);
  const m1 = commitChange(repo, { branch: 'main', path: 'f', content: text('1'), message: 'm1' }).commitSha;
  const s1 = commitChange(repo, { branch: 'side', path: 'g', content: text('s'), message: 's1' }).commitSha;
  assert.ok(isAncestor(repo, root, m1));
  assert.ok(!isAncestor(repo, m1, root));
  assert.ok(!isAncestor(repo, m1, s1));
  assert.ok(isAncestor(repo, m1, m1));
  assert.equal(mergeBase(repo, m1, s1), root);
  assert.equal(mergeBase(repo, m1, root), root);
});

test('diffCommits reports added, removed and modified files with patches', () => {
  const repo = freshRepo();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const base = commitChange(repo, { branch: 'main', path: 'doc.txt', content: text(`${lines.join('\n')}\n`), message: 'base' }).commitSha;
  commitChange(repo, { branch: 'main', path: 'gone.txt', content: text('bye\n'), message: 'gone' });
  const base2 = resolveRef(repo, 'main')!;
  const edited = [...lines];
  edited[2] = 'changed';
  edited.splice(15, 0, 'inserted');
  commitChange(repo, { branch: 'main', path: 'doc.txt', content: text(`${edited.join('\n')}\n`), message: 'edit' });
  commitChange(repo, { branch: 'main', path: 'gone.txt', content: null, message: 'rm' });
  commitChange(repo, { branch: 'main', path: 'dir/new.txt', content: text('fresh'), message: 'new' });
  const head = resolveRef(repo, 'main')!;
  const diff = diffCommits(repo, base2, head);
  assert.deepEqual(diff.map((file) => [file.filename, file.status]), [['dir/new.txt', 'added'], ['doc.txt', 'modified'], ['gone.txt', 'removed']]);
  const doc = diff[1];
  assert.equal(doc.additions, 2);
  assert.equal(doc.deletions, 1);
  assert.equal(doc.changes, 3);
  assert.equal(doc.sha, hashObject('blob', text(`${edited.join('\n')}\n`)));
  assert.match(doc.patch, /^@@ -1,6 \+1,6 @@\n line 0\n line 1\n-line 2\n\+changed\n line 3/);
  assert.match(doc.patch, /\n@@ -13,6 \+13,7 @@\n/);
  assert.equal(diff[0].patch, '@@ -0,0 +1 @@\n+fresh\n\\ No newline at end of file');
  assert.equal(diffCommits(repo, base, base).length, 0);
});

test('squashMerge merges disjoint changes, refuses conflicts, mergeable agrees', () => {
  const repo = freshRepo();
  const root = commitChange(repo, { branch: 'main', path: 'shared.txt', content: text('v0'), message: 'root' }).commitSha;
  updateRef(repo, 'feature', root);
  updateRef(repo, 'clash', root);
  const feature = commitChange(repo, { branch: 'feature', path: 'dir/f.txt', content: text('feature'), message: 'f' }).commitSha;
  const clash = commitChange(repo, { branch: 'clash', path: 'shared.txt', content: text('theirs'), message: 'c' }).commitSha;
  const main1 = commitChange(repo, { branch: 'main', path: 'main.txt', content: text('main'), message: 'm' }).commitSha;
  const before = repo.git.objects.size;
  assert.ok(mergeable(repo, 'main', feature));
  assert.equal(repo.git.objects.size, before);
  assert.ok(mergeable(repo, 'main', clash));
  commitChange(repo, { branch: 'main', path: 'shared.txt', content: text('ours'), message: 'm2' });
  assert.ok(!mergeable(repo, 'main', clash));
  assert.deepEqual(squashMerge(repo, { baseBranch: 'main', headSha: clash, message: 'x' }), { ok: false, conflict: true });
  const tip = resolveRef(repo, 'main')!;
  const merged = squashMerge(repo, { baseBranch: 'main', headSha: feature, message: 'Squash feature (#1)' });
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.equal(resolveRef(repo, 'main'), merged.sha);
  assert.deepEqual(parseCommit(readObject(repo, merged.sha)!.body).parents, [tip]);
  for (const path of ['dir/f.txt', 'main.txt', 'shared.txt']) assert.ok(readPath(repo, merged.sha, path), path);
  assert.equal((readPath(repo, merged.sha, 'shared.txt') as { data: Buffer }).data.toString(), 'ours');
  void main1;
});

test('squashMerge into an unborn branch takes the head tree', () => {
  const repo = freshRepo();
  const feature = commitChange(repo, { branch: 'feature', path: 'a', content: text('a'), message: 'a' }).commitSha;
  const merged = squashMerge(repo, { baseBranch: 'main', headSha: feature, message: 'init' });
  assert.ok(merged.ok);
  assert.ok(readPath(repo, resolveRef(repo, 'main')!, 'a'));
});

// ---------------------------------------------------------------------------------------------
// protocol
// ---------------------------------------------------------------------------------------------

let server: Server;
let base = '';
test.before(async () => {
  server = createServer((req, res) => {
    handleGit(req, res, new URL(req.url ?? '/', 'http://x')).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});
test.after(() => {
  server.close();
  server.closeAllConnections();
});

const ZERO = '0'.repeat(40);

async function post(repo: Repo, service: string, body: Buffer, v2 = false): Promise<Buffer> {
  const response = await fetch(`${base}/${repo.owner.login}/${repo.name}.git/${service}`, {
    method: 'POST',
    headers: { 'content-type': `application/x-${service}-request`, ...(v2 ? { 'git-protocol': 'version=2' } : {}) },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), `application/x-${service}-result`);
  return Buffer.from(await response.arrayBuffer());
}

function pushBody(commands: Array<[string, string, string]>, pack: Buffer | null): Buffer {
  const lines = commands.map(([oldSha, newSha, ref], i) => pkt(i === 0 ? `${oldSha} ${newSha} ${ref}\0report-status side-band-64k\n` : `${oldSha} ${newSha} ${ref}\n`));
  return Buffer.concat([...lines, FLUSH, ...(pack ? [pack] : [])]);
}

/** The "ok"/"ng" lines of a side-band report-status answer. */
function reportOf(answer: Buffer): string[] {
  const outer = readPackets(answer).packets.filter((packet) => packet.kind === 'data');
  const inner = Buffer.concat(outer.map((packet) => (packet.kind === 'data' ? packet.payload.subarray(1) : Buffer.alloc(0))));
  return readPackets(inner).packets.filter((packet) => packet.kind === 'data').map(lineOf);
}

function makeCommit(repo: Repo, files: Record<string, string>, parents: string[], message: string): { sha: string; objects: Array<{ type: 'commit' | 'tree' | 'blob'; body: Buffer }> } {
  const objects: Array<{ type: 'commit' | 'tree' | 'blob'; body: Buffer }> = [];
  const entries = Object.entries(files).map(([name, content]) => {
    const body = text(content);
    objects.push({ type: 'blob', body });
    return { mode: '100644', name, sha: hashRaw('blob', body) };
  });
  const tree = serializeTree(entries);
  objects.push({ type: 'tree', body: tree });
  const who = 'T <t@example.invalid> 1700000000 +0000';
  const commit = serializeCommit({ tree: hashRaw('tree', tree), parents, author: who, committer: who, message: `${message}\n` });
  objects.push({ type: 'commit', body: commit });
  void repo;
  return { sha: hashRaw('commit', commit), objects };
}

function lsRefsBody(args: string[] = []): Buffer {
  return Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001', 'ascii'), ...args.map((arg) => pkt(`${arg}\n`)), FLUSH]);
}

function fetchBody(args: string[]): Buffer {
  return Buffer.concat([pkt('command=fetch\n'), Buffer.from('0001', 'ascii'), ...args.map((arg) => pkt(`${arg}\n`)), FLUSH]);
}

function packOf(answer: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let inPack = false;
  for (const packet of readPackets(answer).packets) {
    if (packet.kind !== 'data') continue;
    if (!inPack) {
      if (lineOf(packet) === 'packfile') inPack = true;
      continue;
    }
    if (packet.payload[0] === 1) chunks.push(packet.payload.subarray(1));
  }
  return Buffer.concat(chunks);
}

test('push, ls-refs, fetch, shallow, non-ff and delete over the wire', async () => {
  const repo = freshRepo();
  const c1 = makeCommit(repo, { 'a.txt': 'one\n' }, [], 'c1');
  const c2 = makeCommit(repo, { 'a.txt': 'two\n', 'b.txt': 'b\n' }, [c1.sha], 'c2');
  const c3 = makeCommit(repo, { 'a.txt': 'three\n', 'b.txt': 'b\n' }, [c2.sha], 'c3');
  const sibling = makeCommit(repo, { 'z.txt': 'z\n' }, [c1.sha], 'sibling');
  const all = [...c1.objects, ...c2.objects, ...c3.objects];
  let answer = reportOf(await post(repo, 'git-receive-pack', pushBody([[ZERO, c3.sha, 'refs/heads/main']], writePack(all.map((o) => ({ type: o.type, body: o.body }))))));
  assert.deepEqual(answer, ['unpack ok', 'ok refs/heads/main']);
  assert.equal(resolveRef(repo, 'main'), c3.sha);
  assert.ok(isAncestor(repo, c1.sha, c3.sha));

  const refs = readPackets(await post(repo, 'git-upload-pack', lsRefsBody(['peel', 'symrefs', 'ref-prefix refs/heads/', 'ref-prefix HEAD']), true)).packets.map(lineOf);
  assert.deepEqual(refs.filter(Boolean), [`${c3.sha} HEAD symref-target:refs/heads/main`, `${c3.sha} refs/heads/main`]);

  // full fetch carries every object; an incremental one only the new ones
  const full = readPack(packOf(await post(repo, 'git-upload-pack', fetchBody([`want ${c3.sha}`, 'done']), true)), () => undefined);
  assert.equal(full.length, new Set(all.map((o) => hashRaw(o.type, o.body))).size);
  const incremental = readPack(packOf(await post(repo, 'git-upload-pack', fetchBody([`want ${c3.sha}`, `have ${c2.sha}`, 'done']), true)), () => undefined);
  assert.deepEqual(new Set(incremental.map((o) => o.sha)), new Set([c3.sha, hashRaw('tree', c3.objects.find((o) => o.type === 'tree')!.body), hashRaw('blob', text('three\n'))]));

  // negotiation without done answers acknowledgments
  const ack = readPackets(await post(repo, 'git-upload-pack', fetchBody([`want ${c3.sha}`, `have ${c1.sha}`]), true)).packets.map(lineOf);
  assert.deepEqual(ack.slice(0, 3), ['acknowledgments', `ACK ${c1.sha}`, 'ready']);
  const nak = readPackets(await post(repo, 'git-upload-pack', fetchBody([`want ${c3.sha}`, `have ${'1'.repeat(40)}`]), true)).packets.map(lineOf);
  assert.deepEqual(nak.filter(Boolean), ['acknowledgments', 'NAK']);

  // shallow
  const shallow = readPackets(await post(repo, 'git-upload-pack', fetchBody([`want ${c3.sha}`, 'deepen 1', 'done']), true)).packets.map(lineOf);
  assert.deepEqual(shallow.slice(0, 2), ['shallow-info', `shallow ${c3.sha}`]);
  const deepened = await post(repo, 'git-upload-pack', fetchBody([`want ${c3.sha}`, `shallow ${c3.sha}`, `have ${c3.sha}`, 'deepen 2', 'done']), true);
  assert.ok(readPackets(deepened).packets.map(lineOf).includes(`unshallow ${c3.sha}`));
  assert.deepEqual(readPack(packOf(deepened), () => undefined).filter((o) => o.type === 'commit').map((o) => o.sha), [c2.sha]);

  // a sibling of c1 is not a fast-forward of main; main stays
  const refused = reportOf(await post(repo, 'git-receive-pack', pushBody([[c3.sha, sibling.sha, 'refs/heads/main'], [ZERO, sibling.sha, 'refs/heads/side']], writePack(sibling.objects))));
  assert.deepEqual(refused, ['unpack ok', 'ng refs/heads/main non-fast-forward', 'ok refs/heads/side']);
  assert.equal(resolveRef(repo, 'main'), c3.sha);
  assert.equal(resolveRef(repo, 'side'), sibling.sha);

  // stale old id, unknown object, funny ref, deleting HEAD's branch, then a real delete
  answer = reportOf(await post(repo, 'git-receive-pack', pushBody([
    [c1.sha, c3.sha, 'refs/heads/side'],
    [ZERO, '2'.repeat(40), 'refs/heads/ghost'],
    [ZERO, c3.sha, 'refs/heads/bad..name'],
    [c3.sha, ZERO, 'refs/heads/main'],
  ], writePack([]))));
  assert.deepEqual(answer, [
    'unpack ok',
    'ng refs/heads/side stale info',
    'ng refs/heads/ghost missing necessary objects',
    'ng refs/heads/bad..name funny refname',
    'ng refs/heads/main deletion of the current branch prohibited',
  ]);
  answer = reportOf(await post(repo, 'git-receive-pack', pushBody([[sibling.sha, ZERO, 'refs/heads/side']], null)));
  assert.deepEqual(answer, ['unpack ok', 'ok refs/heads/side']);
  assert.equal(resolveRef(repo, 'side'), undefined);
});

test('v0 advertisement, v0 fetch and a bad pack', async () => {
  const repo = freshRepo();
  const empty = await fetch(`${base}/${repo.owner.login}/${repo.name}.git/info/refs?service=git-upload-pack`);
  const emptyLines = readPackets(Buffer.from(await empty.arrayBuffer())).packets.map(lineOf);
  assert.equal(emptyLines[0], '# service=git-upload-pack');
  assert.match(emptyLines[2], /^0{40} capabilities\^\{\}\0.*side-band-64k/);
  const c1 = makeCommit(repo, { 'a.txt': 'one\n' }, [], 'c1');
  const pushed = reportOf(await post(repo, 'git-receive-pack', pushBody([[ZERO, c1.sha, 'refs/heads/main']], writePack(c1.objects))));
  assert.deepEqual(pushed, ['unpack ok', 'ok refs/heads/main']);
  const advert = await fetch(`${base}/${repo.owner.login}/${repo.name}.git/info/refs?service=git-upload-pack`);
  const lines = readPackets(Buffer.from(await advert.arrayBuffer())).packets.map(lineOf);
  assert.ok(lines[2].startsWith(`${c1.sha} HEAD\0`));
  assert.match(lines[2], /symref=HEAD:refs\/heads\/main/);
  const request = Buffer.concat([pkt(`want ${c1.sha} side-band-64k no-progress\n`), FLUSH, pkt('done\n')]);
  const answer = await post(repo, 'git-upload-pack', request);
  const packets = readPackets(answer).packets;
  assert.equal(lineOf(packets[0]), 'NAK');
  const chunks = packets.slice(1).filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.subarray(1) : Buffer.alloc(0)));
  assert.equal(readPack(Buffer.concat(chunks), () => undefined).length, c1.objects.length);

  const bad = reportOf(await post(repo, 'git-receive-pack', pushBody([[c1.sha, c1.sha, 'refs/heads/other']], Buffer.from('PACKgarbage-garbage-garbage-garbage'))));
  assert.match(bad[0], /^unpack /);
  assert.notEqual(bad[0], 'unpack ok');
  assert.equal(bad[1], 'ng refs/heads/other unpacker error');
  const malformed = await fetch(`${base}/${repo.owner.login}/${repo.name}.git/git-upload-pack`, { method: 'POST', body: 'zzzznot-a-pkt-line' });
  assert.equal(malformed.status, 400);
  const missing = await fetch(`${base}/${repo.owner.login}/nope.git/info/refs?service=git-receive-pack`);
  assert.equal(missing.status, 404);
});

function packEntryHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (code << 4) | (size & 15);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

test('packs with OFS_DELTA and REF_DELTA entries resolve (thin bases come from the repo)', async () => {
  const repo = freshRepo();
  const baseBody = text('The quick brown fox jumps over the lazy dog.\n'.repeat(2));
  const baseSha = hashRaw('blob', baseBody);
  const extra = text('And one more line.\n');
  // delta: copy the whole base, then insert `extra`
  const delta = Buffer.concat([
    Buffer.from([baseBody.length, baseBody.length + extra.length]),
    Buffer.from([0x90, baseBody.length]),
    Buffer.from([extra.length]),
    extra,
  ]);
  const target = Buffer.concat([baseBody, extra]);
  const baseEntry = Buffer.concat([packEntryHeader(3, baseBody.length), deflateSync(baseBody)]);
  const ofsEntry = Buffer.concat([packEntryHeader(6, delta.length), Buffer.from([baseEntry.length]), deflateSync(delta)]);
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(2, 8);
  const body = Buffer.concat([header, baseEntry, ofsEntry]);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const objects = readPack(pack, () => undefined);
  assert.deepEqual(new Set(objects.map((o) => o.sha)), new Set([baseSha, hashRaw('blob', target)]));

  // thin: a REF_DELTA whose base only exists in the repository
  writeObject(repo, 'blob', baseBody);
  const refEntry = Buffer.concat([packEntryHeader(7, delta.length), Buffer.from(baseSha, 'hex'), deflateSync(delta)]);
  const header1 = Buffer.from(header);
  header1.writeUInt32BE(1, 8);
  const body1 = Buffer.concat([header1, refEntry]);
  const thin = Buffer.concat([body1, createHash('sha1').update(body1).digest()]);
  assert.throws(() => readPack(thin, () => undefined));
  const resolved = readPack(thin, (sha) => repo.git.objects.get(sha));
  assert.equal(resolved[0].body.toString(), target.toString());
});

test('a delta whose copy instruction is cut short is refused, never filled with stale bytes', () => {
  // source size 1, target size 65536, then a copy op announcing an offset byte that is not there
  const delta = Buffer.from([1, 0x80, 0x80, 4, 0x81]);
  assert.throws(() => applyDelta(Buffer.from('a'), delta), PackError);
  // a well-formed delta still applies: copy the whole 3-byte base, then insert "!"
  const good = Buffer.from([3, 4, 0x90, 3, 1, 0x21]);
  assert.equal(applyDelta(Buffer.from('abc'), good).toString(), 'abc!');
});

test('a pack entry that inflates past its declared size is refused', () => {
  const body = Buffer.from('x'.repeat(64));
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  // blob (type 3) declaring 4 bytes while its zlib stream holds 64
  const entry = Buffer.concat([Buffer.from([0x34]), deflateSync(body)]);
  const unsigned = Buffer.concat([header, entry]);
  const pack = Buffer.concat([unsigned, createHash('sha1').update(unsigned).digest()]);
  assert.throws(() => readPack(pack, () => undefined), PackError);
});
