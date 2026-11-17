// receive-pack: unpack the pushed objects, then apply each ref command on its own.

import { gunzipSync } from 'node:zlib';
import type { Repo } from '../store.ts';
import { store } from '../store.ts';
import { HttpError, MAX_BODY_BYTES } from '../http.ts';
import { ZERO_SHA, commitOf, isSha, parseTagTarget, treeOf } from './objects.ts';
import { PackError, readPack } from './pack.ts';
import { FLUSH, lineOf, pkt, readPackets, sideband } from './pktline.ts';
import { isAncestor, peelObject } from './repo.ts';

interface Command {
  readonly oldSha: string;
  readonly newSha: string;
  readonly ref: string;
}

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 250) return false;
  if (/[\u0000- \u007f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  return !ref.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'));
}

/** Handle one receive-pack request body and return the response body. */
export function receivePack(repo: Repo, rawBody: Buffer, gzipped: boolean): Buffer {
  let body = rawBody;
  if (gzipped) {
    try {
      body = gunzipSync(rawBody, { maxOutputLength: MAX_BODY_BYTES });
    } catch {
      throw new HttpError(400, 'bad gzip body');
    }
  }
  const { packets, next } = readPackets(body, 0, true);
  const commands: Command[] = [];
  let capabilities: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    if (line.startsWith('shallow ') || line.startsWith('push-cert')) continue;
    const parts = line.split(' ');
    if (parts.length < 3 || !isSha(parts[0]) || !isSha(parts[1])) throw new HttpError(400, 'malformed command');
    commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) return Buffer.alloc(0);

  const pack = body.subarray(next);
  const lines: string[] = [];
  let unpackError: string | null = null;
  let incomplete = false;
  if (pack.length > 0) {
    const fresh: string[] = [];
    try {
      for (const object of readPack(Buffer.from(pack), (sha) => repo.git.objects.get(sha))) {
        if (!repo.git.objects.has(object.sha)) {
          repo.git.objects.set(object.sha, { type: object.type, body: object.body });
          fresh.push(object.sha);
        }
      }
    } catch (err) {
      unpackError = err instanceof PackError ? err.message : 'unpack failed';
    }
    // Only the objects this push added need checking; stored ones were checked when they arrived.
    if (unpackError === null && !isConnected(repo, fresh)) {
      incomplete = true;
      for (const sha of fresh) repo.git.objects.delete(sha);
    }
  }
  lines.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);

  const refCounts = new Map<string, number>();
  for (const command of commands) refCounts.set(command.ref, (refCounts.get(command.ref) ?? 0) + 1);

  let changed = false;
  for (const command of commands) {
    let verdict: string | null;
    if (unpackError !== null) verdict = 'unpacker error';
    else if ((refCounts.get(command.ref) ?? 0) > 1) verdict = 'duplicate ref';
    else if (incomplete && command.newSha !== ZERO_SHA) verdict = 'missing necessary objects';
    else verdict = applyCommand(repo, command);
    if (verdict === null) {
      lines.push(`ok ${command.ref}`);
      changed = true;
    } else {
      lines.push(`ng ${command.ref} ${verdict}`);
    }
  }
  if (changed) repo.pushedAt = store.now();

  const report = Buffer.concat([...lines.map((line) => pkt(`${line}\n`)), FLUSH]);
  if (!capabilities.includes('report-status') && !capabilities.includes('report-status-v2')) return Buffer.alloc(0);
  if (capabilities.includes('side-band-64k') || capabilities.includes('side-band')) {
    return Buffer.concat([...sideband(1, report), FLUSH]);
  }
  return report;
}

/** Apply one command; null on success, otherwise the reason for an "ng" line. */
function applyCommand(repo: Repo, command: Command): string | null {
  const { ref, oldSha, newSha } = command;
  const git = repo.git;
  if (!validRefName(ref)) return 'funny refname';
  const current = git.refs.get(ref);
  if (newSha === ZERO_SHA) {
    if (current === undefined) return 'does not exist';
    if (oldSha !== current) return 'stale info';
    if (ref === git.head) return 'deletion of the current branch prohibited';
    git.refs.delete(ref);
    return null;
  }
  if (oldSha === ZERO_SHA) {
    if (current !== undefined) return 'already exists';
  } else if (current !== oldSha) {
    return 'stale info';
  }
  const object = git.objects.get(newSha);
  if (object === undefined) return 'missing necessary objects';
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
  if (object.type === 'commit') {
    const info = parseCommitCached(repo, newSha);
    if (info === undefined || !git.objects.has(info.tree) || info.parents.some((parent) => !git.objects.has(parent))) {
      return 'missing necessary objects';
    }
  }
  if (current !== undefined && current !== newSha) {
    const before = peelObject(repo, current);
    const after = peelObject(repo, newSha);
    const beforeType = before === undefined ? undefined : git.objects.get(before)?.type;
    const afterType = after === undefined ? undefined : git.objects.get(after)?.type;
    if (before === undefined || after === undefined || beforeType !== 'commit' || afterType !== 'commit' || !isAncestor(repo, before, after)) {
      return 'non-fast-forward';
    }
  }
  git.refs.set(ref, newSha);
  refreshPulls(repo, ref, newSha);
  return null;
}

/** True when every object the freshly stored ones point at is present (gitlinks excepted). */
function isConnected(repo: Repo, fresh: readonly string[]): boolean {
  const objects = repo.git.objects;
  for (const sha of fresh) {
    const object = objects.get(sha);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const info = commitOf(object);
      if (!objects.has(info.tree) || info.parents.some((parent) => !objects.has(parent))) return false;
    } else if (object.type === 'tree') {
      for (const entry of treeOf(object)) {
        if (entry.mode !== '160000' && !objects.has(entry.sha)) return false;
      }
    } else if (object.type === 'tag') {
      if (!objects.has(parseTagTarget(object.body).object)) return false;
    }
  }
  return true;
}

function parseCommitCached(repo: Repo, sha: string) {
  const object = repo.git.objects.get(sha);
  return object === undefined || object.type !== 'commit' ? undefined : commitOf(object);
}

/** Keep open pull requests' recorded head and base ids in step with their branches. */
function refreshPulls(repo: Repo, ref: string, sha: string): void {
  if (!ref.startsWith('refs/heads/') || repo.pulls.size === 0) return;
  const branch = ref.slice(11);
  for (const pull of repo.pulls.values()) {
    if (pull.state !== 'open') continue;
    if (pull.head === branch) pull.headSha = sha;
    if (pull.base === branch) pull.baseSha = sha;
  }
}
