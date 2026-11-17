import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.ts';
import * as git from '../src/git/repo.ts';
import { HttpError } from '../src/http.ts';
import { store } from '../src/store.ts';
import {
  addCommentAction,
  createIssueAction,
  createLabelAction,
  createRepoAction,
  issueJson,
  listIssuesAction,
  nodeId,
  repoJson,
  requireIssue,
  requireRepo,
  updateIssueAction,
} from '../src/actions.ts';

const gitReady = typeof git.commitChange === 'function';
const ORIGIN = 'http://127.0.0.1:1';

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
  return 0;
}

test('nodeId is stable and opaque', () => {
  assert.equal(nodeId('Repository', 7), nodeId('Repository', 7));
  assert.notEqual(nodeId('Repository', 7), nodeId('Issue', 7));
  assert.equal(Buffer.from(nodeId('Repository', 7), 'base64').toString(), 'Repository:7');
});

test('repo creation validates and rejects duplicates', () => {
  const repo = createRepoAction({ name: 'unit-repo-a', description: 'd', private: true });
  assert.equal(repo.private, true);
  assert.equal(requireRepo(store.viewer.login, 'unit-repo-a'), repo);
  assert.equal(status(() => createRepoAction({ name: 'unit-repo-a' })), 422);
  assert.equal(status(() => createRepoAction({ name: 'bad name' })), 422);
  assert.equal(status(() => requireRepo('someone-else', 'unit-repo-a')), 404);
  const json = repoJson(ORIGIN, repo);
  assert.equal(json.full_name, `${store.viewer.login}/unit-repo-a`);
  assert.equal(json.default_branch, 'main');
});

test('issues: labels must exist, numbering, state, sorting, comments', () => {
  const repo = createRepoAction({ name: 'unit-repo-issues' });
  assert.equal(status(() => createIssueAction(repo, { title: 't', labels: ['nope'] })), 422);
  assert.equal(status(() => createIssueAction(repo, { title: '' })), 422);
  createLabelAction(repo, { name: 'Bug', color: '#FF0000' });
  assert.equal(status(() => createLabelAction(repo, { name: 'bug' })), 422);
  const a = createIssueAction(repo, { title: 'a', body: 'x', labels: ['bug'] });
  const b = createIssueAction(repo, { title: 'b' });
  assert.equal(b.number, a.number + 1);
  assert.deepEqual(a.labels, ['Bug']);
  assert.equal((issueJson(ORIGIN, repo, a).labels as Array<{ name: string }>)[0].name, 'Bug');
  updateIssueAction(repo, requireIssue(repo, a.number), { state: 'closed' });
  assert.deepEqual(listIssuesAction(repo, { state: 'open' }).map((i) => i.number), [b.number]);
  assert.deepEqual(listIssuesAction(repo, { state: 'all', sort: 'created', direction: 'asc' }).map((i) => i.number), [a.number, b.number]);
  assert.deepEqual(listIssuesAction(repo, { state: 'all' }).map((i) => i.number), [b.number, a.number]);
  const c = addCommentAction(repo, a.number, 'hello');
  assert.equal(c.body, 'hello');
  assert.equal(status(() => addCommentAction(repo, 999, 'x')), 404);
  assert.equal(status(() => updateIssueAction(repo, a, { state: 'weird' })), 422);
});

async function call(base: string, method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${store.token || 'test'}`;
  const res = await fetch(`${base}/api/v3${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text), headers: res.headers };
}

