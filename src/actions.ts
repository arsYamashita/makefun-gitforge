// Domain actions and GitHub JSON shapes shared by REST, GraphQL and MCP, so the three surfaces act on
// the store the same way and answer the same objects (an issue made over MCP reads back over REST
// unchanged).
//
// Every action throws HttpError (src/http.ts) with the REST status on a refusal: 404 unknown repo /
// issue / pull, 422 validation (unknown label, missing title, unknown branch, duplicate repo name),
// 405 a conflicted or already-merged pull request merge, 409 a stale contents sha.

import * as git from './git/repo.ts';
import { HttpError } from './http.ts';
import { store } from './store.ts';
import type { Comment, Issue, Label, PullRequest, Repo, User } from './store.ts';

/** The API origin (e.g. http://127.0.0.1:1234) used to build url fields; taken from the request's Host. */
export type Origin = string;

// ---- ids

/** A stable, opaque GraphQL-style node id: base64 of "<Kind>:<id>". */
export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

// ---- errors

/** A 422 in GitHub's "Validation Failed" shape. */
export function validation(resource: string, field: string, code: string, message = 'Validation Failed'): HttpError {
  return new HttpError(422, message, { errors: [{ resource, field, code }] });
}

function notFound(): HttpError {
  return new HttpError(404, 'Not Found');
}

// ---- lookups

export function requireRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw notFound();
  return repo;
}

export function requireIssue(repo: Repo, number: number): Issue {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw notFound();
  return issue;
}

export function requirePull(repo: Repo, number: number): PullRequest {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound();
  return pull;
}

// ---- small helpers

function optionalString(value: unknown, resource: string, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw validation(resource, field, 'invalid');
  return value;
}

function nonEmptyString(value: unknown, resource: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw validation(resource, field, 'missing_field');
  return value;
}

function stringList(value: unknown, resource: string, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validation(resource, field, 'invalid');
  const out: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : undefined;
    if (name === undefined) throw validation(resource, field, 'invalid');
    out.push(name);
  }
  return out;
}

/** Label names as the repository spells them; an unknown label is a 422. */
function canonicalLabels(repo: Repo, value: unknown): string[] {
  const names = stringList(value, 'Issue', 'labels');
  const out: string[] = [];
  for (const name of names) {
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) throw validation('Issue', 'labels', 'invalid');
    if (!out.includes(label.name)) out.push(label.name);
  }
  return out;
}

