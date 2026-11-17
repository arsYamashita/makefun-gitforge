import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';
import * as actions from '../src/actions.ts';
import * as git from '../src/git/repo.ts';
import { store } from '../src/store.ts';
import { GraphQLSyntaxError, parse, tokenize } from '../src/graphql/parser.ts';
import { decodeId, idOf } from '../src/graphql/resolvers.ts';
import { runBody, runOperation } from '../src/graphql/index.ts';

const ctx = { origin: 'http://test.invalid' };
const run = (query: string, variables?: Record<string, unknown>, operationName?: string): any => runOperation({ query, variables, operationName }, ctx);
const haveActions = typeof (actions as Record<string, unknown>).createIssueAction === 'function';

const repo = store.createRepo({ name: 'gql-unit' });
for (let i = 1; i <= 6; i += 1) store.createIssue(repo, { title: `issue ${i}`, body: `body ${i}` });
repo.issues.get(2)!.state = 'closed';
const repoId = idOf('Repository', repo.id);

describe('parser', () => {
  test('tokenizes punctuation, numbers, strings and skips commas and comments', () => {
    const kinds = tokenize('{ a(b: 1.5e3, c: "x\\ny") # note\n }').map((t) => `${t.kind}:${t.value}`);
    assert.deepEqual(kinds, ['punct:{', 'name:a', 'punct:(', 'name:b', 'punct::', 'float:1.5e3', 'name:c', 'punct::', 'string:x\ny', 'punct:)', 'punct:}', 'eof:<EOF>']);
  });

  test('parses operations, variables, aliases, fragments and directives', () => {
    const doc = parse(`query Q($a: Int = 3, $b: [String!]!) @x { al: f(x: $a, y: {k: [1, ENUM, null]}) @skip(if: true) { ...F ... on T { z } } }
      fragment F on T { id }`);
    assert.equal(doc.operations.length, 1);
    const op = doc.operations[0];
    assert.equal(op.name, 'Q');
    assert.equal(op.variables.length, 2);
    assert.equal(op.variables[1].type.kind, 'NonNull');
    const field = op.selectionSet[0];
    assert.equal(field.kind, 'Field');
    if (field.kind === 'Field') {
      assert.equal(field.alias, 'al');
      assert.equal(field.name, 'f');
      assert.equal(field.directives[0].name, 'skip');
      assert.equal(field.selectionSet?.length, 2);
    }
    assert.ok(doc.fragments.has('F'));
  });

  test('shorthand queries and block strings', () => {
    const doc = parse('{ f(s: """\n  hi\n   there\n""") }');
    const f = doc.operations[0].selectionSet[0];
    assert.equal(f.kind === 'Field' && f.args[0].value.kind === 'String' && f.args[0].value.value, 'hi\n there');
  });

  test('syntax errors carry a location', () => {
    assert.throws(() => parse('{ a '), (e: unknown) => e instanceof GraphQLSyntaxError && e.locations[0].line === 1);
    assert.throws(() => parse('query { }'), GraphQLSyntaxError);
    assert.throws(() => parse('{ a(b: "x) }'), GraphQLSyntaxError);
  });
});

