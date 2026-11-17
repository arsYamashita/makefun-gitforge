// REST v3 under /api/v3: routing, pagination and the handlers that are not shared domain actions.
// Domain rules live in actions.ts; git work goes through git/repo.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as git from './git/repo.ts';
import { HttpError, parseJsonBody, readBody, sendJson } from './http.ts';
import { store } from './store.ts';
import type { Repo } from './store.ts';
import {
  addCommentAction,
  commentJson,
  createIssueAction,
  createLabelAction,
  createPullAction,
  createRepoAction,
  issueJson,
  labelJson,
  listIssuesAction,
  mergePullAction,
  nodeId,
  pullJson,
  refreshPull,
  repoJson,
  requireIssue,
  requirePull,
  requireRepo,
  simpleUserJson,
  updateIssueAction,
  updatePullAction,
  updateRepoAction,
  userJson,
  validation,
} from './actions.ts';

type Json = Record<string, unknown>;

const SCOPES = { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo' };
const API_PREFIX = '/api/v3';

function notFound(): HttpError {
  return new HttpError(404, 'Not Found', { documentation_url: 'https://docs.github.com/rest' });
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return `http://${host === undefined || host === '' ? '127.0.0.1' : host}`;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw notFound();
  }
}

/** The page, per_page and slice bounds a list request asks for. */
function pageOf(url: URL): { page: number; perPage: number } {
  const perRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const perPage = Number.isFinite(perRaw) && perRaw >= 1 ? Math.min(perRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  return { page, perPage };
}

function linkTo(origin: string, url: URL, page: number): string {
  const next = new URL(url.href);
  next.searchParams.set('page', String(page));
  return `${origin}${next.pathname}${next.search}`;
}

/** Slice a full list into one page and answer it with a Link header. */
function sendPage(res: ServerResponse, origin: string, url: URL, items: readonly Json[] | readonly unknown[]): void {
  const { page, perPage } = pageOf(url);
  const total = items.length;
  const last = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  if (page < last) links.push(`<${linkTo(origin, url, page + 1)}>; rel="next"`, `<${linkTo(origin, url, last)}>; rel="last"`);
  if (page > 1) links.push(`<${linkTo(origin, url, page - 1)}>; rel="prev"`, `<${linkTo(origin, url, 1)}>; rel="first"`);
  sendJson(res, 200, slice, links.length > 0 ? { ...SCOPES, link: links.join(', ') } : SCOPES);
}

function bodyObject(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Problems parsing JSON');
  return value as Json;
}

function numberSegment(segment: string): number {
  if (!/^\d{1,15}$/.test(segment)) throw notFound();
  return Number(segment);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, body, SCOPES);
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const authed = store.authorized(req.headers.authorization);
  let raw: Buffer | undefined;
  if (hasBody) raw = await readBody(req);
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return;
  }
  const segments = url.pathname.slice(API_PREFIX.length).split('/').filter((s) => s !== '');
  const body: Json = raw === undefined || raw.length === 0 ? {} : bodyObject(parseJsonBody(raw));
  const origin = originOf(req);
  await route(req, res, url, method, segments, body, origin);
}

