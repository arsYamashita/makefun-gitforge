// Repository-level git operations the API surfaces build on: reading objects, paths and history,
// writing a commit for a contents change, diffing two commits and squash-merging a pull request.
// The smart-HTTP layer (smart.ts) and the pack codec (pack.ts) sit beside this file; REST, GraphQL and
// MCP call only the functions exported here.
//
// CONTRACT (fixed by the design; the implementation may add helpers but must keep these signatures).

import type { GitObject, GitObjectType, Repo } from '../store.ts';

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

export declare function hashObject(type: GitObjectType, body: Buffer): string;
export declare function readObject(repo: Repo, sha: string): GitObject | undefined;
export declare function writeObject(repo: Repo, type: GitObjectType, body: Buffer): string;
export declare function parseCommit(body: Buffer): CommitInfo;
export declare function parseSignature(line: string): Signature;
export declare function parseTree(body: Buffer): TreeEntry[];
/** A branch name, a full ref, "HEAD" or a (full) commit id to a commit id; undefined when unknown. */
export declare function resolveRef(repo: Repo, ref: string): string | undefined;
/** Set or delete (sha null) a ref. */
export declare function updateRef(repo: Repo, ref: string, sha: string | null): void;
/** Branch names (without refs/heads/) to tip ids, sorted by name. */
export declare function listBranches(repo: Repo): Array<{ name: string; sha: string }>;
/** The object at `path` ('' = the root tree) in a commit, or undefined. */
export declare function readPath(repo: Repo, commitSha: string, path: string): PathEntry | undefined;
/**
 * Write one file (content Buffer) or delete it (content null) on `branch` as a new commit whose parent
 * is the branch tip (no parent when the branch is unborn), and move the branch. Returns the new commit
 * id and the file's blob id (null on delete).
 */
export declare function commitChange(
  repo: Repo,
  input: { branch: string; path: string; content: Buffer | null; message: string },
): { commitSha: string; blobSha: string | null };
/** History from `start`, newest first (first-parent order is fine), at most `limit`. */
export declare function listCommits(repo: Repo, start: string, limit: number): Array<{ sha: string; info: CommitInfo }>;
export declare function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean;
export declare function mergeBase(repo: Repo, a: string, b: string): string | undefined;
/** The files changed from `baseSha` to `headSha` (tree diff), sorted by path. */
export declare function diffCommits(repo: Repo, baseSha: string, headSha: string): FileDiff[];
/**
 * Squash-merge head into the base branch: a three-way merge of the trees at path level from their
 * merge base. A path changed differently on both sides is a conflict. On success writes one commit
 * whose parent is the base tip and moves the base branch.
 */
export declare function squashMerge(
  repo: Repo,
  input: { baseBranch: string; headSha: string; message: string },
): { ok: true; sha: string } | { ok: false; conflict: true };
/** Whether squashMerge would succeed (no conflict), without writing anything. */
export declare function mergeable(repo: Repo, baseBranch: string, headSha: string): boolean;
