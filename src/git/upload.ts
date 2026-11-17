// Object selection for upload-pack: which objects a fetch must carry, including shallow and
// deepen handling. The wire formats (v0 and v2) live in smart.ts.

import type { GitObject, Repo } from '../store.ts';
import { commitOf, parseTagTarget, treeOf } from './objects.ts';

export interface FetchParams {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  /** Commits the client already holds as shallow boundaries. */
  readonly clientShallow: readonly string[];
  readonly deepen?: number;
  readonly deepenSince?: number;
  /** Commits (already resolved) that mark where history must stop. */
  readonly deepenNot?: readonly string[];
}

export interface FetchPlan {
  readonly objects: GitObject[];
  /** New shallow boundaries to announce (only when a depth was requested). */
  readonly shallow: string[];
  readonly unshallow: string[];
  /** The haves the server recognised, in request order. */
  readonly common: string[];
}

export class FetchError extends Error {}

function committerTime(object: GitObject): number {
  return Number(/(\d+)\s+[+-]\d{4}\s*$/.exec(commitOf(object).committer)?.[1] ?? 0);
}

/** Add `treeSha` and everything below it to `into`, skipping what `skip` or `into` already hold. */
function addTree(repo: Repo, treeSha: string, into: Set<string>, order: string[] | null, skip: ReadonlySet<string> | null): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (into.has(sha) || (skip !== null && skip.has(sha))) continue;
    const tree = repo.git.objects.get(sha);
    if (tree === undefined || tree.type !== 'tree') continue;
    into.add(sha);
    order?.push(sha);
    for (const entry of treeOf(tree)) {
      if (entry.mode === '160000') continue;
      if (entry.mode === '40000') stack.push(entry.sha);
      else if (!into.has(entry.sha) && (skip === null || !skip.has(entry.sha)) && repo.git.objects.has(entry.sha)) {
        into.add(entry.sha);
        order?.push(entry.sha);
      }
    }
  }
}

export function planFetch(repo: Repo, params: FetchParams): FetchPlan {
  const objects = repo.git.objects;
  const extra: GitObject[] = [];
  const extraSeen = new Set<string>();
  const wantCommits: string[] = [];
  const wantTrees: string[] = [];
  for (const want of params.wants) {
    let sha = want;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = objects.get(sha);
      if (object === undefined) throw new FetchError(`upload-pack: not our ref ${want}`);
      if (object.type === 'tag') {
        if (!extraSeen.has(sha)) {
          extraSeen.add(sha);
          extra.push(object);
        }
        sha = parseTagTarget(object.body).object;
        continue;
      }
      if (object.type === 'commit') wantCommits.push(sha);
      else if (object.type === 'tree') wantTrees.push(sha);
      else if (!extraSeen.has(sha)) {
        extraSeen.add(sha);
        extra.push(object);
      }
      break;
    }
  }

  const common: string[] = [];
  const haveCommits: string[] = [];
  for (const have of new Set(params.haves)) {
    const object = objects.get(have);
    if (object === undefined) continue;
    common.push(have);
    if (object.type === 'commit') haveCommits.push(have);
  }

  const shallowSet = new Set(params.clientShallow);
  // Everything the client holds: the haves and their ancestors, cut at the client's shallow commits.
  const closure = new Set<string>();
  const stack = [...haveCommits];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (closure.has(sha)) continue;
    closure.add(sha);
    if (shallowSet.has(sha)) continue;
    const object = objects.get(sha);
    if (object === undefined) continue;
    for (const parent of commitOf(object).parents) if (!closure.has(parent)) stack.push(parent);
  }

  const depthRequested = params.deepen !== undefined || params.deepenSince !== undefined || (params.deepenNot?.length ?? 0) > 0;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const candidates: string[] = [];
  if (depthRequested) {
    const stop = new Set(params.deepenNot ?? []);
    const depth = new Map<string, number>();
    let level = [...new Set(wantCommits)];
    for (const sha of level) depth.set(sha, 1);
    while (level.length > 0) {
      const nextLevel: string[] = [];
      for (const sha of level) {
        const object = objects.get(sha)!;
        const d = depth.get(sha)!;
        candidates.push(sha);
        const parents = commitOf(object).parents.filter((parent) => objects.has(parent));
        let cut = parents.length === 0 ? false : params.deepen !== undefined && d >= params.deepen;
        const followed: string[] = [];
        for (const parent of parents) {
          const parentObject = objects.get(parent)!;
          if (stop.has(parent) || (params.deepenSince !== undefined && committerTime(parentObject) < params.deepenSince)) {
            cut = true;
            continue;
          }
          followed.push(parent);
        }
        if (cut) {
          shallow.push(sha);
          continue;
        }
        if (shallowSet.has(sha) && parents.length > 0) unshallow.push(sha);
        for (const parent of followed) {
          if (!depth.has(parent)) {
            depth.set(parent, d + 1);
            nextLevel.push(parent);
          }
        }
      }
      level = nextLevel;
    }
  } else {
    const seen = new Set<string>();
    const walk = [...new Set(wantCommits)].reverse();
    while (walk.length > 0) {
      const sha = walk.pop()!;
      if (seen.has(sha) || closure.has(sha)) continue;
      seen.add(sha);
      candidates.push(sha);
      if (shallowSet.has(sha)) continue;
      const object = objects.get(sha);
      if (object === undefined) continue;
      const parents = commitOf(object).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) walk.push(parents[i]);
    }
  }
  const send = candidates.filter((sha) => !closure.has(sha));

  // Trees the client is known to hold: those of the haves and of the commits our commits sit on.
  const edges = new Set<string>(haveCommits);
  for (const sha of send) {
    for (const parent of commitOf(objects.get(sha)!).parents) if (closure.has(parent)) edges.add(parent);
  }
  const excluded = new Set<string>();
  for (const sha of edges) {
    const object = objects.get(sha);
    if (object !== undefined) addTree(repo, commitOf(object).tree, excluded, null, null);
  }

  const out: GitObject[] = [...extra];
  const seenObjects = new Set<string>(extraSeen);
  for (const sha of send) out.push(objects.get(sha)!);
  const bodies: string[] = [];
  const included = new Set<string>();
  for (const sha of send) addTree(repo, commitOf(objects.get(sha)!).tree, included, bodies, excluded);
  for (const sha of wantTrees) addTree(repo, sha, included, bodies, excluded);
  for (const sha of bodies) {
    if (!seenObjects.has(sha)) out.push(objects.get(sha)!);
  }
  return { objects: out, shallow, unshallow, common };
}
