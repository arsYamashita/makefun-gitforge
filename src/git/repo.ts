// Repository-level git operations the API surfaces build on: reading objects, paths and history,
// writing a commit for a contents change, diffing two commits and squash-merging a pull request.
// The smart-HTTP layer (smart.ts) and the pack codec (pack.ts) sit beside this file; REST, GraphQL and
// MCP call only the functions exported here.
//
// CONTRACT (fixed by the design; the implementation may add helpers but must keep these signatures).

import type { GitObject, GitObjectType, Repo } from '../store.ts';
import { store } from '../store.ts';
import { commitOf, hashObject, parseCommit, parseSignature, parseTagTarget, parseTree, serializeCommit, serializeTree, treeOf } from './objects.ts';

export { hashObject, parseCommit, parseSignature, parseTree };

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  /** The raw "Name <email> <unix> <tz>" lines. */
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** ISO 8601 date. */
  readonly date: string;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

export type PathEntry =
  | { readonly kind: 'blob'; readonly sha: string; readonly mode: string; readonly data: Buffer }
  | { readonly kind: 'tree'; readonly sha: string; readonly entries: readonly TreeEntry[] };

export interface FileDiff {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
  readonly patch: string;
}

export function readObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.git.objects.get(sha);
}

export function writeObject(repo: Repo, type: GitObjectType, body: Buffer): string {
  const sha = hashObject(type, body);
  if (!repo.git.objects.has(sha)) repo.git.objects.set(sha, { type, body });
  return sha;
}

/** Follow annotated tags down to the object they finally name. */
export function peelObject(repo: Repo, sha: string): string | undefined {
  let current = sha;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.git.objects.get(current);
    if (object === undefined) return undefined;
    if (object.type !== 'tag') return current;
    current = parseTagTarget(object.body).object;
  }
  return undefined;
}

function peelToCommit(repo: Repo, sha: string): string | undefined {
  const peeled = peelObject(repo, sha);
  if (peeled === undefined) return undefined;
  return repo.git.objects.get(peeled)?.type === 'commit' ? peeled : undefined;
}

export function resolveRef(repo: Repo, ref: string): string | undefined {
  const git = repo.git;
  let sha: string | undefined;
  if (ref === 'HEAD') sha = git.refs.get(git.head);
  else if (ref.startsWith('refs/')) sha = git.refs.get(ref);
  sha ??= git.refs.get(`refs/heads/${ref}`) ?? git.refs.get(`refs/tags/${ref}`);
  if (sha === undefined && /^[0-9a-f]{4,40}$/.test(ref)) {
    if (ref.length === 40) sha = ref;
    else {
      const matches: string[] = [];
      for (const [candidate, object] of git.objects) {
        if (object.type === 'commit' && candidate.startsWith(ref)) matches.push(candidate);
        if (matches.length > 1) break;
      }
      if (matches.length === 1) sha = matches[0];
    }
  }
  if (sha === undefined) return undefined;
  return peelToCommit(repo, sha);
}

/** Set or delete (sha null) a ref. A bare name is a branch. */
export function updateRef(repo: Repo, ref: string, sha: string | null): void {
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  if (sha === null) repo.git.refs.delete(full);
  else repo.git.refs.set(full, sha);
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const branches: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.git.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice(11), sha });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return branches;
}

function treeEntries(repo: Repo, sha: string): readonly TreeEntry[] | undefined {
  const object = repo.git.objects.get(sha);
  return object?.type === 'tree' ? treeOf(object) : undefined;
}

function commitInfo(repo: Repo, sha: string): CommitInfo | undefined {
  const object = repo.git.objects.get(sha);
  return object?.type === 'commit' ? commitOf(object) : undefined;
}

