// The forge's one in-memory store. Every surface (git smart HTTP, REST v3, GraphQL v4 and MCP) reads
// and writes these same objects, so a repository or an issue made over one surface reads back over
// every other with the same ids.
//
// Determinism: the suite replays a trial and compares its export byte for byte, so nothing here reads
// the wall clock or a random source. Ids come from counters, and every timestamp is the trial's
// opening time (MAKEFUN_TRIAL_NOW) plus a tick that advances once per created object, so "newer"
// always sorts after "older" and two runs produce the same values.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored git object: its type and its raw body (the bytes after the "<type> <size>\0" header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly body: Buffer;
}

/** A repository's git data: the object database, the refs and HEAD's symbolic target. */
export interface GitData {
  readonly objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main, refs/tags/v1) to a 40-hex object id. */
  readonly refs: Map<string, string>;
  /** The ref HEAD points at, e.g. refs/heads/main (it may not exist yet: an unborn branch). */
  head: string;
}

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
  readonly user: User;
  readonly createdAt: string;
  updatedAt: string;
}

/** An issue. A pull request is also an issue on GitHub; here it is a separate record sharing the number sequence. */
export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  readonly user: User;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** Branch names (no refs/heads/ prefix). */
  head: string;
  base: string;
  /** The head and base commit ids when the pull was opened, refreshed while it is open. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  draft: boolean;
  readonly user: User;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Repo {
  readonly id: number;
  readonly owner: User;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  homepage: string | null;
  hasIssues: boolean;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  readonly git: GitData;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  /** The next issue / pull request number (one sequence for both, as on GitHub). */
  nextNumber: number;
}

/** The login the suite's token names. The suite's scenario is built from one fixed seed, so it is fixed too. */
const VIEWER_LOGIN = process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen';

function parseNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const parsed = raw === undefined ? Number.NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.parse('2026-11-14T06:30:00Z');
}

export class Store {
  readonly viewer: User;
  readonly token: string;
  /** Repositories by "owner/name" in lower case. */
  readonly repos = new Map<string, Repo>();
  readonly #baseMs = parseNow();
  #tick = 0;
  #nextRepoId = 1;
  #nextIssueId = 1;
  #nextPullId = 1;
  #nextCommentId = 1;
  #nextLabelId = 1;

  constructor() {
    this.viewer = Object.freeze({ id: 1000, login: VIEWER_LOGIN, name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` });
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  /** The trial's clock: the opening time plus one second per call, as an ISO string without milliseconds. */
  now(): string {
    const ms = this.#baseMs + this.#tick * 1000;
    this.#tick += 1;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The same clock as unix seconds and a "+0000" offset, for git commit headers. */
  gitTime(): string {
    const ms = this.#baseMs + this.#tick * 1000;
    this.#tick += 1;
    return `${Math.floor(ms / 1000)} +0000`;
  }

  /** Whether an Authorization header value carries the trial's token. */
  authorized(header: string | undefined): boolean {
    if (header === undefined) return false;
    const match = /^(?:bearer|token)\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    return this.token === '' || match[1].trim() === this.token;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  /** Repositories the viewer owns, oldest first (creation order is id order). */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  createRepo(input: { name: string; description?: string | null; private?: boolean; defaultBranch?: string; homepage?: string | null; hasIssues?: boolean }): Repo {
    const at = this.now();
    const defaultBranch = input.defaultBranch ?? 'main';
    const repo: Repo = {
      id: this.#nextRepoId++,
      owner: this.viewer,
      name: input.name,
      description: input.description ?? null,
      private: input.private ?? false,
      defaultBranch,
      homepage: input.homepage ?? null,
      hasIssues: input.hasIssues ?? true,
      createdAt: at,
      updatedAt: at,
      pushedAt: null,
      git: { objects: new Map(), refs: new Map(), head: `refs/heads/${defaultBranch}` },
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(`${this.viewer.login}/${input.name}`.toLowerCase(), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner.login}/${repo.name}`.toLowerCase());
  }

  /** Rename keeps the record and moves its key. */
  renameRepo(repo: Repo, name: string): void {
    this.repos.delete(`${repo.owner.login}/${repo.name}`.toLowerCase());
    repo.name = name;
    this.repos.set(`${repo.owner.login}/${name}`.toLowerCase(), repo);
  }

  createLabel(repo: Repo, input: { name: string; color?: string; description?: string | null }): Label {
    const label: Label = { id: this.#nextLabelId++, name: input.name, color: input.color ?? 'ededed', description: input.description ?? null };
    repo.labels.set(input.name.toLowerCase(), label);
    return label;
  }

  createIssue(repo: Repo, input: { title: string; body?: string | null; labels?: string[]; assignees?: string[] }): Issue {
    const at = this.now();
    const issue: Issue = {
      id: this.#nextIssueId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      stateReason: null,
      labels: input.labels ?? [],
      assignees: input.assignees ?? [],
      user: this.viewer,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    repo.updatedAt = at;
    return issue;
  }

  createPull(repo: Repo, input: { title: string; body?: string | null; head: string; base: string; headSha: string; baseSha: string; draft?: boolean }): PullRequest {
    const at = this.now();
    const pull: PullRequest = {
      id: this.#nextPullId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? null,
      state: 'open',
      head: input.head,
      base: input.base,
      headSha: input.headSha,
      baseSha: input.baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      draft: input.draft ?? false,
      user: this.viewer,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      comments: [],
    };
    repo.pulls.set(pull.number, pull);
    repo.updatedAt = at;
    return pull;
  }

  addComment(target: Issue | PullRequest, body: string): Comment {
    const at = this.now();
    const comment: Comment = { id: this.#nextCommentId++, issueNumber: target.number, body, user: this.viewer, createdAt: at, updatedAt: at };
    target.comments.push(comment);
    target.updatedAt = at;
    return comment;
  }
}

/** The process's one store. */
export const store = new Store();