async function route(_req: IncomingMessage, res: ServerResponse, url: URL, method: string, s: string[], body: Json, origin: string): Promise<void> {
  const first = s[0];
  if (first === undefined) {
    if (method !== 'GET') throw notFound();
    reply(res, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${origin}/api/v3/users/{user}/repos`,
      user_url: `${origin}/api/v3/users/{user}`,
      emojis_url: `${origin}/api/v3/emojis`,
    });
    return;
  }
  if (first === 'repos' && s.length >= 3) {
    const repo = requireRepo(decode(s[1]), decode(s[2]));
    repoRoute(res, url, method, s.slice(3), body, origin, repo);
    return;
  }
  if (first === 'meta' && s.length === 1 && method === 'GET') {
    reply(res, 200, { verifiable_password_authentication: false, installed_version: '3.14.0', hooks: [], web: [], api: [], git: [] });
    return;
  }
  if (first === 'user') {
    if (s.length === 1 && method === 'GET') {
      reply(res, 200, userJson(origin));
      return;
    }
    if (s[1] === 'repos' && s.length === 2) {
      if (method === 'GET') {
        sendPage(res, origin, url, listRepos(origin, url));
        return;
      }
      if (method === 'POST') {
        const repo = createRepoAction(body as Parameters<typeof createRepoAction>[0]);
        reply(res, 201, repoJson(origin, repo));
        return;
      }
    }
  }
  if (first === 'users' && s.length >= 2 && method === 'GET') {
    const login = decode(s[1]);
    if (login.toLowerCase() !== store.viewer.login.toLowerCase()) throw notFound();
    if (s.length === 2) {
      reply(res, 200, userJson(origin));
      return;
    }
    if (s.length === 3 && s[2] === 'repos') {
      sendPage(res, origin, url, listRepos(origin, url));
      return;
    }
  }
  throw notFound();
}

function listRepos(origin: string, url: URL): Json[] {
  const type = url.searchParams.get('visibility');
  let repos = store.listRepos();
  if (type === 'private') repos = repos.filter((r) => r.private);
  else if (type === 'public') repos = repos.filter((r) => !r.private);
  return repos.map((r) => repoJson(origin, r));
}

function repoRoute(res: ServerResponse, url: URL, method: string, s: string[], body: Json, origin: string, repo: Repo): void {
  const head = s[0];
  if (head === undefined) {
    if (method === 'GET') return reply(res, 200, repoJson(origin, repo));
    if (method === 'PATCH') return reply(res, 200, repoJson(origin, updateRepoAction(repo, body)));
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return sendJson(res, 204, undefined, SCOPES);
    }
    throw notFound();
  }
  switch (head) {
    case 'issues':
      return issuesRoute(res, url, method, s, body, origin, repo);
    case 'pulls':
      return pullsRoute(res, url, method, s, body, origin, repo);
    case 'contents':
      return contentsRoute(res, url, method, s.slice(1), body, origin, repo);
    case 'labels':
      return labelsRoute(res, url, method, s, body, origin, repo);
    case 'branches':
      return branchesRoute(res, url, method, s, origin, repo);
    case 'commits':
      return commitsRoute(res, url, method, s, origin, repo);
    case 'git':
      return gitRoute(res, method, s, body, origin, repo);
    default:
      throw notFound();
  }
}

// ---- labels

function labelsRoute(res: ServerResponse, url: URL, method: string, s: string[], body: Json, origin: string, repo: Repo): void {
  if (s.length === 1) {
    if (method === 'GET') return sendPage(res, origin, url, [...repo.labels.values()].map((l) => labelJson(origin, repo, l)));
    if (method === 'POST') return reply(res, 201, labelJson(origin, repo, createLabelAction(repo, { name: body.name, color: body.color, description: body.description })));
    throw notFound();
  }
  if (s.length === 2) {
    const label = repo.labels.get(decode(s[1]).toLowerCase());
    if (label === undefined) throw notFound();
    if (method === 'GET') return reply(res, 200, labelJson(origin, repo, label));
    if (method === 'DELETE') {
      repo.labels.delete(label.name.toLowerCase());
      for (const issue of repo.issues.values()) issue.labels = issue.labels.filter((n) => n.toLowerCase() !== label.name.toLowerCase());
      return sendJson(res, 204, undefined, SCOPES);
    }
  }
  throw notFound();
}

// ---- issues

function issuesRoute(res: ServerResponse, url: URL, method: string, s: string[], body: Json, origin: string, repo: Repo): void {
  if (s.length === 1) {
    if (method === 'GET') {
      const q = url.searchParams;
      const issues = listIssuesAction(repo, { state: q.get('state') ?? undefined, sort: q.get('sort') ?? undefined, direction: q.get('direction') ?? undefined, labels: q.get('labels') ?? undefined });
      return sendPage(res, origin, url, issues.map((i) => issueJson(origin, repo, i)));
    }
    if (method === 'POST') return reply(res, 201, issueJson(origin, repo, createIssueAction(repo, body as Parameters<typeof createIssueAction>[1])));
    throw notFound();
  }
  const number = numberSegment(s[1]);
  if (s.length === 2) {
    if (method === 'GET') return reply(res, 200, issueJson(origin, repo, requireIssue(repo, number)));
    if (method === 'PATCH') {
      const issue = requireIssue(repo, number);
      return reply(res, 200, issueJson(origin, repo, updateIssueAction(repo, issue, body)));
    }
    throw notFound();
  }
  if (s.length === 3 && s[2] === 'comments') {
    const target = repo.issues.get(number) ?? repo.pulls.get(number);
    if (target === undefined) throw notFound();
    if (method === 'GET') return sendPage(res, origin, url, target.comments.map((c) => commentJson(origin, repo, c)));
    if (method === 'POST') return reply(res, 201, commentJson(origin, repo, addCommentAction(repo, number, body.body)));
  }
  throw notFound();
}

// ---- pulls

function pullsRoute(res: ServerResponse, url: URL, method: string, s: string[], body: Json, origin: string, repo: Repo): void {
  if (s.length === 1) {
    if (method === 'GET') {
      const q = url.searchParams;
      const state = q.get('state') ?? 'open';
      const headFilter = q.get('head');
      const baseFilter = q.get('base');
      const asc = q.get('direction') === 'asc';
      let pulls = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === (state === 'closed' ? 'closed' : 'open'));
      if (headFilter !== null && headFilter !== '') {
        const wanted = headFilter.includes(':') ? headFilter.slice(headFilter.indexOf(':') + 1) : headFilter;
        pulls = pulls.filter((p) => p.head === wanted);
      }
      if (baseFilter !== null && baseFilter !== '') pulls = pulls.filter((p) => p.base === baseFilter);
      pulls.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
      return sendPage(res, origin, url, pulls.map((p) => pullJson(origin, repo, p)));
    }
    if (method === 'POST') return reply(res, 201, pullJson(origin, repo, createPullAction(repo, body as Parameters<typeof createPullAction>[1])));
    throw notFound();
  }
  const number = numberSegment(s[1]);
  const pull = requirePull(repo, number);
  if (s.length === 2) {
    if (method === 'GET') return reply(res, 200, pullJson(origin, repo, pull));
    if (method === 'PATCH') return reply(res, 200, pullJson(origin, repo, updatePullAction(repo, pull, body)));
    throw notFound();
  }
  if (s.length === 3) {
    const sub = s[2];
    if (sub === 'merge') {
      if (method === 'PUT') return reply(res, 200, mergePullAction(repo, pull, body));
      if (method === 'GET') {
        if (pull.merged) return sendJson(res, 204, undefined, SCOPES);
        throw notFound();
      }
    }
    if (sub === 'files' && method === 'GET') {
      refreshPull(repo, pull);
      let base = pull.baseSha;
      if (!pull.merged) {
        const tip = git.resolveRef(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
        base = git.mergeBase(repo, tip, pull.headSha) ?? pull.baseSha;
      }
      const files = git.diffCommits(repo, base, pull.headSha).map((f) => ({
        sha: f.sha,
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: `${origin}/${repo.owner.login}/${repo.name}/blob/${pull.headSha}/${f.filename}`,
        raw_url: `${origin}/${repo.owner.login}/${repo.name}/raw/${pull.headSha}/${f.filename}`,
        contents_url: `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${f.filename}?ref=${pull.headSha}`,
        patch: f.patch,
      }));
      return sendPage(res, origin, url, files);
    }
    if (sub === 'comments' && method === 'GET') return sendPage(res, origin, url, pull.comments.map((c) => commentJson(origin, repo, c)));
    if (sub === 'commits' && method === 'GET') {
      refreshPull(repo, pull);
      const baseTip = git.resolveRef(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
      const stop = pull.merged ? pull.baseSha : git.mergeBase(repo, baseTip, pull.headSha) ?? pull.baseSha;
      const list = git.listCommits(repo, pull.headSha, 250);
      const out: Json[] = [];
      for (const entry of list) {
        if (entry.sha === stop) break;
        out.push(commitJson(origin, repo, entry.sha, entry.info));
      }
      out.reverse();
      return sendPage(res, origin, url, out);
    }
  }
  throw notFound();
}

// ---- branches, commits, git refs

function branchJson(origin: string, repo: Repo, name: string, sha: string): Json {
  return {
    name,
    commit: { sha, url: `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function branchesRoute(res: ServerResponse, url: URL, method: string, s: string[], origin: string, repo: Repo): void {
  if (method !== 'GET') throw notFound();
  if (s.length === 1) return sendPage(res, origin, url, git.listBranches(repo).map((b) => branchJson(origin, repo, b.name, b.sha)));
  const name = s.slice(1).map(decode).join('/');
  const sha = git.resolveRef(repo, `refs/heads/${name}`);
  if (sha === undefined) throw new HttpError(404, 'Branch not found');
  return reply(res, 200, branchJson(origin, repo, name, sha));
}

function personJson(sig: git.Signature): Json {
  return { name: sig.name, email: sig.email, date: sig.date };
}

function commitJson(origin: string, repo: Repo, sha: string, info: git.CommitInfo): Json {
  const api = `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}`;
  return {
    sha,
    node_id: nodeId('Commit', Number.parseInt(sha.slice(0, 12), 16)),
    commit: {
      author: personJson(git.parseSignature(info.author)),
      committer: personJson(git.parseSignature(info.committer)),
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}/git/trees/${info.tree}` },
      comment_count: 0,
    },
    url: api,
    html_url: `${origin}/${repo.owner.login}/${repo.name}/commit/${sha}`,
    author: null,
    committer: null,
    parents: info.parents.map((p) => ({ sha: p, url: `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${p}` })),
  };
}

function commitsRoute(res: ServerResponse, url: URL, method: string, s: string[], origin: string, repo: Repo): void {
  if (method !== 'GET') throw notFound();
  if (s.length >= 2) {
    const ref = s.slice(1).map(decode).join('/');
    const sha = git.resolveRef(repo, `refs/heads/${ref}`) ?? git.resolveRef(repo, ref);
    if (sha === undefined) throw new HttpError(404, `No commit found for SHA: ${ref}`);
    const entry = git.listCommits(repo, sha, 1)[0];
    if (entry === undefined) throw notFound();
    return reply(res, 200, commitJson(origin, repo, entry.sha, entry.info));
  }
  const requested = url.searchParams.get('sha');
  const start = requested === null || requested === '' ? git.resolveRef(repo, `refs/heads/${repo.defaultBranch}`) : (git.resolveRef(repo, `refs/heads/${requested}`) ?? git.resolveRef(repo, requested));
  if (start === undefined) {
    if (requested === null || requested === '') throw new HttpError(409, 'Git Repository is empty.');
    throw new HttpError(404, `No commit found for SHA: ${requested}`);
  }
  const { page, perPage } = pageOf(url);
  const all = git.listCommits(repo, start, page * perPage + 1);
  const items = all.map((c) => commitJson(origin, repo, c.sha, c.info));
  // The history is read one past the page, so a longer list means a next page.
  const hasNext = all.length > page * perPage;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = { ...SCOPES };
  if (hasNext) headers.link = `<${linkTo(origin, url, page + 1)}>; rel="next"`;
  sendJson(res, 200, slice, headers);
}

function refJson(origin: string, repo: Repo, ref: string, sha: string): Json {
  const api = `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}`;
  return {
    ref,
    node_id: nodeId('Ref', Number.parseInt(sha.slice(0, 12), 16)),
    url: `${api}/git/${ref}`,
    object: { sha, type: 'commit', url: `${api}/git/commits/${sha}` },
  };
}

function gitRoute(res: ServerResponse, method: string, s: string[], body: Json, origin: string, repo: Repo): void {
  const kind = s[1];
  if (kind === 'refs' && s.length === 2) {
    if (method === 'POST') {
      const ref = body.ref;
      const sha = body.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || sha === '') throw validation('Reference', 'ref', 'invalid');
      if (repo.git.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
      const target = git.readObject(repo, sha.toLowerCase());
      if (target === undefined || target.type !== 'commit') throw new HttpError(422, 'Object does not exist');
      git.updateRef(repo, ref, sha.toLowerCase());
      repo.pushedAt = store.now();
      return reply(res, 201, refJson(origin, repo, ref, sha.toLowerCase()));
    }
    if (method === 'GET') {
      const out: Json[] = [];
      for (const [ref, sha] of [...repo.git.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push(refJson(origin, repo, ref, sha));
      return reply(res, 200, out);
    }
    throw notFound();
  }
  if ((kind === 'refs' || kind === 'ref') && s.length > 2) {
    const ref = `refs/${s.slice(2).map(decode).join('/')}`;
    const sha = repo.git.refs.get(ref);
    if (method === 'GET') {
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      return reply(res, 200, refJson(origin, repo, ref, sha));
    }
    if (method === 'PATCH') {
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      const next = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      const target = git.readObject(repo, next);
      if (target === undefined || target.type !== 'commit') throw new HttpError(422, 'Object does not exist');
      if (body.force !== true && !git.isAncestor(repo, sha, next)) throw new HttpError(422, 'Update is not a fast forward');
      git.updateRef(repo, ref, next);
      return reply(res, 200, refJson(origin, repo, ref, next));
    }
    if (method === 'DELETE') {
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      git.updateRef(repo, ref, null);
      return sendJson(res, 204, undefined, SCOPES);
    }
  }
  throw notFound();
}

// ---- contents

function contentLinks(origin: string, repo: Repo, path: string, sha: string, ref: string): Json {
  const api = `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}`;
  return {
    url: `${api}/contents/${path}?ref=${ref}`,
    html_url: `${origin}/${repo.owner.login}/${repo.name}/blob/${ref}/${path}`,
    git_url: `${api}/git/blobs/${sha}`,
    download_url: `${origin}/${repo.owner.login}/${repo.name}/raw/${ref}/${path}`,
  };
}

function contentEntryJson(origin: Origin, repo: Repo, path: string, kind: 'file' | 'dir', sha: string, size: number, ref: string): Json {
  return { type: kind, name: path.slice(path.lastIndexOf('/') + 1), path, sha, size, ...contentLinks(origin, repo, path, sha, ref) };
}

type Origin = string;

function contentsRoute(res: ServerResponse, url: URL, method: string, parts: string[], body: Json, origin: string, repo: Repo): void {
  const path = parts.map(decode).join('/');
  if (method === 'GET') {
    const refName = url.searchParams.get('ref');
    const sha = refName === null || refName === '' ? git.resolveRef(repo, `refs/heads/${repo.defaultBranch}`) : (git.resolveRef(repo, `refs/heads/${refName}`) ?? git.resolveRef(repo, refName));
    if (sha === undefined) throw notFound();
    const entry = git.readPath(repo, sha, path);
    if (entry === undefined) throw notFound();
    const ref = refName === null || refName === '' ? repo.defaultBranch : refName;
    if (entry.kind === 'blob') {
      return reply(res, 200, { ...contentEntryJson(origin, repo, path, 'file', entry.sha, entry.data.length, ref), encoding: 'base64', content: entry.data.toString('base64') });
    }
    const list = entry.entries.map((e) => {
      const full = path === '' ? e.name : `${path}/${e.name}`;
      const isDir = e.mode === '40000' || e.mode === '040000';
      const size = isDir ? 0 : (git.readObject(repo, e.sha)?.body.length ?? 0);
      return contentEntryJson(origin, repo, full, isDir ? 'dir' : 'file', e.sha, size, ref);
    });
    return reply(res, 200, list);
  }
  if (path === '') throw notFound();
  if (method !== 'PUT' && method !== 'DELETE') throw notFound();
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  if (typeof body.message !== 'string' || body.message === '') throw validation('Contents', 'message', 'missing_field');
  const tip = git.resolveRef(repo, `refs/heads/${branch}`);
  if (tip === undefined && branch !== repo.defaultBranch) throw new HttpError(404, 'Branch not found');
  const existing = tip === undefined ? undefined : git.readPath(repo, tip, path);
  if (existing !== undefined && existing.kind === 'tree') throw validation('Contents', 'path', 'invalid');
  const givenSha = typeof body.sha === 'string' && body.sha !== '' ? body.sha.toLowerCase() : undefined;
  let content: Buffer | null;
  if (method === 'PUT') {
    if (typeof body.content !== 'string') throw validation('Contents', 'content', 'missing_field');
    content = Buffer.from(body.content, 'base64');
    if (existing !== undefined) {
      if (givenSha === undefined) throw new HttpError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
      if (givenSha !== existing.sha) throw new HttpError(409, `${path} does not match ${existing.sha}`);
    } else if (givenSha !== undefined) {
      throw new HttpError(409, `${path} does not match`);
    }
  } else {
    if (existing === undefined) throw notFound();
    if (givenSha === undefined) throw validation('Contents', 'sha', 'missing_field');
    if (givenSha !== existing.sha) throw new HttpError(409, `${path} does not match ${existing.sha}`);
    content = null;
  }
  const result = git.commitChange(repo, { branch, path, content, message: body.message });
  const at = store.now();
  repo.pushedAt = at;
  repo.updatedAt = at;
  const info = git.readObject(repo, result.commitSha);
  const commit: Json = { sha: result.commitSha, url: `${origin}/api/v3/repos/${repo.owner.login}/${repo.name}/git/commits/${result.commitSha}`, message: body.message };
  if (info !== undefined) commit.tree = { sha: git.parseCommit(info.body).tree };
  if (method === 'DELETE') return reply(res, 200, { content: null, commit });
  const blobSha = result.blobSha ?? '';
  return reply(res, existing === undefined ? 201 : 200, {
    content: { ...contentEntryJson(origin, repo, path, 'file', blobSha, (content as Buffer).length, branch), encoding: 'base64' },
    commit,
  });
}

// keep the simple-user builder reachable for tests that import it from here
export { simpleUserJson };