export function readPath(repo: Repo, commitSha: string, path: string): PathEntry | undefined {
  const info = commitInfo(repo, commitSha);
  if (info === undefined) return undefined;
  const segments = path.split('/').filter((segment) => segment !== '');
  let sha = info.tree;
  let mode = '40000';
  for (const segment of segments) {
    const entries = treeEntries(repo, sha);
    if (entries === undefined) return undefined;
    const entry = entries.find((candidate) => candidate.name === segment);
    if (entry === undefined) return undefined;
    sha = entry.sha;
    mode = entry.mode;
  }
  const object = repo.git.objects.get(sha);
  if (object === undefined) return undefined;
  if (object.type === 'tree') return { kind: 'tree', sha, entries: treeOf(object) };
  if (object.type === 'blob') return { kind: 'blob', sha, mode, data: object.body };
  return undefined;
}

function putEntry(entries: TreeEntry[], entry: TreeEntry): void {
  const at = entries.findIndex((candidate) => candidate.name === entry.name);
  if (at < 0) entries.push(entry);
  else entries[at] = entry;
}

/** Rewrite the tree at `treeSha` with the file at `segments` set to `content` (or removed when null). */
function setPath(
  repo: Repo,
  treeSha: string | undefined,
  segments: readonly string[],
  content: Buffer | null,
): { sha: string | undefined; blobSha: string | null } {
  const entries = treeSha === undefined ? [] : [...(treeEntries(repo, treeSha) ?? [])];
  const name = segments[0];
  const at = entries.findIndex((entry) => entry.name === name);
  const existing = at < 0 ? undefined : entries[at];
  let blobSha: string | null = null;
  if (segments.length === 1) {
    if (content === null) {
      if (at >= 0) entries.splice(at, 1);
    } else {
      blobSha = writeObject(repo, 'blob', content);
      putEntry(entries, { mode: existing !== undefined && existing.mode !== '40000' ? existing.mode : '100644', name, sha: blobSha });
    }
  } else {
    const child = existing !== undefined && existing.mode === '40000' ? existing.sha : undefined;
    const result = setPath(repo, child, segments.slice(1), content);
    blobSha = result.blobSha;
    if (result.sha === undefined) {
      if (at >= 0) entries.splice(at, 1);
    } else {
      putEntry(entries, { mode: '40000', name, sha: result.sha });
    }
  }
  if (entries.length === 0) return { sha: undefined, blobSha };
  return { sha: writeObject(repo, 'tree', serializeTree(entries)), blobSha };
}

function identity(): string {
  const viewer = store.viewer;
  return `${viewer.name} <${viewer.email}> ${store.gitTime()}`;
}