describe('execution', () => {
  test('viewer, aliases and __typename', () => {
    const r = run('{ me: viewer { who: login __typename } }');
    assert.deepEqual(r, { data: { me: { who: store.viewer.login, __typename: 'User' } } });
  });

  test('variables with defaults and @skip / @include', () => {
    const q = 'query($n: String!, $s: Boolean = false) { repository(owner: "adaiversen", name: $n) { name @skip(if: $s) id @include(if: $s) } }';
    assert.deepEqual(run(q, { n: 'gql-unit' }).data.repository, { name: 'gql-unit' });
    assert.deepEqual(Object.keys(run(q, { n: 'gql-unit', s: true }).data.repository), ['id']);
    const missing = run(q, {});
    assert.ok(missing.errors[0].message.includes('$n'));
  });

  test('fragments and inline fragments on interfaces', () => {
    const r = run(`query($id: ID!) { node(id: $id) { id ...R ... on Repository { nameWithOwner } } } fragment R on Repository { name }`, { id: repoId });
    assert.equal(r.errors, undefined);
    assert.equal(r.data.node.id, repoId);
    assert.equal(r.data.node.name, 'gql-unit');
    assert.equal(r.data.node.nameWithOwner, `${store.viewer.login}/gql-unit`);
  });

  test('unknown field is an error naming it and no data', () => {
    const r = run('{ viewer { login noSuchField } }');
    assert.equal(r.data, undefined);
    assert.ok(r.errors[0].message.includes('noSuchField'));
  });

  test('unknown repository is null without errors', () => {
    const r = run('{ repository(owner: "adaiversen", name: "nope") { id } }');
    assert.deepEqual(r, { data: { repository: null } });
  });

  test('issues filter by state, order by CREATED_AT DESC and page by cursor', () => {
    const q = `query($first: Int!, $after: String) { repository(owner: "adaiversen", name: "gql-unit") {
      issues(first: $first, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { number state } pageInfo { hasNextPage endCursor } totalCount } } }`;
    const page1 = run(q, { first: 3, after: null }).data.repository.issues;
    assert.deepEqual(page1.nodes.map((n: any) => n.number), [6, 5, 4]);
    assert.equal(page1.pageInfo.hasNextPage, true);
    const page2 = run(q, { first: 3, after: page1.pageInfo.endCursor }).data.repository.issues;
    assert.deepEqual(page2.nodes.map((n: any) => n.number), [3, 1]);
    assert.equal(page2.pageInfo.hasNextPage, false);
    assert.equal(page2.totalCount, 5);
  });

  test('issue(number) reads fields and a missing number is a NOT_FOUND error', () => {
    const r = run('{ repository(owner: "adaiversen", name: "gql-unit") { issue(number: 1) { number title state body id databaseId } } }');
    const issue = r.data.repository.issue;
    assert.equal(issue.title, 'issue 1');
    assert.equal(issue.state, 'OPEN');
    assert.equal(issue.databaseId, repo.issues.get(1)!.id);
    assert.notEqual(issue.id, String(1));
    const miss = run('{ repository(owner: "adaiversen", name: "gql-unit") { issue(number: 99) { number } } }');
    assert.equal(miss.data.repository.issue, null);
    assert.equal(miss.errors[0].type, 'NOT_FOUND');
  });

  test('repository fields and viewerPermission', () => {
    const r = run('{ repository(owner: "adaiversen", name: "gql-unit") { databaseId owner { login } viewerPermission hasIssuesEnabled defaultBranchRef { name } } }');
    assert.equal(r.data.repository.viewerPermission, 'ADMIN');
    assert.equal(r.data.repository.hasIssuesEnabled, true);
    assert.equal(r.data.repository.defaultBranchRef, null);
    assert.equal(r.data.repository.owner.login, store.viewer.login);
  });

  test('global ids round-trip', () => {
    const d = decodeId(repoId);
    assert.deepEqual(d, { kind: 'Repository', n: repo.id });
    assert.equal(decodeId('garbage'), null);
  });

  test('two operations in a JSON array answer in order', () => {
    const out = runBody([{ query: '{ viewer { login } }' }, { query: '{ __type(name: "Issue") { fields { name } } }' }], ctx) as any[];
    assert.equal(out.length, 2);
    assert.equal(out[0].data.viewer.login, store.viewer.login);
    assert.ok(out[1].data.__type.fields.some((f: any) => f.name === 'title'));
  });

  test('a document with several operations needs operationName', () => {
    const q = 'query A { viewer { login } } query B { rateLimit { limit } }';
    assert.ok(run(q).errors[0].message.includes('operation name'));
    assert.equal(run(q, {}, 'B').data.rateLimit.limit, 5000);
  });

  test('search finds issues by text and state', () => {
    const r = run('{ search(query: "repo:adaiversen/gql-unit is:open issue", type: ISSUE, first: 10) { issueCount nodes { ... on Issue { number } } } }');
    assert.equal(r.data.search.issueCount, 5);
  });

  test('syntax error is reported as errors', () => {
    const r = run('{ viewer { ');
    assert.ok(r.errors[0].message.startsWith('Syntax Error'));
  });
});