function branchOf(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// ---- actions

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function createRepoAction(input: { name: unknown; description?: unknown; private?: unknown; auto_init?: unknown; has_issues?: unknown; homepage?: unknown; default_branch?: unknown }): Repo {
  const name = input.name;
  if (typeof name !== 'string' || !REPO_NAME.test(name) || name === '.' || name === '..') throw validation('Repository', 'name', 'invalid');
  if (store.getRepo(store.viewer.login, name) !== undefined) {
    throw new HttpError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
  }
  const description = typeof input.description === 'string' ? input.description : null;
  const homepage = typeof input.homepage === 'string' ? input.homepage : null;
  const defaultBranch = typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main';
  const repo = store.createRepo({ name, description, private: input.private === true, defaultBranch, homepage, hasIssues: input.has_issues !== false });
  if (input.auto_init === true) {
    git.commitChange(repo, { branch: repo.defaultBranch, path: 'README.md', content: Buffer.from(`# ${name}\n`, 'utf8'), message: 'Initial commit' });
    const at = store.now();
    repo.pushedAt = at;
    repo.updatedAt = at;
  }
  return repo;
}

/** Apply a PATCH /repos/{o}/{r} body. */
export function updateRepoAction(repo: Repo, input: Record<string, unknown>): Repo {
  if (input.name !== undefined) {
    const name = input.name;
    if (typeof name !== 'string' || !REPO_NAME.test(name)) throw validation('Repository', 'name', 'invalid');
    const clash = store.getRepo(repo.owner.login, name);
    if (clash !== undefined && clash !== repo) throw validation('Repository', 'name', 'already_exists');
    if (name !== repo.name) store.renameRepo(repo, name);
  }
  if (input.description !== undefined) repo.description = optionalString(input.description, 'Repository', 'description') ?? null;
  if (input.homepage !== undefined) repo.homepage = optionalString(input.homepage, 'Repository', 'homepage') ?? null;
  if (typeof input.private === 'boolean') repo.private = input.private;
  if (typeof input.has_issues === 'boolean') repo.hasIssues = input.has_issues;
  if (typeof input.default_branch === 'string' && input.default_branch !== '' && input.default_branch !== repo.defaultBranch) {
    if (git.resolveRef(repo, `refs/heads/${input.default_branch}`) === undefined) throw validation('Repository', 'default_branch', 'invalid');
    repo.defaultBranch = input.default_branch;
    repo.git.head = `refs/heads/${input.default_branch}`;
  }
  repo.updatedAt = store.now();
  return repo;
}

export function createIssueAction(repo: Repo, input: { title: unknown; body?: unknown; labels?: unknown; assignees?: unknown; assignee?: unknown }): Issue {
  if (!repo.hasIssues) throw new HttpError(410, 'Issues are disabled for this repo');
  const title = nonEmptyString(input.title, 'Issue', 'title');
  const body = optionalString(input.body, 'Issue', 'body') ?? null;
  const labels = canonicalLabels(repo, input.labels);
  const assignees = stringList(input.assignees, 'Issue', 'assignees');
  if (typeof input.assignee === 'string' && !assignees.includes(input.assignee)) assignees.push(input.assignee);
  return store.createIssue(repo, { title, body, labels, assignees });
}

export function updateIssueAction(repo: Repo, issue: Issue, input: { title?: unknown; body?: unknown; state?: unknown; state_reason?: unknown; labels?: unknown; assignees?: unknown }): Issue {
  if (input.title !== undefined) issue.title = nonEmptyString(input.title, 'Issue', 'title');
  if (input.body !== undefined) issue.body = optionalString(input.body, 'Issue', 'body') ?? null;
  if (input.labels !== undefined) issue.labels = canonicalLabels(repo, input.labels);
  if (input.assignees !== undefined) issue.assignees = stringList(input.assignees, 'Issue', 'assignees');
  const at = store.now();
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw validation('Issue', 'state', 'invalid');
    if (input.state === 'closed' && issue.state === 'open') {
      issue.state = 'closed';
      issue.closedAt = at;
      const reason = typeof input.state_reason === 'string' ? input.state_reason : 'completed';
      issue.stateReason = reason;
    } else if (input.state === 'open' && issue.state === 'closed') {
      issue.state = 'open';
      issue.closedAt = null;
      issue.stateReason = 'reopened';
    }
  }
  issue.updatedAt = at;
  repo.updatedAt = at;
  return issue;
}

