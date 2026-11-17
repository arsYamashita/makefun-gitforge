// The GraphQL schema description. It drives validation, execution and introspection, so what
// __type and __schema report is exactly what the executor accepts.

export interface TypeRef {
  k: 'NAMED' | 'LIST' | 'NON_NULL';
  name?: string;
  of?: TypeRef;
}

export interface ArgDef {
  name: string;
  type: TypeRef;
}

export interface FieldDef {
  name: string;
  type: TypeRef;
  args: ArgDef[];
}

export type TypeKind = 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';

export interface TypeDef {
  kind: TypeKind;
  name: string;
  fields: Map<string, FieldDef>;
  interfaces: string[];
  possible: string[];
  enumValues: string[];
  inputFields: ArgDef[];
}

const refCache = new Map<string, TypeRef>();

export function parseTypeRef(text: string): TypeRef {
  const cached = refCache.get(text);
  if (cached !== undefined) return cached;
  let ref: TypeRef;
  if (text.endsWith('!')) ref = { k: 'NON_NULL', of: parseTypeRef(text.slice(0, -1)) };
  else if (text.startsWith('[') && text.endsWith(']')) ref = { k: 'LIST', of: parseTypeRef(text.slice(1, -1)) };
  else ref = { k: 'NAMED', name: text };
  refCache.set(text, ref);
  return ref;
}

export function namedType(ref: TypeRef): string {
  let cur = ref;
  while (cur.k !== 'NAMED') cur = cur.of as TypeRef;
  return cur.name as string;
}

type FieldSpec = string | [string, Record<string, string>];
type FieldsSpec = Record<string, FieldSpec>;

export const TYPES = new Map<string, TypeDef>();

function blank(kind: TypeKind, name: string): TypeDef {
  const def: TypeDef = { kind, name, fields: new Map(), interfaces: [], possible: [], enumValues: [], inputFields: [] };
  TYPES.set(name, def);
  return def;
}

function addFields(def: TypeDef, spec: FieldsSpec): void {
  for (const [name, value] of Object.entries(spec)) {
    const [type, args] = typeof value === 'string' ? [value, {}] : value;
    def.fields.set(name, {
      name,
      type: parseTypeRef(type),
      args: Object.entries(args).map(([argName, argType]) => ({ name: argName, type: parseTypeRef(argType) })),
    });
  }
}

function scalar(name: string): void {
  blank('SCALAR', name);
}

function enumType(name: string, values: string[]): void {
  blank('ENUM', name).enumValues = values;
}

function object(name: string, fields: FieldsSpec, interfaces: string[] = []): void {
  const def = blank('OBJECT', name);
  def.interfaces = interfaces;
  addFields(def, fields);
}

function iface(name: string, fields: FieldsSpec): void {
  addFields(blank('INTERFACE', name), fields);
}

function union(name: string, members: string[]): void {
  blank('UNION', name).possible = members;
}

function input(name: string, fields: Record<string, string>): void {
  blank('INPUT_OBJECT', name).inputFields = Object.entries(fields).map(([n, t]) => ({ name: n, type: parseTypeRef(t) }));
}

function connection(node: string, extra: FieldsSpec = {}): void {
  object(`${node}Edge`, { cursor: 'String!', node });
  object(`${node}Connection`, {
    edges: `[${node}Edge]`,
    nodes: `[${node}]`,
    pageInfo: 'PageInfo!',
    totalCount: 'Int!',
    ...extra,
  });
}

const PAGE_ARGS = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

