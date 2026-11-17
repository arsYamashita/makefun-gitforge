// Domain actions and GitHub JSON shapes shared by REST, GraphQL and MCP, so the three surfaces act on
// the store the same way and answer the same objects (an issue made over MCP reads back over REST
// unchanged).
//
// CONTRACT (fixed by the design; the implementation may add exports but must keep these signatures).
// Every action throws HttpError (src/http.ts) with the REST status on a refusal: 404 unknown repo /
// issue / pull, 422 validation (unknown label, missing title, unknown branch, duplicate repo name),
// 405 a conflicted or already-merged pull request merge, 409 a stale contents sha.

import type { Comment, Issue, Label, PullRequest, Repo } from './store.ts';

/** The API origin (e.g. http://127.0.0.1:1234) used to build url fields; taken from the request's Host. */
export type Origin = string;

// ---- lookups
export declare function requireRepo(owner: string, name: string): Repo;
export declare function requireIssue(repo: Repo, number: number): Issue;
export declare function requirePull(repo: Repo, number: number): PullRequest;

// ---- actions
export declare function createRepoAction(input: { name: string; description?: string | null; private?: boolean; auto_init?: boolean; has_issues?: boolean; homepage?: string | null }): Repo;
export declare function createIssueAction(repo: Repo, input: { title: unknown; body?: unknown; labels?: unknown; assignees?: unknown }): Issue;
export declare function updateIssueAction(repo: Repo, issue: Issue, input: { title?: unknown; body?: unknown; state?: unknown; state_reason?: unknown; labels?: unknown }): Issue;
export declare function listIssuesAction(repo: Repo, input: { state?: string; sort?: string; direction?: string; labels?: string }): Issue[];
export declare function addCommentAction(repo: Repo, number: number, body: unknown): Comment;
export declare function createLabelAction(repo: Repo, input: { name: unknown; color?: unknown; description?: unknown }): Label;
export declare function createPullAction(repo: Repo, input: { title: unknown; body?: unknown; head: unknown; base?: unknown; draft?: unknown }): PullRequest;
export declare function mergePullAction(repo: Repo, pull: PullRequest, input: { commit_title?: unknown; commit_message?: unknown; merge_method?: unknown; sha?: unknown }): { sha: string; merged: true; message: string };

// ---- JSON shapes (GitHub REST v3 field names)
export declare function userJson(origin: Origin): Record<string, unknown>;
export declare function repoJson(origin: Origin, repo: Repo): Record<string, unknown>;
export declare function labelJson(origin: Origin, repo: Repo, label: Label): Record<string, unknown>;
export declare function issueJson(origin: Origin, repo: Repo, issue: Issue): Record<string, unknown>;
export declare function commentJson(origin: Origin, repo: Repo, comment: Comment): Record<string, unknown>;
export declare function pullJson(origin: Origin, repo: Repo, pull: PullRequest): Record<string, unknown>;