export function listIssuesAction(repo: Repo, input: { state?: string; sort?: string; direction?: string; labels?: string }): Issue[] {
  const state = input.state === 'closed' || input.state === 'all' ? input.state : 'open';
  const wanted = (input.labels ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  const out: Issue[] = [];
  for (const issue of repo.issues.values()) {
    if (state !== 'all' && issue.state !== state) continue;
    if (wanted.length > 0 && !wanted.every((name) => issue.labels.some((l) => l.toLowerCase() === name))) continue;
    out.push(issue);
  }
  const sign = input.direction === 'asc' ? 1 : -1;
  const sort = input.sort;
  if (sort === 'updated') out.sort((a, b) => sign * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
  else if (sort === 'comments') out.sort((a, b) => sign * (a.comments.length - b.comments.length || a.number - b.number));
  else out.sort((a, b) => sign * (a.number - b.number));
  return out;
}

export function addCommentAction(repo: Repo, number: number, body: unknown): Comment {
  const target = repo.issues.get(number) ?? repo.pulls.get(number);
  if (target === undefined) throw notFound();
  const text = nonEmptyString(body, 'IssueComment', 'body');
  return store.addComment(target, text);
}

export function createLabelAction(repo: Repo, input: { name: unknown; color?: unknown; description?: unknown }): Label {
  const name = nonEmptyString(input.name, 'Label', 'name');
  if (repo.labels.has(name.toLowerCase())) throw validation('Label', 'name', 'already_exists');
  let color = 'ededed';
  if (input.color !== undefined && input.color !== null) {
    if (typeof input.color !== 'string') throw validation('Label', 'color', 'invalid');
    const stripped = input.color.replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(stripped)) throw validation('Label', 'color', 'invalid');
    color = stripped.toLowerCase();
  }
  const description = optionalString(input.description, 'Label', 'description') ?? null;
  const label = store.createLabel(repo, { name, color, description });
  repo.updatedAt = store.now();
  return label;
}

export function createPullAction(repo: Repo, input: { title: unknown; body?: unknown; head: unknown; base?: unknown; draft?: unknown }): PullRequest {
  const title = nonEmptyString(input.title, 'PullRequest', 'title');
  const body = optionalString(input.body, 'PullRequest', 'body') ?? null;
  if (typeof input.head !== 'string' || input.head === '') throw validation('PullRequest', 'head', 'missing_field');
  const colon = input.head.indexOf(':');
  const head = branchOf(colon === -1 ? input.head : input.head.slice(colon + 1));
  const base = input.base === undefined || input.base === null ? repo.defaultBranch : typeof input.base === 'string' && input.base !== '' ? branchOf(input.base) : undefined;
  if (base === undefined) throw validation('PullRequest', 'base', 'invalid');
  const headSha = git.resolveRef(repo, `refs/heads/${head}`);
  if (headSha === undefined) throw validation('PullRequest', 'head', 'invalid');
  const baseSha = git.resolveRef(repo, `refs/heads/${base}`);
  if (baseSha === undefined) throw validation('PullRequest', 'base', 'invalid');
  if (headSha === baseSha) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }] });
  for (const other of repo.pulls.values()) {
    if (other.state === 'open' && other.head === head && other.base === base) {
      throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner.login}:${head}.` }] });
    }
  }
  return store.createPull(repo, { title, body, head, base, headSha, baseSha, draft: input.draft === true });
}

/** Refresh an open pull request's head and base commit ids from the branches. */
export function refreshPull(repo: Repo, pull: PullRequest): void {
  if (pull.state !== 'open') return;
  const headSha = git.resolveRef(repo, `refs/heads/${pull.head}`);
  const baseSha = git.resolveRef(repo, `refs/heads/${pull.base}`);
  if (headSha !== undefined) pull.headSha = headSha;
  if (baseSha !== undefined) pull.baseSha = baseSha;
}

export function updatePullAction(repo: Repo, pull: PullRequest, input: Record<string, unknown>): PullRequest {
  if (input.title !== undefined) pull.title = nonEmptyString(input.title, 'PullRequest', 'title');
  if (input.body !== undefined) pull.body = optionalString(input.body, 'PullRequest', 'body') ?? null;
  const at = store.now();
  if (input.state !== undefined) {
    if (input.state !== 'open' && input.state !== 'closed') throw validation('PullRequest', 'state', 'invalid');
    if (input.state === 'closed' && pull.state === 'open') {
      pull.state = 'closed';
      pull.closedAt = at;
    } else if (input.state === 'open' && pull.state === 'closed' && !pull.merged) {
      pull.state = 'open';
      pull.closedAt = null;
    }
  }
  pull.updatedAt = at;
  repo.updatedAt = at;
  return pull;
}

export function mergePullAction(repo: Repo, pull: PullRequest, input: { commit_title?: unknown; commit_message?: unknown; merge_method?: unknown; sha?: unknown }): { sha: string; merged: true; message: string } {
  if (pull.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const headSha = git.resolveRef(repo, `refs/heads/${pull.head}`) ?? pull.headSha;
  if (typeof input.sha === 'string' && input.sha !== '' && input.sha.toLowerCase() !== headSha.toLowerCase()) {
    throw new HttpError(409, 'Head branch was modified. Review and try the merge again.');
  }
  const title = typeof input.commit_title === 'string' && input.commit_title !== '' ? input.commit_title : `${pull.title} (#${pull.number})`;
  const extra = typeof input.commit_message === 'string' ? input.commit_message : pull.body ?? '';
  const message = extra === '' ? title : `${title}\n\n${extra}`;
  const result = git.squashMerge(repo, { baseBranch: pull.base, headSha, message });
  if (!result.ok) throw new HttpError(405, 'Merge conflict');
  const at = store.now();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = at;
  pull.closedAt = at;
  pull.updatedAt = at;
  pull.mergeCommitSha = result.sha;
  pull.headSha = headSha;
  repo.updatedAt = at;
  repo.pushedAt = at;
  return { sha: result.sha, merged: true, message: 'Pull Request successfully merged' };
}

// ---- JSON shapes (GitHub REST v3 field names)

export function simpleUserJson(origin: Origin, user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    avatar_url: `${origin}/avatars/u/${user.id}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${user.login}`,
    html_url: `${origin}/${user.login}`,
    type: 'User',
    site_admin: false,
  };
}