describe('introspection', () => {
  const names = (list: any[]): string[] => list.map((x) => x.name);

  test('Issue, PullRequest and Repository list the required fields', () => {
    const r = run('{ Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } PullRequest: __type(name: "PullRequest") { fields { name } } Repository: __type(name: "Repository") { kind name fields { name type { kind name ofType { name } } } } }');
    for (const f of ['id', 'number', 'title', 'state', 'body']) assert.ok(names(r.data.Issue.fields).includes(f), f);
    for (const f of ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']) assert.ok(names(r.data.PullRequest.fields).includes(f), f);
    for (const f of ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) assert.ok(names(r.data.Repository.fields).includes(f), f);
    assert.equal(r.data.Repository.kind, 'OBJECT');
    const id = r.data.Repository.fields.find((f: any) => f.name === 'id');
    assert.equal(id.type.kind, 'NON_NULL');
    assert.equal(id.type.ofType.name, 'ID');
  });

  test('SearchType enum values include ISSUE; unknown type is null', () => {
    const r = run('{ SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } nope: __type(name: "Nope") { name } }');
    assert.ok(names(r.data.SearchType.enumValues).includes('ISSUE'));
    assert.equal(r.data.nope, null);
  });

  test('__schema lists types, root types and interfaces possibleTypes', () => {
    const r = run('{ __schema { queryType { name } mutationType { name } types { name kind } } Node: __type(name: "Node") { kind possibleTypes { name } } }');
    assert.equal(r.data.__schema.queryType.name, 'Query');
    assert.equal(r.data.__schema.mutationType.name, 'Mutation');
    assert.ok(r.data.__schema.types.some((t: any) => t.name === 'Issue' && t.kind === 'OBJECT'));
    assert.ok(names(r.data.Node.possibleTypes).includes('Repository'));
  });

  test('input objects list inputFields', () => {
    const r = run('{ __type(name: "CreateIssueInput") { kind inputFields { name } } }');
    assert.equal(r.data.__type.kind, 'INPUT_OBJECT');
    assert.ok(names(r.data.__type.inputFields).includes('repositoryId'));
  });
});

describe('mutations', { skip: haveActions ? false : 'the shared actions are not implemented yet' }, () => {
  test('createIssue, addComment and closeIssue act on the store', () => {
    const created = run('mutation($i: CreateIssueInput!) { createIssue(input: $i) { issue { number id state } } }', { i: { repositoryId: repoId, title: 'made over graphql', body: 'b' } });
    assert.equal(created.errors, undefined);
    const issue = created.data.createIssue.issue;
    assert.equal(issue.state, 'OPEN');
    assert.equal(repo.issues.get(issue.number)!.title, 'made over graphql');
    const commented = run('mutation($i: AddCommentInput!) { addComment(input: $i) { commentEdge { node { id body } } } }', { i: { subjectId: issue.id, body: 'hello' } });
    assert.equal(commented.data.addComment.commentEdge.node.body, 'hello');
    const closed = run('mutation($i: CloseIssueInput!) { closeIssue(input: $i) { issue { number state } } }', { i: { issueId: issue.id } });
    assert.equal(closed.data.closeIssue.issue.state, 'CLOSED');
    assert.equal(repo.issues.get(issue.number)!.state, 'closed');
  });

  test('a mutation with an unknown id reports a NOT_FOUND error', () => {
    const r = run('mutation($i: CloseIssueInput!) { closeIssue(input: $i) { issue { number } } }', { i: { issueId: 'bm9wZQ==' } });
    assert.equal(r.data.closeIssue, null);
    assert.equal(r.errors[0].type, 'NOT_FOUND');
  });
});

describe('pull requests', { skip: haveActions && typeof (git as Record<string, unknown>).commitChange === 'function' ? false : 'actions or git are not implemented yet' }, () => {
  test('create, list, files and squash merge', () => {
    const pr = store.createRepo({ name: 'gql-pulls' });
    git.commitChange(pr, { branch: 'main', path: 'a.txt', content: Buffer.from('a'), message: 'first' });
    git.updateRef(pr, 'refs/heads/feat', git.resolveRef(pr, 'main') as string);
    git.commitChange(pr, { branch: 'feat', path: 'b.txt', content: Buffer.from('b'), message: 'second' });
    const created = run('mutation($i: CreatePullRequestInput!) { createPullRequest(input: $i) { pullRequest { number id state headRefName baseRefName } } }', {
      i: { repositoryId: idOf('Repository', pr.id), baseRefName: 'main', headRefName: 'feat', title: 'add b' },
    });
    assert.equal(created.errors, undefined);
    const pull = created.data.createPullRequest.pullRequest;
    assert.equal(pull.state, 'OPEN');
    assert.equal(pull.headRefName, 'feat');
    const read = run(`{ repository(owner: "adaiversen", name: "gql-pulls") { defaultBranchRef { name }
      pullRequests(first: 5) { nodes { number mergeable } } pullRequest(number: ${pull.number}) { files(first: 10) { nodes { path } } } } }`).data.repository;
    assert.equal(read.defaultBranchRef.name, 'main');
    assert.equal(read.pullRequests.nodes[0].mergeable, 'MERGEABLE');
    assert.deepEqual(read.pullRequest.files.nodes, [{ path: 'b.txt' }]);
    const merged = run('mutation($i: MergePullRequestInput!) { mergePullRequest(input: $i) { pullRequest { merged state } } }', { i: { pullRequestId: pull.id, mergeMethod: 'SQUASH' } });
    assert.deepEqual(merged.data.mergePullRequest.pullRequest, { merged: true, state: 'MERGED' });
  });
});

describe('http', () => {
  let server: Server;
  let base = '';
  before(async () => {
    server = createApp();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });

  test('401 without authorization', async () => {
    const res = await fetch(`${base}/api/graphql`, { method: 'POST', body: JSON.stringify({ query: '{ viewer { login } }' }) });
    assert.equal(res.status, 401);
  });

  test('200 with a token, single and batched', async () => {
    const headers = { authorization: `Bearer ${store.token || 'x'}`, 'content-type': 'application/json' };
    const one = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body: JSON.stringify({ query: '{ viewer { login } }' }) });
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as any).data.viewer.login, store.viewer.login);
    const many = await fetch(`${base}/api/graphql`, { method: 'POST', headers, body: JSON.stringify([{ query: '{ viewer { login } }' }, { query: '{ viewer { nope } }' }]) });
    const body = (await many.json()) as any[];
    assert.equal(body.length, 2);
    assert.ok(body[1].errors[0].message.includes('nope'));
  });

  test('malformed JSON is 400', async () => {
    const res = await fetch(`${base}/api/graphql`, { method: 'POST', headers: { authorization: `Bearer ${store.token || 'x'}` }, body: '{' });
    assert.equal(res.status, 400);
  });
});
