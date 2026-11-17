// The MCP tool catalogue and its handlers. Handlers call the shared domain actions (loaded lazily, so
// this module stays loadable while those are being written) and answer the same JSON shapes REST does.

import { store } from '../store.ts';

type Json = Record<string, unknown>;

/** A refusal of a tool call: isError by default, or a JSON-RPC error when `rpcCode` is set. */
export class ToolFailure extends Error {
  readonly rpcCode: number | undefined;
  constructor(message: string, rpcCode?: number) {
    super(message);
    this.rpcCode = rpcCode;
  }
}

interface Prop {
  type: string;
  description: string;
  enum?: string[];
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Prop>; required: string[]; additionalProperties: boolean };
}

function tool(name: string, description: string, properties: Record<string, Prop>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const OWNER: Prop = { type: 'string', description: 'Repository owner (user login).' };
const REPO: Prop = { type: 'string', description: 'Repository name.' };

const DEFS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    auto_init: { type: 'boolean', description: 'Create an initial commit with a README.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { owner: OWNER, repo: REPO }, ['owner', 'repo']),
  tool('list_repos', 'List the repositories of the authenticated user, oldest first.', {}, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: OWNER, repo: REPO,
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body text.' },
    labels: { type: 'array', description: 'Label names to apply.' },
    assignees: { type: 'array', description: 'Logins to assign.' },
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by number.', { owner: OWNER, repo: REPO, issue_number: { type: 'integer', description: 'Issue number.' } }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: OWNER, repo: REPO,
    state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
    labels: { type: 'string', description: 'Comma-separated label names.' },
    sort: { type: 'string', description: 'Sort field: created, updated or comments.' },
    direction: { type: 'string', description: 'Sort direction: asc or desc.' },
  }, ['owner', 'repo']),
  tool('update_issue', 'Update an issue: title, body, state or labels.', {
    owner: OWNER, repo: REPO,
    issue_number: { type: 'integer', description: 'Issue number.' },
    title: { type: 'string', description: 'New title.' },
    body: { type: 'string', description: 'New body.' },
    state: { type: 'string', description: 'New state.', enum: ['open', 'closed'] },
    state_reason: { type: 'string', description: 'Reason for the state change.' },
    labels: { type: 'array', description: 'Replacement label names.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('add_issue_comment', 'Add a comment to an issue or pull request.', {
    owner: OWNER, repo: REPO,
    issue_number: { type: 'integer', description: 'Issue or pull request number.' },
    body: { type: 'string', description: 'Comment text.' },
  }, ['owner', 'repo', 'issue_number', 'body']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: OWNER, repo: REPO,
    title: { type: 'string', description: 'Pull request title.' },
    head: { type: 'string', description: 'Branch holding the changes.' },
    base: { type: 'string', description: 'Branch to merge into.' },
    body: { type: 'string', description: 'Pull request description.' },
    draft: { type: 'boolean', description: 'Open as a draft.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('get_pull_request', 'Get one pull request by number.', { owner: OWNER, repo: REPO, pull_number: { type: 'integer', description: 'Pull request number.' } }, ['owner', 'repo', 'pull_number']),
  tool('list_pull_requests', 'List the pull requests of a repository.', {
    owner: OWNER, repo: REPO,
    state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge an open pull request.', {
    owner: OWNER, repo: REPO,
    pull_number: { type: 'integer', description: 'Pull request number.' },
    commit_title: { type: 'string', description: 'Title for the merge commit.' },
    commit_message: { type: 'string', description: 'Message for the merge commit.' },
    merge_method: { type: 'string', description: 'Merge method.', enum: ['merge', 'squash', 'rebase'] },
  }, ['owner', 'repo', 'pull_number']),
];

/** The fixed tools/list answer: built once, so every call serializes identically. */
export const TOOLS: ToolDef[] = DEFS;

type Actions = typeof import('../actions.ts');
let actionsModule: Promise<Actions> | null = null;
function actions(): Promise<Actions> {
  actionsModule ??= import('../actions.ts');
  return actionsModule;
}

function reqString(args: Json, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ToolFailure(`missing required argument: ${key}`);
  return v;
}

function optString(args: Json, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolFailure(`argument ${key} must be a string`);
  return v;
}

function reqNumber(args: Json, key: string): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new ToolFailure(`missing or invalid required argument: ${key}`);
  return n;
}

function optBool(args: Json, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolFailure(`argument ${key} must be a boolean`);
  return v;
}

function textResult(value: unknown): Json {
  const result: Json = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

/** Run one tool. Throws ToolFailure (or HttpError from an action) on a refusal. */
export async function callTool(name: string, args: Json, origin: string): Promise<Json> {
  if (!DEFS.some((d) => d.name === name)) throw new ToolFailure(`Unknown tool: ${name}`, -32602);
  const def = DEFS.find((d) => d.name === name)!;
  for (const key of def.inputSchema.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw new ToolFailure(`missing required argument: ${key}`);
  }
  const A = await actions();

  switch (name) {
    case 'create_repo': {
      const repo = A.createRepoAction({
        name: reqString(args, 'name'),
        description: optString(args, 'description') ?? null,
        private: optBool(args, 'private'),
        auto_init: optBool(args, 'auto_init'),
      });
      return textResult(A.repoJson(origin, repo));
    }
    case 'get_repo':
      return textResult(A.repoJson(origin, A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'))));
    case 'list_repos':
      return textResult(store.listRepos().map((r) => A.repoJson(origin, r)));
    case 'create_issue': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const issue = A.createIssueAction(repo, { title: reqString(args, 'title'), body: args.body, labels: args.labels, assignees: args.assignees });
      return textResult(A.issueJson(origin, repo, issue));
    }
    case 'get_issue': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      return textResult(A.issueJson(origin, repo, A.requireIssue(repo, reqNumber(args, 'issue_number'))));
    }
    case 'list_issues': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const issues = A.listIssuesAction(repo, {
        state: optString(args, 'state'),
        sort: optString(args, 'sort'),
        direction: optString(args, 'direction'),
        labels: optString(args, 'labels'),
      });
      return textResult(issues.map((i) => A.issueJson(origin, repo, i)));
    }
    case 'update_issue': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const issue = A.requireIssue(repo, reqNumber(args, 'issue_number'));
      const updated = A.updateIssueAction(repo, issue, { title: args.title, body: args.body, state: args.state, state_reason: args.state_reason, labels: args.labels });
      return textResult(A.issueJson(origin, repo, updated));
    }
    case 'add_issue_comment': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const comment = A.addCommentAction(repo, reqNumber(args, 'issue_number'), reqString(args, 'body'));
      return textResult(A.commentJson(origin, repo, comment));
    }
    case 'create_pull_request': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const pull = A.createPullAction(repo, { title: reqString(args, 'title'), body: args.body, head: reqString(args, 'head'), base: reqString(args, 'base'), draft: args.draft });
      return textResult(A.pullJson(origin, repo, pull));
    }
    case 'get_pull_request': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      return textResult(A.pullJson(origin, repo, A.requirePull(repo, reqNumber(args, 'pull_number'))));
    }
    case 'list_pull_requests': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const state = optString(args, 'state') ?? 'open';
      const pulls = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state).sort((a, b) => b.number - a.number);
      return textResult(pulls.map((p) => A.pullJson(origin, repo, p)));
    }
    case 'merge_pull_request': {
      const repo = A.requireRepo(reqString(args, 'owner'), reqString(args, 'repo'));
      const pull = A.requirePull(repo, reqNumber(args, 'pull_number'));
      const merged = A.mergePullAction(repo, pull, { commit_title: args.commit_title, commit_message: args.commit_message, merge_method: args.merge_method, sha: args.sha });
      return textResult(merged);
    }
    default:
      throw new ToolFailure(`Unknown tool: ${name}`, -32602);
  }
}
