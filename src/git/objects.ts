// Low-level git object helpers: hashing, parsing and serialising commits, trees and tags.
// Everything here is pure (no store access) so the pack codec and the repository layer can share it.

import { createHash } from 'node:crypto';
import type { GitObject, GitObjectType } from '../store.ts';
import type { CommitInfo, Signature, TreeEntry } from './repo.ts';

export const ZERO_SHA = '0'.repeat(40);

export function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\0`);
  hash.update(body);
  return hash.digest('hex');
}

const commitCache = new WeakMap<GitObject, CommitInfo>();
const treeCache = new WeakMap<GitObject, TreeEntry[]>();

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** parseCommit with a per-object cache (objects are immutable once stored). */
export function commitOf(object: GitObject): CommitInfo {
  let info = commitCache.get(object);
  if (info === undefined) {
    info = parseCommit(object.body);
    commitCache.set(object, info);
  }
  return info;
}

export function parseSignature(line: string): Signature {
  const match = /^(.*?)\s*<([^>]*)>\s*(\d+)?\s*([+-]\d{4})?\s*$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  return {
    name: match[1],
    email: match[2],
    date: new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    const nul = space < 0 ? -1 : body.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > body.length) break;
    entries.push({
      mode: body.toString('latin1', pos, space),
      name: body.toString('utf8', space + 1, nul),
      sha: body.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

export function treeOf(object: GitObject): TreeEntry[] {
  let entries = treeCache.get(object);
  if (entries === undefined) {
    entries = parseTree(object.body);
    treeCache.set(object, entries);
  }
  return entries;
}

function sortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Serialise tree entries in git's order (a directory sorts as if its name ended in "/"). */
export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const keyed = entries.map((entry) => ({ entry, key: sortKey(entry) }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Buffer[] = [];
  for (const { entry } of keyed) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function serializeCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let text = `tree ${input.tree}\n`;
  for (const parent of input.parents) text += `parent ${parent}\n`;
  text += `author ${input.author}\ncommitter ${input.committer}\n\n${input.message}`;
  return Buffer.from(text, 'utf8');
}

/** The target an annotated tag points at. */
export function parseTagTarget(body: Buffer): { object: string; type: string } {
  const text = body.toString('utf8');
  const head = text.split('\n\n', 1)[0];
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
  }
  return { object, type };
}