for (const name of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML']) scalar(name);

enumType('IssueState', ['OPEN', 'CLOSED']);
enumType('IssueStateReason', ['REOPENED', 'NOT_PLANNED', 'COMPLETED']);
enumType('IssueClosedStateReason', ['COMPLETED', 'NOT_PLANNED']);
enumType('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']);
enumType('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
enumType('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']);
enumType('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
enumType('SearchType', ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION']);
enumType('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
enumType('OrderDirection', ['ASC', 'DESC']);
enumType('PatchStatus', ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED']);
enumType('__TypeKind', ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL']);
enumType('__DirectiveLocation', ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'VARIABLE_DEFINITION']);

iface('Node', { id: 'ID!' });
iface('Actor', { login: 'String!', url: 'URI!', avatarUrl: 'URI!' });
iface('RepositoryOwner', { id: 'ID!', login: 'String!', url: 'URI!', avatarUrl: 'URI!' });
union('SearchResultItem', ['Issue', 'PullRequest', 'Repository']);
union('IssueOrPullRequest', ['Issue', 'PullRequest']);

object('PageInfo', { hasNextPage: 'Boolean!', hasPreviousPage: 'Boolean!', startCursor: 'String', endCursor: 'String' });
object('User', {
  id: 'ID!', databaseId: 'Int', login: 'String!', name: 'String', email: 'String!', url: 'URI!', avatarUrl: 'URI!', createdAt: 'DateTime!',
}, ['Node', 'Actor', 'RepositoryOwner']);
object('Label', { id: 'ID!', name: 'String!', color: 'String!', description: 'String' }, ['Node']);
object('Commit', { oid: 'GitObjectID!', abbreviatedOid: 'String!' }, []);
object('Ref', { name: 'String!', prefix: 'String!', target: 'Commit' });
object('PullRequestChangedFile', { path: 'String!', additions: 'Int!', deletions: 'Int!', changeType: 'PatchStatus!' });
object('RateLimit', { limit: 'Int!', cost: 'Int!', remaining: 'Int!', nodeCount: 'Int!', resetAt: 'DateTime!', used: 'Int!' });

connection('Label');
connection('User');
connection('IssueComment');
connection('PullRequestChangedFile');

object('IssueComment', {
  id: 'ID!', databaseId: 'Int', body: 'String!', bodyText: 'String!', author: 'Actor', createdAt: 'DateTime!', updatedAt: 'DateTime!', url: 'URI!',
}, ['Node']);

const COMMON_THREAD: FieldsSpec = {
  id: 'ID!',
  databaseId: 'Int',
  number: 'Int!',
  title: 'String!',
  body: 'String!',
  bodyText: 'String!',
  url: 'URI!',
  createdAt: 'DateTime!',
  updatedAt: 'DateTime!',
  closedAt: 'DateTime',
  closed: 'Boolean!',
  locked: 'Boolean!',
  author: 'Actor',
  repository: 'Repository!',
  comments: ['IssueCommentConnection!', PAGE_ARGS],
  labels: ['LabelConnection', PAGE_ARGS],
  assignees: ['UserConnection!', PAGE_ARGS],
};

object('Issue', {
  ...COMMON_THREAD,
  state: 'IssueState!',
  stateReason: 'IssueStateReason',
}, ['Node']);

object('PullRequest', {
  ...COMMON_THREAD,
  state: 'PullRequestState!',
  merged: 'Boolean!',
  mergedAt: 'DateTime',
  mergeable: 'MergeableState!',
  isDraft: 'Boolean!',
  headRefName: 'String!',
  baseRefName: 'String!',
  headRefOid: 'GitObjectID!',
  baseRefOid: 'GitObjectID!',
  mergeCommit: 'Commit',
  additions: 'Int!',
  deletions: 'Int!',
  changedFiles: 'Int!',
  files: ['PullRequestChangedFileConnection', PAGE_ARGS],
}, ['Node']);

connection('Issue');
connection('PullRequest');
connection('SearchResultItem', { issueCount: 'Int!', repositoryCount: 'Int!', userCount: 'Int!' });

object('Repository', {
  id: 'ID!',
  databaseId: 'Int',
  name: 'String!',
  nameWithOwner: 'String!',
  owner: 'RepositoryOwner!',
  description: 'String',
  url: 'URI!',
  homepageUrl: 'URI',
  isPrivate: 'Boolean!',
  isFork: 'Boolean!',
  isArchived: 'Boolean!',
  createdAt: 'DateTime!',
  updatedAt: 'DateTime!',
  pushedAt: 'DateTime',
  stargazerCount: 'Int!',
  defaultBranchRef: 'Ref',
  viewerPermission: 'RepositoryPermission',
  hasIssuesEnabled: 'Boolean!',
  issue: ['Issue', { number: 'Int!' }],
  issues: ['IssueConnection!', { ...PAGE_ARGS, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]' }],
  pullRequests: ['PullRequestConnection!', { ...PAGE_ARGS, states: '[PullRequestState!]', orderBy: 'IssueOrder', baseRefName: 'String', headRefName: 'String', labels: '[String!]' }],
  pullRequest: ['PullRequest', { number: 'Int!' }],
  issueOrPullRequest: ['IssueOrPullRequest', { number: 'Int!' }],
}, ['Node']);

input('IssueOrder', { field: 'IssueOrderField!', direction: 'OrderDirection!' });
input('CreateIssueInput', { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', assigneeIds: '[ID!]', clientMutationId: 'String' });
input('CloseIssueInput', { issueId: 'ID!', stateReason: 'IssueClosedStateReason', clientMutationId: 'String' });
input('ReopenIssueInput', { issueId: 'ID!', clientMutationId: 'String' });
input('UpdateIssueInput', { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' });
input('AddCommentInput', { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' });
input('CreatePullRequestInput', { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' });
input('MergePullRequestInput', { pullRequestId: 'ID!', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' });
input('ClosePullRequestInput', { pullRequestId: 'ID!', clientMutationId: 'String' });

object('CreateIssuePayload', { clientMutationId: 'String', issue: 'Issue' });
object('CloseIssuePayload', { clientMutationId: 'String', issue: 'Issue' });
object('ReopenIssuePayload', { clientMutationId: 'String', issue: 'Issue' });
object('UpdateIssuePayload', { clientMutationId: 'String', issue: 'Issue' });
object('AddCommentPayload', { clientMutationId: 'String', commentEdge: 'IssueCommentEdge', subject: 'Node' });
object('CreatePullRequestPayload', { clientMutationId: 'String', pullRequest: 'PullRequest' });
object('MergePullRequestPayload', { clientMutationId: 'String', pullRequest: 'PullRequest' });
object('ClosePullRequestPayload', { clientMutationId: 'String', pullRequest: 'PullRequest' });

// Introspection types.
object('__Schema', {
  description: 'String',
  types: '[__Type!]!',
  queryType: '__Type!',
  mutationType: '__Type',
  subscriptionType: '__Type',
  directives: '[__Directive!]!',
});
object('__Type', {
  kind: '__TypeKind!',
  name: 'String',
  description: 'String',
  fields: ['[__Field!]', { includeDeprecated: 'Boolean' }],
  interfaces: '[__Type!]',
  possibleTypes: '[__Type!]',
  enumValues: ['[__EnumValue!]', { includeDeprecated: 'Boolean' }],
  inputFields: ['[__InputValue!]', { includeDeprecated: 'Boolean' }],
  ofType: '__Type',
  specifiedByURL: 'String',
});
object('__Field', {
  name: 'String!', description: 'String', args: ['[__InputValue!]!', { includeDeprecated: 'Boolean' }], type: '__Type!', isDeprecated: 'Boolean!', deprecationReason: 'String',
});
object('__InputValue', { name: 'String!', description: 'String', type: '__Type!', defaultValue: 'String', isDeprecated: 'Boolean!', deprecationReason: 'String' });
object('__EnumValue', { name: 'String!', description: 'String', isDeprecated: 'Boolean!', deprecationReason: 'String' });
object('__Directive', { name: 'String!', description: 'String', locations: '[__DirectiveLocation!]!', args: '[__InputValue!]!', isRepeatable: 'Boolean!' });

object('Query', {
  viewer: 'User!',
  repository: ['Repository', { owner: 'String!', name: 'String!', followRenames: 'Boolean' }],
  repositoryOwner: ['RepositoryOwner', { login: 'String!' }],
  user: ['User', { login: 'String!' }],
  node: ['Node', { id: 'ID!' }],
  nodes: ['[Node]!', { ids: '[ID!]!' }],
  search: ['SearchResultItemConnection!', { query: 'String!', type: 'SearchType!', ...PAGE_ARGS }],
  rateLimit: ['RateLimit', { dryRun: 'Boolean' }],
  __schema: '__Schema!',
  __type: ['__Type', { name: 'String!' }],
});

object('Mutation', {
  createIssue: ['CreateIssuePayload', { input: 'CreateIssueInput!' }],
  closeIssue: ['CloseIssuePayload', { input: 'CloseIssueInput!' }],
  reopenIssue: ['ReopenIssuePayload', { input: 'ReopenIssueInput!' }],
  updateIssue: ['UpdateIssuePayload', { input: 'UpdateIssueInput!' }],
  addComment: ['AddCommentPayload', { input: 'AddCommentInput!' }],
  createPullRequest: ['CreatePullRequestPayload', { input: 'CreatePullRequestInput!' }],
  mergePullRequest: ['MergePullRequestPayload', { input: 'MergePullRequestInput!' }],
  closePullRequest: ['ClosePullRequestPayload', { input: 'ClosePullRequestInput!' }],
});

export function getType(name: string): TypeDef | undefined {
  return TYPES.get(name);
}

/** Whether an object type `runtime` can appear where `condition` (object, interface or union) is named. */
export function typeApplies(runtime: string, condition: string): boolean {
  if (runtime === condition) return true;
  const cond = TYPES.get(condition);
  const def = TYPES.get(runtime);
  if (cond === undefined || def === undefined) return false;
  if (cond.kind === 'INTERFACE') return def.interfaces.includes(condition);
  if (cond.kind === 'UNION') return cond.possible.includes(runtime);
  return false;
}

/** Object types implementing an interface, in declaration order. */
export function implementors(name: string): string[] {
  const out: string[] = [];
  for (const def of TYPES.values()) if (def.kind === 'OBJECT' && def.interfaces.includes(name)) out.push(def.name);
  return out;
}

export function isLeaf(name: string): boolean {
  const def = TYPES.get(name);
  return def !== undefined && (def.kind === 'SCALAR' || def.kind === 'ENUM');
}

export const DIRECTIVES: { name: string; description: string; locations: string[]; args: ArgDef[] }[] = [
  { name: 'skip', description: 'Directs the executor to skip this field or fragment when the `if` argument is true.', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', type: parseTypeRef('Boolean!') }] },
  { name: 'include', description: 'Directs the executor to include this field or fragment only when the `if` argument is true.', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', type: parseTypeRef('Boolean!') }] },
];