test('HTTP: protocol basics, repos CRUD, pagination, issues', async () => {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const root = await call(base, 'GET', '/');
    assert.equal(root.status, 200);
    assert.ok(root.headers.get('x-oauth-scopes'));
    assert.ok(root.headers.get('x-github-request-id'));
    assert.equal((await call(base, 'GET', '/', undefined, false)).status, 401);
    assert.equal((await call(base, 'GET', '/nothing/here')).status, 404);
    assert.equal((await call(base, 'POST', '/user/repos', '{"name":')).status, 400);
    assert.equal((await call(base, 'GET', '/meta')).json.installed_version.length > 0, true);
    assert.equal((await call(base, 'GET', '/user')).json.login, store.viewer.login);

    for (let i = 0; i < 5; i += 1) assert.equal((await call(base, 'POST', '/user/repos', { name: `http-page-${i}` })).status, 201);
    const page = await call(base, 'GET', '/user/repos?per_page=2');
    assert.equal(page.json.length, 2);
    assert.match(page.headers.get('link') ?? '', /rel="next"/);

    const owner = store.viewer.login;
    const repoPath = `/repos/${owner}/http-page-0`;
    assert.equal((await call(base, 'PATCH', repoPath, { description: 'new' })).json.description, 'new');
    assert.equal((await call(base, 'GET', `/repos/someone-else/http-page-0`)).status, 404);

    assert.equal((await call(base, 'POST', `${repoPath}/issues`, { title: 't', labels: ['x'] })).status, 422);
    assert.equal((await call(base, 'POST', `${repoPath}/labels`, { name: 'x' })).status, 201);
    const issue = await call(base, 'POST', `${repoPath}/issues`, { title: 't', body: 'b', labels: ['x'] });
    assert.equal(issue.status, 201);
    assert.equal(issue.json.state, 'open');
    assert.equal(issue.json.labels[0].name, 'x');
    assert.equal((await call(base, 'PATCH', `${repoPath}/issues/${issue.json.number}`, { state: 'closed' })).json.state, 'closed');
    assert.equal((await call(base, 'GET', `${repoPath}/issues?state=open`)).json.length, 0);
    const comment = await call(base, 'POST', `${repoPath}/issues/${issue.json.number}/comments`, { body: 'hi' });
    assert.equal(comment.status, 201);
    assert.equal((await call(base, 'GET', `${repoPath}/issues/${issue.json.number}/comments`)).json[0].body, 'hi');

    assert.equal((await call(base, 'DELETE', repoPath)).status, 204);
    assert.equal((await call(base, 'GET', repoPath)).status, 404);
  } finally {
    server.close();
  }
});

test('HTTP: contents, branches and pull requests (needs the git layer)', { skip: !gitReady }, async () => {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const owner = store.viewer.login;
    await call(base, 'POST', '/user/repos', { name: 'git-flow' });
    const p = `/repos/${owner}/git-flow`;
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const put = await call(base, 'PUT', `${p}/contents/docs/a.txt`, { message: 'm', content: b64('one') });
    assert.equal(put.status, 201);
    const sha: string = put.json.content.sha;
    const stale = await call(base, 'PUT', `${p}/contents/docs/a.txt`, { message: 'm', content: b64('two'), sha: 'f'.repeat(40) });
    assert.equal(stale.status, 409);
    const upd = await call(base, 'PUT', `${p}/contents/docs/a.txt`, { message: 'm', content: b64('two'), sha });
    assert.equal(upd.status, 200);
    const got = await call(base, 'GET', `${p}/contents/docs/a.txt`);
    assert.equal(Buffer.from(got.json.content, 'base64').toString(), 'two');
    assert.equal((await call(base, 'GET', `${p}/contents/docs`)).json[0].name, 'a.txt');
    const tip = upd.json.commit.sha;
    assert.equal((await call(base, 'POST', `${p}/git/refs`, { ref: 'refs/heads/feat', sha: tip })).status, 201);
    await call(base, 'PUT', `${p}/contents/docs/b.txt`, { message: 'b', content: b64('bee'), branch: 'feat' });
    const pull = await call(base, 'POST', `${p}/pulls`, { title: 'T', body: 'B', head: 'feat', base: 'main' });
    assert.equal(pull.status, 201);
    assert.equal(pull.json.state, 'open');
    const files = await call(base, 'GET', `${p}/pulls/${pull.json.number}/files`);
    assert.equal(files.json[0].filename, 'docs/b.txt');
    const merged = await call(base, 'PUT', `${p}/pulls/${pull.json.number}/merge`, { merge_method: 'squash' });
    assert.equal(merged.status, 200);
    assert.equal(merged.json.merged, true);
    const after = await call(base, 'GET', `${p}/pulls/${pull.json.number}`);
    assert.equal(after.json.merged, true);
    assert.equal(after.json.merge_commit_sha, merged.json.sha);
    assert.equal((await call(base, 'PUT', `${p}/pulls/9999/merge`, {})).status, 404);
  } finally {
    server.close();
  }
});