function withNewline(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`;
}

export function commitChange(
  repo: Repo,
  input: { branch: string; path: string; content: Buffer | null; message: string },
): { commitSha: string; blobSha: string | null } {
  // API branch names are bare: `refs/topic` is the branch refs/heads/refs/topic.
  const ref = `refs/heads/${input.branch}`;
  const parent = repo.git.refs.get(ref);
  const parentInfo = parent === undefined ? undefined : commitInfo(repo, parent);
  const segments = input.path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new Error('commitChange needs a file path');
  const result = setPath(repo, parentInfo?.tree, segments, input.content);
  const tree = result.sha ?? writeObject(repo, 'tree', Buffer.alloc(0));
  const who = identity();
  const commitSha = writeObject(
    repo,
    'commit',
    serializeCommit({ tree, parents: parent === undefined ? [] : [parent], author: who, committer: who, message: withNewline(input.message) }),
  );
  repo.git.refs.set(ref, commitSha);
  return { commitSha, blobSha: result.blobSha };
}

export function listCommits(repo: Repo, start: string, limit: number): Array<{ sha: string; info: CommitInfo }> {
  const out: Array<{ sha: string; info: CommitInfo }> = [];
  const seen = new Set<string>([start]);
  const time = (info: CommitInfo): number => Number(/(\d+)\s+[+-]\d{4}\s*$/.exec(info.committer)?.[1] ?? 0);
  let frontier: Array<{ sha: string; info: CommitInfo }> = [];
  const first = commitInfo(repo, start);
  if (first !== undefined) frontier.push({ sha: start, info: first });
  while (frontier.length > 0 && out.length < limit) {
    let best = 0;
    for (let i = 1; i < frontier.length; i += 1) if (time(frontier[i].info) > time(frontier[best].info)) best = i;
    const [picked] = frontier.splice(best, 1);
    out.push(picked);
    for (const parent of picked.info.parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const info = commitInfo(repo, parent);
      if (info !== undefined) frontier.push({ sha: parent, info });
    }
  }
  return out;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const info = commitInfo(repo, queue[head]);
    if (info === undefined) continue;
    for (const parent of info.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  if (a === b) return a;
  const ancestorsOfA = new Set<string>([a]);
  const stack = [a];
  while (stack.length > 0) {
    const info = commitInfo(repo, stack.pop()!);
    if (info === undefined) continue;
    for (const parent of info.parents) {
      if (!ancestorsOfA.has(parent)) {
        ancestorsOfA.add(parent);
        stack.push(parent);
      }
    }
  }
  const seen = new Set<string>([b]);
  const queue = [b];
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head];
    if (ancestorsOfA.has(sha)) return sha;
    const info = commitInfo(repo, sha);
    if (info === undefined) continue;
    for (const parent of info.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------

interface FileRef {
  readonly sha: string;
  readonly mode: string;
}

function collectFiles(repo: Repo, treeSha: string | undefined, prefix: string, into: Map<string, FileRef>): void {
  if (treeSha === undefined) return;
  for (const entry of treeEntries(repo, treeSha) ?? []) {
    if (entry.mode === '40000') collectFiles(repo, entry.sha, `${prefix}${entry.name}/`, into);
    else if (entry.mode !== '160000') into.set(`${prefix}${entry.name}`, { sha: entry.sha, mode: entry.mode });
  }
}

function diffTrees(repo: Repo, a: string | undefined, b: string | undefined, prefix: string, left: Map<string, FileRef>, right: Map<string, FileRef>): void {
  if (a === b) return;
  const aEntries = new Map((a === undefined ? [] : (treeEntries(repo, a) ?? [])).map((entry) => [entry.name, entry]));
  const bEntries = new Map((b === undefined ? [] : (treeEntries(repo, b) ?? [])).map((entry) => [entry.name, entry]));
  for (const name of new Set([...aEntries.keys(), ...bEntries.keys()])) {
    const ea = aEntries.get(name);
    const eb = bEntries.get(name);
    if (ea !== undefined && eb !== undefined && ea.sha === eb.sha && ea.mode === eb.mode) continue;
    const path = `${prefix}${name}`;
    const aDir = ea !== undefined && ea.mode === '40000';
    const bDir = eb !== undefined && eb.mode === '40000';
    if (aDir && bDir) {
      diffTrees(repo, ea.sha, eb.sha, `${path}/`, left, right);
      continue;
    }
    if (ea !== undefined) {
      if (aDir) collectFiles(repo, ea.sha, `${path}/`, left);
      else if (ea.mode !== '160000') left.set(path, { sha: ea.sha, mode: ea.mode });
    }
    if (eb !== undefined) {
      if (bDir) collectFiles(repo, eb.sha, `${path}/`, right);
      else if (eb.mode !== '160000') right.set(path, { sha: eb.sha, mode: eb.mode });
    }
  }
}

const NO_EOL = '\u0000noeol';

function splitLines(body: Buffer): string[] {
  const text = body.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

type Op = { kind: 'eq' | 'del' | 'ins'; a: number; b: number };

/** Myers' O(ND) line diff; null when the files differ too much to bother. */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 3);
  const snaps: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(maxD, n + m); d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) found = d;
    }
    snaps.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const k = x - y;
    const prev = snaps[d - 1];
    const at = (kk: number): number => prev[kk + d - 1];
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'eq', a: x, b: y });
    }
    if (x === prevX) {
      y -= 1;
      ops.push({ kind: 'ins', a: x, b: y });
    } else {
      x -= 1;
      ops.push({ kind: 'del', a: x, b: y });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: 'eq', a: x, b: y });
  }
  return ops.reverse();
}

function lineDiff(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), 1500);
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: 'eq', a: i, b: i });
  if (middle === null) {
    for (let i = start; i < endA; i += 1) ops.push({ kind: 'del', a: i, b: start });
    for (let j = start; j < endB; j += 1) ops.push({ kind: 'ins', a: endA, b: j });
  } else {
    for (const op of middle) ops.push({ kind: op.kind, a: op.a + start, b: op.b + start });
  }
  for (let i = 0; i < a.length - endA; i += 1) ops.push({ kind: 'eq', a: endA + i, b: endB + i });
  return ops;
}

function render(line: string): string[] {
  return line.endsWith(NO_EOL) ? [line.slice(0, -NO_EOL.length), '\\ No newline at end of file'] : [line];
}

function unifiedPatch(a: string[], b: string[]): { patch: string; additions: number; deletions: number } {
  const ops = lineDiff(a, b);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === 'ins') additions += 1;
    else if (op.kind === 'del') deletions += 1;
  }
  const context = 3;
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== 'eq') changed.push(index);
  });
  const out: string[] = [];
  let i = 0;
  while (i < changed.length) {
    let last = i;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * context + 1) last += 1;
    const from = Math.max(0, changed[i] - context);
    const to = Math.min(ops.length - 1, changed[last] + context);
    const body: string[] = [];
    let aLen = 0;
    let bLen = 0;
    let aStart = -1;
    let bStart = -1;
    for (let index = from; index <= to; index += 1) {
      const op = ops[index];
      if (op.kind !== 'ins' && aStart < 0) aStart = op.a;
      if (op.kind !== 'del' && bStart < 0) bStart = op.b;
      if (op.kind === 'eq') {
        body.push(...render(a[op.a]).map((text, n) => (n === 0 ? ` ${text}` : text)));
        aLen += 1;
        bLen += 1;
      } else if (op.kind === 'del') {
        body.push(...render(a[op.a]).map((text, n) => (n === 0 ? `-${text}` : text)));
        aLen += 1;
      } else {
        body.push(...render(b[op.b]).map((text, n) => (n === 0 ? `+${text}` : text)));
        bLen += 1;
      }
    }
    const first = ops[from];
    const aFirst = aLen === 0 ? (first.kind === 'ins' ? first.a : first.a) : aStart + 1;
    const bFirst = bLen === 0 ? first.b : bStart + 1;
    const range = (start: number, len: number): string => (len === 1 ? `${start}` : `${start},${len}`);
    out.push(`@@ -${range(aFirst, aLen)} +${range(bFirst, bLen)} @@`, ...body);
    i = last + 1;
  }
  return { patch: out.join('\n'), additions, deletions };
}

function isBinary(body: Buffer): boolean {
  return body.subarray(0, 8000).includes(0);
}

export function diffCommits(repo: Repo, baseSha: string, headSha: string): FileDiff[] {
  const base = commitInfo(repo, baseSha);
  const head = commitInfo(repo, headSha);
  const left = new Map<string, FileRef>();
  const right = new Map<string, FileRef>();
  diffTrees(repo, base?.tree, head?.tree, '', left, right);
  const empty = Buffer.alloc(0);
  const files: FileDiff[] = [];
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    const before = left.get(path);
    const after = right.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) {
      files.push({ filename: path, status: 'modified', additions: 0, deletions: 0, changes: 0, sha: after.sha, patch: '' });
      continue;
    }
    const beforeBody = before === undefined ? empty : (repo.git.objects.get(before.sha)?.body ?? empty);
    const afterBody = after === undefined ? empty : (repo.git.objects.get(after.sha)?.body ?? empty);
    let patch = '';
    let additions = 0;
    let deletions = 0;
    if (!isBinary(beforeBody) && !isBinary(afterBody)) {
      const result = unifiedPatch(splitLines(beforeBody), splitLines(afterBody));
      patch = result.patch;
      additions = result.additions;
      deletions = result.deletions;
    }
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: (after ?? before)!.sha,
      patch,
    });
  }
  files.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return files;
}

// ---------------------------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------------------------

const CONFLICT = Symbol('conflict');

/**
 * Three-way merge of trees at path level. Returns the merged tree id, undefined for an empty result,
 * or CONFLICT. With `write` false nothing is stored (the ids returned are placeholders).
 */
function merge3(repo: Repo, base: string | undefined, ours: string | undefined, theirs: string | undefined, write: boolean): string | undefined | typeof CONFLICT {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const index = (sha: string | undefined): Map<string, TreeEntry> =>
    new Map((sha === undefined ? [] : (treeEntries(repo, sha) ?? [])).map((entry) => [entry.name, entry]));
  const b = index(base);
  const o = index(ours);
  const t = index(theirs);
  const merged: TreeEntry[] = [];
  for (const name of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const eb = b.get(name);
    const eo = o.get(name);
    const et = t.get(name);
    const same = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean => x?.sha === y?.sha && x?.mode === y?.mode;
    let pick: TreeEntry | undefined;
    if (same(eo, et)) pick = eo;
    else if (same(eb, eo)) pick = et;
    else if (same(eb, et)) pick = eo;
    else if (eo !== undefined && et !== undefined && eo.mode === '40000' && et.mode === '40000') {
      const sub = merge3(repo, eb !== undefined && eb.mode === '40000' ? eb.sha : undefined, eo.sha, et.sha, write);
      if (sub === CONFLICT) return CONFLICT;
      pick = sub === undefined ? undefined : { mode: '40000', name, sha: sub };
    } else return CONFLICT;
    if (pick !== undefined) merged.push(pick);
  }
  if (merged.length === 0) return undefined;
  return write ? writeObject(repo, 'tree', serializeTree(merged)) : 'dry-run';
}

function mergeTrees(repo: Repo, baseBranch: string, headSha: string, write: boolean): { tree: string | undefined; tip: string | undefined } | typeof CONFLICT {
  const tip = resolveRef(repo, `refs/heads/${baseBranch}`);
  const head = commitInfo(repo, headSha);
  if (head === undefined) return CONFLICT;
  if (tip === undefined) return { tree: head.tree, tip: undefined };
  const ours = commitInfo(repo, tip)!;
  const baseSha = mergeBase(repo, tip, headSha);
  const base = baseSha === undefined ? undefined : commitInfo(repo, baseSha);
  const tree = merge3(repo, base?.tree, ours.tree, head.tree, write);
  if (tree === CONFLICT) return CONFLICT;
  return { tree, tip };
}

export function squashMerge(
  repo: Repo,
  input: { baseBranch: string; headSha: string; message: string },
): { ok: true; sha: string } | { ok: false; conflict: true } {
  const merged = mergeTrees(repo, input.baseBranch, input.headSha, true);
  if (merged === CONFLICT) return { ok: false, conflict: true };
  const tree = merged.tree ?? writeObject(repo, 'tree', Buffer.alloc(0));
  const who = identity();
  const sha = writeObject(
    repo,
    'commit',
    serializeCommit({ tree, parents: merged.tip === undefined ? [] : [merged.tip], author: who, committer: who, message: withNewline(input.message) }),
  );
  repo.git.refs.set(`refs/heads/${input.baseBranch}`, sha);
  return { ok: true, sha };
}

export function mergeable(repo: Repo, baseBranch: string, headSha: string): boolean {
  return mergeTrees(repo, baseBranch, headSha, false) !== CONFLICT;
}
