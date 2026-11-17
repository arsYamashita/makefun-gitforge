// Resolvers for the schema in schema.ts. Reads go straight to the store; mutations call the shared
// domain actions so GraphQL and REST act identically.

import * as actions from '../actions.ts';
import * as git from '../git/repo.ts';
import { store } from '../store.ts';
import type { Comment, Issue, PullRequest, Repo, User } from '../store.ts';
import { GraphQLFieldError } from './execute.ts';
import type { ExecContext, ResolverMap } from './execute.ts';
import { INTROSPECTION_RESOLVERS } from './introspection.ts';

// The actions and git modules are contracts filled in by other modules; reach them by name at call
// time so this module loads before they are complete.
const api = actions as unknown as Record<string, any>;
const gitApi = git as unknown as Record<string, any>;

function action(name: string): (...args: any[]) => any {
  const fn = api[name];
  if (typeof fn !== 'function') throw new GraphQLFieldError(`${name} is not available`);
  return fn;
}

function safeGit<T>(name: string, fallback: T, ...args: any[]): T {
  try {
    const fn = gitApi[name];
    if (typeof fn !== 'function') return fallback;
    const v = fn(...args);
    return v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

// ---- global ids

type Kind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User' | 'Label';
const KINDS: Kind[] = ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label'];

export function idOf(kind: Kind, n: number): string {
  const fn = api.nodeId;
  if (typeof fn === 'function') return fn(kind, n) as string;
  return Buffer.from(`${kind}:${n}`).toString('base64');
}

export function decodeId(id: unknown): { kind: Kind; n: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  let decoded = '';
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const m = /(\d+)\s*$/.exec(decoded) ?? /(\d+)\s*$/.exec(id);
  if (m === null) return null;
  const n = Number(m[1]);
  for (const kind of KINDS) if (idOf(kind, n) === id) return { kind, n };
  return null;
}

function notFound(what: string, id: unknown): GraphQLFieldError {
  return new GraphQLFieldError(`Could not resolve to ${what} with the id of '${String(id)}'.`, 'NOT_FOUND');
}

function findRepoById(n: number): Repo | undefined {
  for (const r of store.repos.values()) if (r.id === n) return r;
  return undefined;
}

function findIssueById(n: number): { repo: Repo; item: Issue } | undefined {
  for (const repo of store.repos.values()) for (const item of repo.issues.values()) if (item.id === n) return { repo, item };
  return undefined;
}

function findPullById(n: number): { repo: Repo; item: PullRequest } | undefined {
  for (const repo of store.repos.values()) for (const item of repo.pulls.values()) if (item.id === n) return { repo, item };
  return undefined;
}

function findCommentById(n: number): { repo: Repo; target: Issue | PullRequest; comment: Comment } | undefined {
  for (const repo of store.repos.values()) {
    for (const target of [...repo.issues.values(), ...repo.pulls.values()]) {
      const comment = target.comments.find((c) => c.id === n);
      if (comment !== undefined) return { repo, target, comment };
    }
  }
  return undefined;
}

// ---- sources

const EPOCH = '2020-01-01T00:00:00Z';

function userSource(user: { id: number; login: string; name?: string; email?: string }): any {
  return {
    __typename: 'User',
    id: idOf('User', user.id),
    databaseId: user.id,
    login: user.login,
    name: user.name ?? user.login,
    email: user.email ?? '',
  };
}

const repoSource = (repo: Repo): any => ({ __typename: 'Repository', repo });
const issueSource = (repo: Repo, item: Issue): any => ({ __typename: 'Issue', repo, item });
const pullSource = (repo: Repo, item: PullRequest): any => ({ __typename: 'PullRequest', repo, item });
const commentSource = (repo: Repo, target: Issue | PullRequest, comment: Comment): any => ({ __typename: 'IssueComment', repo, target, comment });

function userByLogin(login: string): User {
  if (login.toLowerCase() === store.viewer.login.toLowerCase()) return store.viewer;
  return { id: 0, login, name: login, email: '' };
}

function nodeSource(id: unknown): any {
  const d = decodeId(id);
  if (d === null) return null;
  switch (d.kind) {
    case 'Repository': {
      const r = findRepoById(d.n);
      return r === undefined ? null : repoSource(r);
    }
    case 'Issue': {
      const f = findIssueById(d.n);
      return f === undefined ? null : issueSource(f.repo, f.item);
    }
    case 'PullRequest': {
      const f = findPullById(d.n);
      return f === undefined ? null : pullSource(f.repo, f.item);
    }
    case 'IssueComment': {
      const f = findCommentById(d.n);
      return f === undefined ? null : commentSource(f.repo, f.target, f.comment);
    }
    case 'User':
      return d.n === store.viewer.id ? userSource(store.viewer) : null;
    default:
      return null;
  }
}

// ---- connections

function mkCursor(position: number): string {
  return Buffer.from(`cursor:${position}`).toString('base64');
}

function cursorPosition(cursor: unknown): number {
  const m = /^cursor:(\d+)$/.exec(Buffer.from(String(cursor), 'base64').toString('utf8'));
  if (m === null) throw new GraphQLFieldError(`\`${String(cursor)}\` does not appear to be a valid cursor.`);
  return Number(m[1]);
}

function connection<T>(all: T[], args: Record<string, any>, nodeType: string, map: (item: T) => any): any {
  for (const key of ['first', 'last']) {
    if (args[key] !== undefined && args[key] !== null && (!Number.isInteger(args[key]) || args[key] < 0)) {
      throw new GraphQLFieldError(`${key[0].toUpperCase()}${key.slice(1)} must be a non-negative integer`);
    }
  }
  const total = all.length;
  let start = 0;
  let end = total;
  if (args.after !== undefined && args.after !== null) start = Math.min(total, cursorPosition(args.after));
  if (args.before !== undefined && args.before !== null) end = Math.max(start, Math.min(total, cursorPosition(args.before) - 1));
  const hasFirst = args.first !== undefined && args.first !== null;
  const hasLast = args.last !== undefined && args.last !== null;
  if (hasFirst) end = Math.min(end, start + args.first);
  if (hasLast) start = Math.max(start, end - args.last);
  if (!hasFirst && !hasLast) end = Math.min(end, start + 100);
  const edges = all.slice(start, end).map((item, i) => ({ __typename: `${nodeType}Edge`, cursor: mkCursor(start + i + 1), node: map(item) }));
  return {
    __typename: `${nodeType}Connection`,
    edges,
    nodes: edges.map((e) => e.node),
    totalCount: total,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < total,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

function ordered<T extends { number: number; createdAt: string; updatedAt: string; comments: unknown[] }>(list: T[], orderBy: any): T[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const dir = orderBy?.direction === 'DESC' ? -1 : 1;
  const key = (x: T): string | number => (field === 'UPDATED_AT' ? x.updatedAt : field === 'COMMENTS' ? x.comments.length : x.createdAt);
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = ka < kb ? -1 : ka > kb ? 1 : 0;
    return (c !== 0 ? c : a.number - b.number) * dir;
  });
}

// ---- pull request helpers

function pullTips(repo: Repo, pull: PullRequest): { base: string; head: string } {
  if (pull.state === 'open' && !pull.merged) {
    return {
      base: safeGit<string>('resolveRef', pull.baseSha, repo, pull.base),
      head: safeGit<string>('resolveRef', pull.headSha, repo, pull.head),
    };
  }
  return { base: pull.baseSha, head: pull.headSha };
}

function pullFiles(repo: Repo, pull: PullRequest): any[] {
  const tips = pullTips(repo, pull);
  const from = pull.state === 'open' && !pull.merged ? safeGit<string>('mergeBase', tips.base, repo, tips.base, tips.head) : tips.base;
  return safeGit<any[]>('diffCommits', [], repo, from, tips.head);
}

function pullMergeable(repo: Repo, pull: PullRequest): string {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const tips = pullTips(repo, pull);
  try {
    const fn = gitApi.mergeable;
    if (typeof fn !== 'function') return 'UNKNOWN';
    return fn(repo, pull.base, tips.head) ? 'MERGEABLE' : 'CONFLICTING';
  } catch {
    return 'UNKNOWN';
  }
}

function pullState(p: PullRequest): string {
  return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
}

function labelNodes(repo: Repo, names: string[]): any[] {
  return names.map((name) => {
    const l = repo.labels.get(name.toLowerCase());
    return { __typename: 'Label', id: l === undefined ? idOf('Label', 0) : idOf('Label', l.id), name, color: l?.color ?? 'ededed', description: l?.description ?? null };
  });
}

// ---- thread resolvers shared by Issue and PullRequest

function threadResolvers(kind: 'Issue' | 'PullRequest'): Record<string, (src: any, args: any, ctx: ExecContext) => unknown> {
  const segment = kind === 'Issue' ? 'issues' : 'pull';
  return {
    id: (s) => idOf(kind, s.item.id),
    databaseId: (s) => s.item.id,
    number: (s) => s.item.number,
    title: (s) => s.item.title,
    body: (s) => s.item.body ?? '',
    bodyText: (s) => s.item.body ?? '',
    url: (s, _a, ctx) => `${ctx.origin}/${s.repo.owner.login}/${s.repo.name}/${segment}/${s.item.number}`,
    createdAt: (s) => s.item.createdAt,
    updatedAt: (s) => s.item.updatedAt,
    closedAt: (s) => s.item.closedAt,
    closed: (s) => s.item.state === 'closed',
    locked: () => false,
    author: (s) => userSource(s.item.user),
    repository: (s) => repoSource(s.repo),
    comments: (s, args) => connection(s.item.comments as Comment[], args, 'IssueComment', (c) => commentSource(s.repo, s.item, c)),
    labels: (s, args) => connection(labelNodes(s.repo, kind === 'Issue' ? (s.item as Issue).labels : []), args, 'Label', (l) => l),
    assignees: (s, args) => connection(kind === 'Issue' ? (s.item as Issue).assignees : [], args, 'User', (login: string) => userSource(userByLogin(login))),
  };
}

const issueResolvers = {
  ...threadResolvers('Issue'),
  state: (s: any) => (s.item.state === 'open' ? 'OPEN' : 'CLOSED'),
  stateReason: (s: any) => {
    const r = s.item.stateReason;
    if (r === 'completed') return 'COMPLETED';
    if (r === 'not_planned') return 'NOT_PLANNED';
    if (r === 'reopened') return 'REOPENED';
    return null;
  },
};

const pullResolvers = {
  ...threadResolvers('PullRequest'),
  state: (s: any) => pullState(s.item),
  merged: (s: any) => s.item.merged,
  mergedAt: (s: any) => s.item.mergedAt,
  mergeable: (s: any) => pullMergeable(s.repo, s.item),
  isDraft: (s: any) => s.item.draft,
  headRefName: (s: any) => s.item.head,
  baseRefName: (s: any) => s.item.base,
  headRefOid: (s: any) => pullTips(s.repo, s.item).head,
  baseRefOid: (s: any) => pullTips(s.repo, s.item).base,
  mergeCommit: (s: any) => (s.item.mergeCommitSha === null ? null : commitSource(s.item.mergeCommitSha)),
  additions: (s: any) => pullFiles(s.repo, s.item).reduce((n, f) => n + (f.additions ?? 0), 0),
  deletions: (s: any) => pullFiles(s.repo, s.item).reduce((n, f) => n + (f.deletions ?? 0), 0),
  changedFiles: (s: any) => pullFiles(s.repo, s.item).length,
  files: (s: any, args: any) =>
    connection(pullFiles(s.repo, s.item), args, 'PullRequestChangedFile', (f: any) => ({
      __typename: 'PullRequestChangedFile',
      path: f.filename,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED',
    })),
};

function commitSource(oid: string): any {
  return { __typename: 'Commit', oid, abbreviatedOid: oid.slice(0, 7) };
}

// ---- search

function searchItems(query: string, type: string): any[] {
  const terms = query.match(/"[^"]*"|\S+/g) ?? [];
  const words: string[] = [];
  const quals: { neg: boolean; key: string; value: string }[] = [];
  for (const term of terms) {
    const m = /^(-?)([A-Za-z-]+):(.+)$/.exec(term);
    if (m !== null) quals.push({ neg: m[1] === '-', key: m[2].toLowerCase(), value: m[3].replace(/"/g, '').toLowerCase() });
    else words.push(term.replace(/"/g, '').toLowerCase());
  }
  const matchesWords = (text: string): boolean => words.every((w) => text.toLowerCase().includes(w));
  const out: { source: any; createdAt: string; number: number }[] = [];
  for (const repo of store.listRepos()) {
    const full = `${repo.owner.login}/${repo.name}`.toLowerCase();
    const repoQuals = quals.filter((q) => q.key === 'repo' || q.key === 'user' || q.key === 'org' || q.key === 'owner');
    const inRepo = repoQuals.every((q) => {
      const ok = q.key === 'repo' ? full === q.value : repo.owner.login.toLowerCase() === q.value;
      return q.neg ? !ok : ok;
    });
    if (!inRepo) continue;
    if (type === 'REPOSITORY') {
      if (matchesWords(`${repo.name} ${repo.description ?? ''}`)) out.push({ source: repoSource(repo), createdAt: repo.createdAt, number: repo.id });
      continue;
    }
    if (type !== 'ISSUE' && type !== 'ISSUE_ADVANCED') continue;
    const items: { src: any; item: Issue | PullRequest; isPull: boolean }[] = [
      ...[...repo.issues.values()].map((item) => ({ src: issueSource(repo, item), item, isPull: false })),
      ...[...repo.pulls.values()].map((item) => ({ src: pullSource(repo, item), item, isPull: true })),
    ];
    for (const { src, item, isPull } of items) {
      if (!matchesWords(`${item.title} ${item.body ?? ''}`)) continue;
      const ok = quals.every((q) => {
        let hit: boolean | null = null;
        if (q.key === 'is') {
          if (q.value === 'open' || q.value === 'closed') hit = item.state === q.value && !(q.value === 'closed' && false);
          else if (q.value === 'merged') hit = isPull && (item as PullRequest).merged;
          else if (q.value === 'issue') hit = !isPull;
          else if (q.value === 'pr' || q.value === 'pull-request') hit = isPull;
        } else if (q.key === 'state') hit = item.state === q.value;
        else if (q.key === 'type') hit = q.value === 'issue' ? !isPull : q.value === 'pr' ? isPull : null;
        else if (q.key === 'author') hit = item.user.login.toLowerCase() === q.value;
        else if (q.key === 'label') hit = !isPull && (item as Issue).labels.some((l) => l.toLowerCase() === q.value);
        if (hit === null) return true;
        return q.neg ? !hit : hit;
      });
      if (ok) out.push({ source: src, createdAt: item.createdAt, number: item.number });
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.number - a.number));
  return out.map((o) => o.source);
}

// ---- mutations

function requireRepoById(id: unknown): Repo {
  const d = decodeId(id);
  const repo = d !== null && d.kind === 'Repository' ? findRepoById(d.n) : undefined;
  if (repo === undefined) throw notFound('a Repository', id);
  return repo;
}

function requireIssueById(id: unknown): { repo: Repo; item: Issue } {
  const d = decodeId(id);
  const found = d !== null && d.kind === 'Issue' ? findIssueById(d.n) : undefined;
  if (found === undefined) throw notFound('an Issue', id);
  return found;
}

function requirePullById(id: unknown): { repo: Repo; item: PullRequest } {
  const d = decodeId(id);
  const found = d !== null && d.kind === 'PullRequest' ? findPullById(d.n) : undefined;
  if (found === undefined) throw notFound('a PullRequest', id);
  return found;
}

function labelNamesFromIds(repo: Repo, ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const names: string[] = [];
  for (const id of ids) {
    const d = decodeId(id);
    const label = d === null ? undefined : [...repo.labels.values()].find((l) => l.id === d.n);
    if (label === undefined) throw notFound('a Label', id);
    names.push(label.name);
  }
  return names;
}

function changeIssueState(args: any, state: 'open' | 'closed'): any {
  const { repo, item } = requireIssueById(args.input.issueId);
  const patch: Record<string, unknown> = { state };
  if (state === 'closed') patch.state_reason = args.input.stateReason === 'NOT_PLANNED' ? 'not_planned' : 'completed';
  else patch.state_reason = 'reopened';
  const updated = action('updateIssueAction')(repo, item, patch) as Issue | undefined;
  return { clientMutationId: args.input.clientMutationId ?? null, issue: issueSource(repo, updated ?? item) };
}

const MUTATION: Record<string, (src: any, args: any, ctx: ExecContext) => unknown> = {
  createIssue: (_s, args) => {
    const input = args.input;
    const repo = requireRepoById(input.repositoryId);
    const issue = action('createIssueAction')(repo, {
      title: input.title,
      body: input.body ?? undefined,
      labels: labelNamesFromIds(repo, input.labelIds),
    }) as Issue;
    return { clientMutationId: input.clientMutationId ?? null, issue: issueSource(repo, issue) };
  },
  closeIssue: (_s, args) => changeIssueState(args, 'closed'),
  reopenIssue: (_s, args) => changeIssueState(args, 'open'),
  updateIssue: (_s, args) => {
    const input = args.input;
    const { repo, item } = requireIssueById(input.id);
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined && input.title !== null) patch.title = input.title;
    if (input.body !== undefined) patch.body = input.body;
    if (input.state === 'OPEN') patch.state = 'open';
    if (input.state === 'CLOSED') patch.state = 'closed';
    const updated = action('updateIssueAction')(repo, item, patch) as Issue | undefined;
    return { clientMutationId: input.clientMutationId ?? null, issue: issueSource(repo, updated ?? item) };
  },
  addComment: (_s, args) => {
    const input = args.input;
    const d = decodeId(input.subjectId);
    let target: { repo: Repo; item: Issue | PullRequest } | undefined;
    if (d !== null && d.kind === 'Issue') target = findIssueById(d.n);
    else if (d !== null && d.kind === 'PullRequest') target = findPullById(d.n);
    if (target === undefined) throw notFound('a subject', input.subjectId);
    const comment = action('addCommentAction')(target.repo, target.item.number, input.body) as Comment;
    return {
      clientMutationId: input.clientMutationId ?? null,
      commentEdge: { __typename: 'IssueCommentEdge', cursor: mkCursor(target.item.comments.length), node: commentSource(target.repo, target.item, comment) },
      subject: d?.kind === 'Issue' ? issueSource(target.repo, target.item as Issue) : pullSource(target.repo, target.item as PullRequest),
    };
  },
  createPullRequest: (_s, args) => {
    const input = args.input;
    const repo = requireRepoById(input.repositoryId);
    const pull = action('createPullAction')(repo, {
      title: input.title,
      body: input.body ?? undefined,
      head: input.headRefName,
      base: input.baseRefName,
      draft: input.draft ?? false,
    }) as PullRequest;
    return { clientMutationId: input.clientMutationId ?? null, pullRequest: pullSource(repo, pull) };
  },
  mergePullRequest: (_s, args) => {
    const input = args.input;
    const { repo, item } = requirePullById(input.pullRequestId);
    action('mergePullAction')(repo, item, {
      merge_method: String(input.mergeMethod ?? 'MERGE').toLowerCase(),
      commit_title: input.commitHeadline ?? undefined,
      commit_message: input.commitBody ?? undefined,
      sha: input.expectedHeadOid ?? undefined,
    });
    return { clientMutationId: input.clientMutationId ?? null, pullRequest: pullSource(repo, item) };
  },
  closePullRequest: (_s, args) => {
    const input = args.input;
    const { repo, item } = requirePullById(input.pullRequestId);
    if (item.merged) throw new GraphQLFieldError('Pull request is already merged');
    if (item.state === 'open') {
      const at = store.now();
      item.state = 'closed';
      item.closedAt = at;
      item.updatedAt = at;
      repo.updatedAt = at;
    }
    return { clientMutationId: input.clientMutationId ?? null, pullRequest: pullSource(repo, item) };
  },
};

// ---- the resolver map

export const RESOLVERS: ResolverMap = {
  Query: {
    ...INTROSPECTION_RESOLVERS.Query,
    viewer: () => userSource(store.viewer),
    repository: (_s, args) => {
      const repo = store.getRepo(String(args.owner), String(args.name));
      return repo === undefined ? null : repoSource(repo);
    },
    repositoryOwner: (_s, args) => (String(args.login).toLowerCase() === store.viewer.login.toLowerCase() ? userSource(store.viewer) : null),
    user: (_s, args) => (String(args.login).toLowerCase() === store.viewer.login.toLowerCase() ? userSource(store.viewer) : null),
    node: (_s, args) => nodeSource(args.id),
    nodes: (_s, args) => (Array.isArray(args.ids) ? args.ids.map(nodeSource) : []),
    search: (_s, args) => {
      const all = searchItems(String(args.query), String(args.type));
      const conn = connection(all, args, 'SearchResultItem', (x) => x);
      conn.issueCount = args.type === 'ISSUE' || args.type === 'ISSUE_ADVANCED' ? all.length : 0;
      conn.repositoryCount = args.type === 'REPOSITORY' ? all.length : 0;
      conn.userCount = 0;
      return conn;
    },
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 5000, nodeCount: 0, used: 0, resetAt: EPOCH }),
  },
  Mutation: MUTATION,
  __Type: INTROSPECTION_RESOLVERS.__Type,
  User: {
    url: (s, _a, ctx) => `${ctx.origin}/${s.login}`,
    avatarUrl: (s, _a, ctx) => `${ctx.origin}/avatars/u/${s.databaseId}`,
    createdAt: () => EPOCH,
  },
  Commit: {},
  Repository: {
    id: (s) => idOf('Repository', s.repo.id),
    databaseId: (s) => s.repo.id,
    name: (s) => s.repo.name,
    nameWithOwner: (s) => `${s.repo.owner.login}/${s.repo.name}`,
    owner: (s) => userSource(s.repo.owner),
    description: (s) => s.repo.description,
    url: (s, _a, ctx) => `${ctx.origin}/${s.repo.owner.login}/${s.repo.name}`,
    homepageUrl: (s) => s.repo.homepage,
    isPrivate: (s) => s.repo.private,
    isFork: () => false,
    isArchived: () => false,
    createdAt: (s) => s.repo.createdAt,
    updatedAt: (s) => s.repo.updatedAt,
    pushedAt: (s) => s.repo.pushedAt,
    stargazerCount: () => 0,
    defaultBranchRef: (s) => {
      const repo: Repo = s.repo;
      const oid = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
      return oid === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: commitSource(oid) };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: (s) => s.repo.hasIssues,
    issue: (s, args) => {
      const item = s.repo.issues.get(args.number);
      if (item === undefined) throw new GraphQLFieldError(`Could not resolve to an Issue with the number of ${args.number}.`, 'NOT_FOUND');
      return issueSource(s.repo, item);
    },
    issues: (s, args) => {
      const repo: Repo = s.repo;
      let list = [...repo.issues.values()];
      if (Array.isArray(args.states) && args.states.length > 0) {
        list = list.filter((i) => args.states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      if (Array.isArray(args.labels) && args.labels.length > 0) {
        list = list.filter((i) => args.labels.every((l: string) => i.labels.some((x) => x.toLowerCase() === l.toLowerCase())));
      }
      return connection(ordered(list, args.orderBy), args, 'Issue', (i) => issueSource(repo, i));
    },
    pullRequests: (s, args) => {
      const repo: Repo = s.repo;
      let list = [...repo.pulls.values()];
      if (Array.isArray(args.states) && args.states.length > 0) list = list.filter((p) => args.states.includes(pullState(p)));
      if (typeof args.baseRefName === 'string') list = list.filter((p) => p.base === args.baseRefName);
      if (typeof args.headRefName === 'string') list = list.filter((p) => p.head === args.headRefName);
      return connection(ordered(list, args.orderBy), args, 'PullRequest', (p) => pullSource(repo, p));
    },
    pullRequest: (s, args) => {
      const item = s.repo.pulls.get(args.number);
      if (item === undefined) throw new GraphQLFieldError(`Could not resolve to a PullRequest with the number of ${args.number}.`, 'NOT_FOUND');
      return pullSource(s.repo, item);
    },
    issueOrPullRequest: (s, args) => {
      const issue = s.repo.issues.get(args.number);
      if (issue !== undefined) return issueSource(s.repo, issue);
      const pull = s.repo.pulls.get(args.number);
      if (pull !== undefined) return pullSource(s.repo, pull);
      return null;
    },
  },
  Issue: issueResolvers,
  PullRequest: pullResolvers,
  IssueComment: {
    id: (s) => idOf('IssueComment', s.comment.id),
    databaseId: (s) => s.comment.id,
    body: (s) => s.comment.body,
    bodyText: (s) => s.comment.body,
    author: (s) => userSource(s.comment.user),
    createdAt: (s) => s.comment.createdAt,
    updatedAt: (s) => s.comment.updatedAt,
    url: (s, _a, ctx) => `${ctx.origin}/${s.repo.owner.login}/${s.repo.name}/issues/${s.target.number}#issuecomment-${s.comment.id}`,
  },
};