export function userJson(origin: Origin): Record<string, unknown> {
  const user = store.viewer;
  return { ...simpleUserJson(origin, user), name: user.name, email: user.email, public_repos: store.repos.size, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' };
}

function repoApi(origin: Origin, repo: Repo): string {
  return `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}`;
}

export function repoJson(origin: Origin, repo: Repo): Record<string, unknown> {
  const api = repoApi(origin, repo);
  const html = `${origin}/${repo.owner.login}/${repo.name}`;
  let open = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') open += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') open += 1;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    private: repo.private,
    visibility: repo.private ? 'private' : 'public',
    owner: simpleUserJson(origin, repo.owner),
    html_url: html,
    description: repo.description,
    fork: false,
    url: api,
    clone_url: `${html}.git`,
    git_url: `${html}.git`,
    ssh_url: `${html}.git`,
    homepage: repo.homepage,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
    has_wiki: false,
    has_projects: false,
    archived: false,
    disabled: false,
    open_issues_count: open,
    open_issues: open,
    size: 0,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(origin: Origin, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `${repoApi(origin, repo)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function labelsOf(origin: Origin, repo: Repo, names: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    const label = repo.labels.get(name.toLowerCase());
    if (label !== undefined) out.push(labelJson(origin, repo, label));
  }
  return out;
}

export function issueJson(origin: Origin, repo: Repo, issue: Issue): Record<string, unknown> {
  const api = `${repoApi(origin, repo)}/issues/${issue.number}`;
  const assignees = issue.assignees.map((login) => simpleUserJson(origin, login === store.viewer.login ? store.viewer : { id: 0, login, name: login, email: '' }));
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: api,
    repository_url: repoApi(origin, repo),
    labels_url: `${api}/labels{/name}`,
    comments_url: `${api}/comments`,
    events_url: `${api}/events`,
    html_url: `${origin}/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: simpleUserJson(origin, issue.user),
    labels: labelsOf(origin, repo, issue.labels),
    state: issue.state,
    state_reason: issue.stateReason,
    locked: false,
    assignee: assignees[0] ?? null,
    assignees,
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
  };
}

export function commentJson(origin: Origin, repo: Repo, comment: Comment): Record<string, unknown> {
  const api = repoApi(origin, repo);
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `${api}/issues/comments/${comment.id}`,
    html_url: `${origin}/${repo.owner.login}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${api}/issues/${comment.issueNumber}`,
    body: comment.body,
    user: simpleUserJson(origin, comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullEnd(origin: Origin, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner.login}:${ref}`,
    ref,
    sha,
    user: simpleUserJson(origin, repo.owner),
    repo: repoJson(origin, repo),
  };
}

export function pullJson(origin: Origin, repo: Repo, pull: PullRequest): Record<string, unknown> {
  refreshPull(repo, pull);
  const api = `${repoApi(origin, repo)}/pulls/${pull.number}`;
  const html = `${origin}/${repo.owner.login}/${repo.name}/pull/${pull.number}`;
  let mergeable: boolean | null = null;
  if (pull.state === 'open') {
    try {
      mergeable = git.mergeable(repo, pull.base, pull.headSha);
    } catch {
      mergeable = null;
    }
  }
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    url: api,
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: `${repoApi(origin, repo)}/issues/${pull.number}`,
    commits_url: `${api}/commits`,
    comments_url: `${repoApi(origin, repo)}/issues/${pull.number}/comments`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: simpleUserJson(origin, pull.user),
    body: pull.body,
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    draft: pull.draft,
    head: pullEnd(origin, repo, pull.head, pull.headSha),
    base: pullEnd(origin, repo, pull.base, pull.baseSha),
    author_association: 'OWNER',
    merged: pull.merged,
    mergeable,
    rebaseable: mergeable,
    mergeable_state: pull.merged ? 'unknown' : mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? simpleUserJson(origin, repo.owner) : null,
    comments: pull.comments.length,
  };
}
