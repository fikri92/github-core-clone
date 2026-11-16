// The GitHub GraphQL v4 surface: a minimal parser and executor over the in-memory store.
import type { Ctx } from './http.ts';
import { methodNotAllowed, sendJson, sendMessage } from './http.ts';
import {
  NOW, NOW_EPOCH, branchSha, buildTree, flattenTree, getObj, getRepo, nextCommentId, nextIssueId,
  nextPullId, parseCommit, putCommit, repos, setBranch, viewer,
  type Comment, type Issue, type Pull, type Repo,
} from './store.ts';

// ------------------------------------------------------------------ lexer
type TokenType = 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
interface Token { type: TokenType; value: string }

function lex(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isName = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (c === '.') {
      if (source.startsWith('...', i)) { out.push({ type: 'spread', value: '...' }); i += 3; continue; }
      i += 1; continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const raw = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        out.push({ type: 'string', value: raw });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      i += 1;
      let buf = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const next = source[i + 1] ?? '';
          i += 2;
          if (next === 'n') buf += '\n';
          else if (next === 't') buf += '\t';
          else if (next === 'r') buf += '\r';
          else if (next === 'b') buf += '\b';
          else if (next === 'f') buf += '\f';
          else if (next === 'u') {
            const hex = source.slice(i, i + 4);
            buf += String.fromCharCode(parseInt(hex, 16) || 63);
            i += 4;
          } else buf += next;
          continue;
        }
        buf += source[i];
        i += 1;
      }
      i += 1;
      out.push({ type: 'string', value: buf });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') { j += 1; while (j < source.length && /[0-9]/.test(source[j])) j += 1; }
      if (source[j] === 'e' || source[j] === 'E') { j += 1; if (source[j] === '+' || source[j] === '-') j += 1; while (j < source.length && /[0-9]/.test(source[j])) j += 1; }
      out.push({ type: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isName(source[j])) j += 1;
      out.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    out.push({ type: 'punct', value: c });
    i += 1;
  }
  out.push({ type: 'eof', value: '' });
  return out;
}

// ------------------------------------------------------------------ AST and parser
type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface Selection {
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selections: Selection[];
  typeCondition: string | null;
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: Selection[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token { return this.tokens[this.pos] ?? { type: 'eof', value: '' }; }
  private next(): Token { const token = this.peek(); this.pos += 1; return token; }
  private atPunct(value: string): boolean { const token = this.peek(); return token.type === 'punct' && token.value === value; }
  private eatPunct(value: string): boolean { if (this.atPunct(value)) { this.pos += 1; return true; } return false; }
  private atName(value: string): boolean { const token = this.peek(); return token.type === 'name' && token.value === value; }
  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new ParseError(`expected "${value}" but found ${JSON.stringify(this.peek().value)}`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.type !== 'name') throw new ParseError(`expected a name but found ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Operation {
    let operation: Operation | null = null;
    while (this.peek().type !== 'eof') {
      if (this.atPunct('{')) {
        operation = { type: 'query', name: null, selections: this.parseSelectionSet() };
        continue;
      }
      const keyword = this.peek();
      if (keyword.type === 'name' && keyword.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (!this.atName('on')) throw new ParseError('expected "on" in a fragment definition');
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, selections });
        continue;
      }
      if (keyword.type === 'name' && (keyword.value === 'query' || keyword.value === 'mutation' || keyword.value === 'subscription')) {
        this.next();
        const type = keyword.value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().type === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipBalanced('(', ')');
        operation = { type, name, selections: this.parseSelectionSet() };
        continue;
      }
      throw new ParseError(`unexpected token ${JSON.stringify(keyword.value)}`);
    }
    if (operation === null) throw new ParseError('the document holds no operation');
    return operation;
  }

  /** Expand named fragment spreads in place (the documents here use inline fragments only). */
  expand(selections: Selection[]): Selection[] {
    const out: Selection[] = [];
    for (const selection of selections) {
      if (selection.name === '__fragmentSpread' && selection.alias !== null) {
        const fragment = this.fragments.get(selection.alias);
        if (fragment === undefined) throw new ParseError(`unknown fragment ${selection.alias}`);
        out.push(...this.expand(fragment.selections).map((inner) => ({ ...inner })));
        continue;
      }
      out.push({ ...selection, selections: this.expand(selection.selections) });
    }
    return out;
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0 && this.peek().type !== 'eof') {
      const token = this.next();
      if (token.type === 'punct' && token.value === open) depth += 1;
      else if (token.type === 'punct' && token.value === close) depth -= 1;
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.eatPunct('}')) {
      if (this.peek().type === 'eof') throw new ParseError('unterminated selection set');
      if (this.peek().type === 'spread') {
        this.next();
        if (this.atName('on')) {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ alias: null, name: '__inline', args: new Map(), selections: this.parseSelectionSet(), typeCondition });
          continue;
        }
        if (this.atPunct('{') || this.atPunct('@')) {
          const selections2 = this.parseSelectionSet();
          selections.push({ alias: null, name: '__inline', args: new Map(), selections: selections2, typeCondition: null });
          continue;
        }
        const name = this.expectName();
        if (this.atPunct('@')) this.skipDirectives();
        selections.push({ alias: name, name: '__fragmentSpread', args: new Map(), selections: [], typeCondition: null });
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.eatPunct(':')) { alias = name; name = this.expectName(); }
      const args = this.atPunct('(') ? this.parseArguments() : new Map<string, GqlValue>();
      if (this.atPunct('@')) this.skipDirectives();
      const inner = this.atPunct('{') ? this.parseSelectionSet() : [];
      selections.push({ alias, name, args, selections: inner, typeCondition: null });
    }
    return selections;
  }

  private skipDirectives(): void {
    while (this.eatPunct('@')) {
      this.expectName();
      if (this.atPunct('(')) this.skipBalanced('(', ')');
    }
  }

  parseArguments(): Map<string, GqlValue> {
    this.expectPunct('(');
    const args = new Map<string, GqlValue>();
    while (!this.eatPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  parseValue(): GqlValue {
    const token = this.peek();
    if (token.type === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'var', name: this.expectName() };
    }
    if (token.type === 'string') { this.next(); return { kind: 'string', value: token.value }; }
    if (token.type === 'number') { this.next(); return { kind: 'number', value: Number(token.value) }; }
    if (token.type === 'punct' && token.value === '[') {
      this.next();
      const items: GqlValue[] = [];
      while (!this.eatPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.type === 'punct' && token.value === '{') {
      this.next();
      const fields = new Map<string, GqlValue>();
      while (!this.eatPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.type === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ------------------------------------------------------------------ values, ids, schema
type Variables = Record<string, unknown>;

class GqlError extends Error {}

function valueOf(value: GqlValue | undefined, vars: Variables): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'var': return vars[value.name];
    case 'string': return value.value;
    case 'number': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.items.map((item) => valueOf(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = valueOf(inner, vars);
      return out;
    }
    default: return undefined;
  }
}

function arg(args: Map<string, GqlValue>, name: string, vars: Variables): unknown {
  return valueOf(args.get(name), vars);
}

function str(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback; }
function num(v: unknown, fallback = 0): number { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function intOrNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** A Relay global id: base64 of `04:<Type><numeric id>`, opaque to the client and stable across reads. */
function encodeId(type: string, id: number): string {
  return Buffer.from(`04:${type}${id}`, 'utf8').toString('base64');
}

function decodeId(raw: unknown): { type: string; id: number } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const direct = /^(\d+)$/.exec(raw);
  if (direct !== null) return { type: '', id: Number(direct[1]) };
  let text: string;
  try { text = Buffer.from(raw, 'base64').toString('utf8'); } catch { return null; }
  const match = /^(?:\d+:)?([A-Za-z_]+)(\d+)$/.exec(text);
  if (match === null) return null;
  return { type: match[1], id: Number(match[2]) };
}

function encodeCursor(value: number): string {
  return Buffer.from(`cursor:${value}`, 'utf8').toString('base64');
}

function decodeCursor(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch { return null; }
}

function findRepoByNodeId(raw: unknown): Repo | undefined {
  const decoded = decodeId(raw);
  if (decoded === null) return undefined;
  for (const repo of repos.values()) if (repo.id === decoded.id) return repo;
  return undefined;
}

function findIssueByNodeId(raw: unknown): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeId(raw);
  if (decoded === null) return undefined;
  for (const repo of repos.values()) {
    for (const issue of repo.issues) if (issue.id === decoded.id) return { repo, issue };
  }
  return undefined;
}

function findPullByNodeId(raw: unknown): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeId(raw);
  if (decoded === null) return undefined;
  for (const repo of repos.values()) {
    for (const pull of repo.pulls) if (pull.id === decoded.id) return { repo, pull };
  }
  return undefined;
}

const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled',
  'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'refs',
  'branches', 'labels', 'milestones', 'stargazerCount', 'forkCount', 'visibility', 'isArchived', 'isEmpty',
];
const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'stateReason', 'closed', 'author', 'createdAt', 'updatedAt',
  'closedAt', 'comments', 'labels', 'assignees', 'milestone', 'url', 'isPinned', 'locked', 'includesCreatedEdit',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'mergeStateStatus',
  'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid', 'files', 'commits', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'isDraft', 'url', 'comments', 'reviews', 'reviewDecision', 'additions',
  'deletions', 'changedFiles',
];
const USER_FIELDS = ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'isViewer', 'databaseId', 'createdAt'];
const REF_FIELDS = ['name', 'target', 'prefix', 'repository'];
const PAGE_INFO_FIELDS = ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'];
const ISSUE_CONNECTION_FIELDS = ['nodes', 'edges', 'pageInfo', 'totalCount'];
const PULL_CONNECTION_FIELDS = ['nodes', 'edges', 'pageInfo', 'totalCount'];
const CHANGED_FILE_FIELDS = ['path', 'additions', 'deletions', 'changeType'];
const CHANGED_FILE_CONNECTION_FIELDS = ['nodes', 'edges', 'pageInfo', 'totalCount'];
const COMMENT_FIELDS = ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'isMinimized'];
const COMMENT_EDGE_FIELDS = ['node', 'cursor'];
const PAYLOAD_FIELDS: Record<string, string[]> = {
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject', 'timelineEdge'],
};
const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', 'relay'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssueComment', 'deleteIssueComment'],
  Repository: REPOSITORY_FIELDS,
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  User: USER_FIELDS,
  Ref: REF_FIELDS,
  PageInfo: PAGE_INFO_FIELDS,
  IssueConnection: ISSUE_CONNECTION_FIELDS,
  PullRequestConnection: PULL_CONNECTION_FIELDS,
  PullRequestChangedFile: CHANGED_FILE_FIELDS,
  PullRequestChangedFileConnection: CHANGED_FILE_CONNECTION_FIELDS,
  IssueComment: COMMENT_FIELDS,
  IssueCommentEdge: COMMENT_EDGE_FIELDS,
  ...PAYLOAD_FIELDS,
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueStateFilter: ['OPEN', 'CLOSED'],
  CommentAuthorAssociation: ['MEMBER', 'OWNER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'],
};

// ------------------------------------------------------------------ execution
interface GNode { type: string; data: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNode(value: unknown): GNode | null {
  if (value === null || value === undefined) return null;
  if (isRecord(value) && typeof value.type === 'string' && 'data' in value) return value as unknown as GNode;
  return null;
}

function child(node: GNode): Record<string, unknown> {
  return isRecord(node.data) ? node.data : {};
}

function typeOf(node: GNode): string { return node.type; }

function resolveSet(node: GNode, selections: Selection[], vars: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.name === '__inline') {
      if (selection.typeCondition !== null && !matchesType(node, selection.typeCondition)) continue;
      Object.assign(out, resolveSet(node, selection.selections, vars));
      continue;
    }
    if (selection.name === '__fragmentSpread') throw new GqlError(`unknown fragment ${String(selection.alias)}`);
    const key = selection.alias ?? selection.name;
    const value = resolveField(node, selection.name, selection.args, selection.selections, vars);
    out[key] = materialize(value, selection.selections, vars);
  }
  return out;
}

/** Turn a resolver's answer into JSON: a GNode resolves its own selection set, arrays elementwise. */
function materialize(value: unknown, selections: Selection[], vars: Variables): unknown {
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, selections, vars));
  if (isRecord(value) && typeof (value as unknown as GNode).type === 'string' && 'data' in (value as unknown as GNode)) {
    const node = value as unknown as GNode;
    if (selections.length === 0) return node.data as unknown;
    return resolveSet(node, selections, vars);
  }
  return value;
}

function matchesType(node: GNode, condition: string): boolean {
  return node.type === condition || condition === 'Node' || condition === 'RepositoryOwner';
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function fieldNames(type: string): string[] {
  if (type.startsWith('__')) return [];
  return SCHEMA_FIELDS[type] ?? [];
}

function resolveField(node: GNode, name: string, args: Map<string, GqlValue>, selections: Selection[], vars: Variables): unknown {
  if (name === '__typename') return node.type;
  const data = child(node);
  if (node.type === 'Query' || node.type === 'Mutation') return resolveRoot(node.type, name, args, selections, vars);
  if (node.type === '__Type' || node.type === '__Field' || node.type === '__EnumValue' || node.type === '__Schema') {
    return resolveIntrospection(node, name, vars, selections);
  }
  if (node.type === 'PageInfo') {
    switch (name) {
      case 'hasNextPage': return Boolean(data.hasNextPage);
      case 'hasPreviousPage': return Boolean(data.hasPreviousPage);
      case 'endCursor': return data.endCursor ?? null;
      case 'startCursor': return data.startCursor ?? null;
      default: break;
    }
    throw new GqlError(`Field '${name}' doesn't exist on type 'PageInfo'`);
  }
  if (node.type === 'IssueConnection' || node.type === 'PullRequestConnection' || node.type === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') return (data.nodes as GNode[] | undefined) ?? [];
    if (name === 'totalCount') return typeof data.totalCount === 'number' ? data.totalCount : 0;
    if (name === 'pageInfo') return { type: 'PageInfo', data: data.pageInfo ?? {} } satisfies GNode;
    if (name === 'edges') return ((data.edges as { cursor: string; node: GNode }[] | undefined) ?? []).map((edge) => ({ cursor: edge.cursor, node: edge.node }));
    throw new GqlError(`Field '${name}' doesn't exist on type '${node.type}'`);
  }
  if (node.type === 'IssueCommentEdge') {
    if (name === 'node') return asNode(data.node);
    if (name === 'cursor') return data.cursor ?? null;
    throw new GqlError(`Field '${name}' doesn't exist on type 'IssueCommentEdge'`);
  }
  if (node.type === 'IssueComment') {
    const comment = data.comment as Comment;
    switch (name) {
      case 'id': return encodeId('IssueComment', comment.id);
      case 'body': return comment.body;
      case 'author': return userNode(comment.user.login);
      case 'createdAt': return comment.created_at;
      case 'updatedAt': return comment.updated_at;
      case 'url': return `http://entry/comment/${comment.id}`;
      case 'isMinimized': return false;
      default: throw new GqlError(`Field '${name}' doesn't exist on type 'IssueComment'`);
    }
  }
  if (node.type === 'Repository') return resolveRepository(node.data as Repo, name, args, selections, vars);
  if (node.type === 'Issue') return resolveIssue(data.issue as Issue, name, args, selections, vars);
  if (node.type === 'PullRequest') return resolvePullRequest(data.pull as Pull, name, args, selections, vars);
  if (node.type === 'User') {
    const login = str(data.login);
    switch (name) {
      case 'login': return login;
      case 'id': return encodeId('User', num(data.id, login.length));
      case 'databaseId': return num(data.id, 0);
      case 'name': return data.name ?? login;
      case 'email': return data.email ?? `${login}@example.invalid`;
      case 'avatarUrl': return `http://entry/avatars/${login}.png`;
      case 'url': return `http://entry/${login}`;
      case 'isViewer': return login === viewer.login;
      case 'createdAt': return NOW;
      default: throw new GqlError(`Field '${name}' doesn't exist on type 'User'`);
    }
  }
  if (node.type === 'Ref') {
    if (name === 'name') return str(data.name);
    if (name === 'prefix') return 'refs/heads/';
    if (name === 'target') {
      const target = data.target as GNode | undefined;
      return target ?? { type: 'Commit', data: { oid: str(data.sha) } };
    }
    if (name === 'repository') return data.repository ?? null;
    throw new GqlError(`Field '${name}' doesn't exist on type 'Ref'`);
  }
  if (name === 'clientMutationId') return data.clientMutationId ?? null;
  if (name in data) return data[name] as unknown;
  throw new GqlError(`Field '${name}' doesn't exist on type '${node.type}'`);
}

function resolveRoot(root: 'Query' | 'Mutation', name: string, args: Map<string, GqlValue>, _selections: Selection[], vars: Variables): unknown {
  if (root === 'Query') {
    switch (name) {
      case 'viewer':
        return { type: 'User', data: { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email } } satisfies GNode;
      case 'user': {
        const login = str(arg(args, 'login', vars));
        if (login === viewer.login) return { type: 'User', data: { login: viewer.login, id: viewer.id, name: viewer.name } } satisfies GNode;
        return null;
      }
      case 'repository': {
        const repo = getRepo(str(arg(args, 'owner', vars)), str(arg(args, 'name', vars)));
        return repo === undefined ? null : ({ type: 'Repository', data: repo } satisfies GNode);
      }
      case 'node': {
        const decoded = decodeId(arg(args, 'id', vars));
        if (decoded === null) return null;
        for (const repo of repos.values()) if (repo.id === decoded.id) return { type: 'Repository', data: repo } satisfies GNode;
        const issue = findIssueByNodeId(arg(args, 'id', vars));
        if (issue !== undefined) return { type: 'Issue', data: { issue: issue.issue } } satisfies GNode;
        const pull = findPullByNodeId(arg(args, 'id', vars));
        if (pull !== undefined) return { type: 'PullRequest', data: { pull: pull.pull } } satisfies GNode;
        return null;
      }
      case '__type': {
        const typeName = str(arg(args, 'name', vars));
        if (!(typeName in SCHEMA_FIELDS) && !(typeName in ENUM_VALUES) && !typeName.startsWith('__')) return null;
        return { type: '__Type', data: { name: typeName } } satisfies GNode;
      }
      case 'rateLimit':
        return { type: 'RateLimit', data: { limit: 5000, remaining: 4999, used: 1, resetAt: NOW } };
      default:
        throw new GqlError(`Field '${name}' doesn't exist on type 'Query'`);
    }
  }
  return resolveMutation(name, args, vars);
}

function userNode(login: string): GNode {
  if (login === viewer.login) return { type: 'User', data: { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email } };
  return { type: 'User', data: { login, id: 2000, name: login, email: `${login}@example.invalid` } };
}

function stateOfIssue(issue: Issue): string { return issue.state === 'closed' ? 'CLOSED' : 'OPEN'; }
function stateOfPull(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function buildConnection(type: string, entries: { cursor: number; node: GNode }[], first: number | null, after: number | null): GNode {
  const total = entries.length;
  let start = 0;
  if (after !== null) {
    const index = entries.findIndex((entry) => entry.cursor === after);
    start = index < 0 ? total : index + 1;
  }
  const end = first === null ? total : Math.min(total, start + Math.max(0, first));
  const slice = entries.slice(start, end);
  const hasNextPage = end < total;
  return {
    type,
    data: {
      nodes: slice.map((entry) => entry.node),
      edges: slice.map((entry) => ({ cursor: encodeCursor(entry.cursor), node: entry.node })),
      totalCount: total,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor: slice.length === 0 ? null : encodeCursor(slice[0].cursor),
        endCursor: slice.length === 0 ? null : encodeCursor(slice[slice.length - 1].cursor),
      },
    },
  };
}

function orderArgs(args: Map<string, GqlValue>, vars: Variables): { field: string; direction: string } {
  const raw = arg(args, 'orderBy', vars);
  let field = 'CREATED_AT';
  let direction = 'DESC';
  if (isRecord(raw)) {
    if (typeof raw.field === 'string') field = raw.field;
    if (typeof raw.direction === 'string') direction = raw.direction;
  }
  return { field, direction };
}

function issueList(repo: Repo, states: string[] | null, order: { field: string; direction: string }): Issue[] {
  let list = repo.issues.slice();
  if (states !== null && states.length > 0) {
    list = list.filter((issue) => states.includes(stateOfIssue(issue)));
  }
  const sign = order.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    if (order.field === 'COMMENTS') return sign * (a.comments.length - b.comments.length) || sign * (a.number - b.number);
    if (order.field === 'UPDATED_AT') return sign * (Date.parse(a.updated_at) - Date.parse(b.updated_at)) || sign * (a.number - b.number);
    return sign * (Date.parse(a.created_at) - Date.parse(b.created_at)) || sign * (a.number - b.number);
  });
  return list;
}

function fileMap(repo: Repo, sha: string): Map<string, { mode: string; sha: string }> {
  const obj = getObj(sha);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree);
}

function changedPaths(repo: Repo, pull: Pull): string[] {
  const base = fileMap(repo, pull.baseSha);
  const head = fileMap(repo, pull.headSha);
  const paths: string[] = [];
  for (const [path, value] of head) if (base.get(path)?.sha !== value.sha) paths.push(path);
  for (const path of base.keys()) if (!head.has(path)) paths.push(path);
  return paths.sort();
}

function resolveRepository(repo: Repo, name: string, args: Map<string, GqlValue>, selections: Selection[], vars: Variables): unknown {
  switch (name) {
    case 'id': return encodeId('Repository', repo.id);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'description': return repo.description;
    case 'isPrivate': return repo.private;
    case 'visibility': return repo.private ? 'PRIVATE' : 'PUBLIC';
    case 'isFork': return false;
    case 'isArchived': return false;
    case 'isEmpty': return repo.refs.size === 0;
    case 'url': return `http://entry/${repo.owner}/${repo.name}`;
    case 'owner': return userNode(repo.owner);
    case 'createdAt': return repo.created_at;
    case 'updatedAt': return repo.updated_at;
    case 'pushedAt': return repo.pushed_at;
    case 'stargazerCount': return 0;
    case 'forkCount': return 0;
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'hasProjectsEnabled': return true;
    case 'hasWikiEnabled': return true;
    case 'defaultBranchRef': {
      const sha = branchSha(repo, repo.defaultBranch);
      if (sha === null) return null;
      return { type: 'Ref', data: { name: repo.defaultBranch, sha } } satisfies GNode;
    }
    case 'issue': {
      const number = intOrNull(arg(args, 'number', vars));
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : ({ type: 'Issue', data: { issue } } satisfies GNode);
    }
    case 'issues': {
      const raw = arg(args, 'states', vars);
      const states = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : null;
      const order = orderArgs(args, vars);
      const first = intOrNull(arg(args, 'first', vars));
      const after = decodeCursor(arg(args, 'after', vars));
      const list = issueList(repo, states, order);
      const entries = list.map((issue) => ({ cursor: issue.number, node: { type: 'Issue', data: { issue } } as GNode }));
      const connection = buildConnection('IssueConnection', entries, first, after);
      return connection;
    }
    case 'pullRequest': {
      const number = intOrNull(arg(args, 'number', vars));
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : ({ type: 'PullRequest', data: { pull } } satisfies GNode);
    }
    case 'pullRequests': {
      const raw = arg(args, 'states', vars);
      const states = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : ['OPEN'];
      let list = repo.pulls.slice();
      if (states.length > 0) list = list.filter((pull) => states.includes(stateOfPull(pull)));
      list.sort((a, b) => b.number - a.number);
      const first = intOrNull(arg(args, 'first', vars));
      const after = decodeCursor(arg(args, 'after', vars));
      const entries = list.map((pull) => ({ cursor: pull.number, node: { type: 'PullRequest', data: { pull } } as GNode }));
      return buildConnection('PullRequestConnection', entries, first, after);
    }
    case 'branches': {
      const entries: { cursor: number; node: GNode }[] = [];
      let index = 0;
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        index += 1;
        entries.push({ cursor: index, node: { type: 'Ref', data: { name: ref.slice(11), sha } } });
      }
      return buildConnection('RefConnection', entries, intOrNull(arg(args, 'first', vars)), null);
    }
    case 'labels': {
      const entries = repo.labels.map((label, index) => ({ cursor: index + 1, node: { type: 'Label', data: label } as GNode }));
      return buildConnection('LabelConnection', entries, null, null);
    }
    default:
      throw new GqlError(`Field '${name}' doesn't exist on type 'Repository'`);
  }
}

function resolveIssue(issue: Issue, name: string, args: Map<string, GqlValue>, _selections: Selection[], vars: Variables): unknown {
  switch (name) {
    case 'id': return encodeId('Issue', issue.id);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return stateOfIssue(issue);
    case 'stateReason': return issue.state === 'closed' ? 'COMPLETED' : null;
    case 'closed': return issue.state === 'closed';
    case 'locked': return false;
    case 'isPinned': return false;
    case 'includesCreatedEdit': return false;
    case 'createdAt': return issue.created_at;
    case 'updatedAt': return issue.updated_at;
    case 'closedAt': return issue.closed_at;
    case 'url': return `http://entry/issue/${issue.number}`;
    case 'author': return userNode(issue.user.login);
    case 'labels': {
      const entries = issue.labels.map((label, index) => ({ cursor: index + 1, node: { type: 'Label', data: label } as GNode }));
      return buildConnection('LabelConnection', entries, null, null);
    }
    case 'assignees': return buildConnection('UserConnection', [], null, null);
    case 'milestone': return null;
    case 'comments': {
      const first = intOrNull(arg(args, 'first', vars));
      const entries = issue.comments.map((comment, index) => ({ cursor: index + 1, node: { type: 'IssueComment', data: { comment } } as GNode }));
      return buildConnection('IssueCommentConnection', entries, first, null);
    }
    default:
      throw new GqlError(`Field '${name}' doesn't exist on type 'Issue'`);
  }
}

function resolvePullRequest(pull: Pull, name: string, args: Map<string, GqlValue>, _selections: Selection[], vars: Variables): unknown {
  switch (name) {
    case 'id': return encodeId('PullRequest', pull.id);
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return stateOfPull(pull);
    case 'merged': return pull.merged;
    case 'mergedAt': return pull.merged_at;
    case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
    case 'mergeStateStatus': return pull.merged ? 'UNKNOWN' : pull.mergeable ? 'CLEAN' : 'DIRTY';
    case 'headRefName': return pull.head;
    case 'baseRefName': return pull.base;
    case 'headRefOid': return pull.headSha;
    case 'baseRefOid': return pull.baseSha;
    case 'isDraft': return pull.draft;
    case 'createdAt': return pull.created_at;
    case 'updatedAt': return pull.updated_at;
    case 'closedAt': return pull.closed_at;
    case 'url': return `http://entry/${pull.number}`;
    case 'author': return userNode(pull.user.login);
    case 'additions': return 0;
    case 'deletions': return 0;
    case 'changedFiles': return 0;
    case 'comments': return buildConnection('IssueCommentConnection', [], null, null);
    case 'reviews': return buildConnection('PullRequestReviewConnection', [], null, null);
    case 'commits': return buildConnection('PullRequestCommitConnection', [], null, null);
    case 'reviewDecision': return null;
    case 'files': {
      const repo = pullRepo(pull);
      const paths = repo === undefined ? [] : changedPaths(repo, pull);
      const first = intOrNull(arg(args, 'first', vars));
      const entries = paths.map((path, index) => ({
        cursor: index + 1,
        node: { type: 'PullRequestChangedFile', data: { path } } as GNode,
      }));
      return buildConnection('PullRequestChangedFileConnection', entries, first, null);
    }
    default:
      throw new GqlError(`Field '${name}' doesn't exist on type 'PullRequest'`);
  }
}

function pullRepo(pull: Pull): Repo | undefined {
  for (const repo of repos.values()) if (repo.pulls.includes(pull)) return repo;
  return undefined;
}

function resolveIntrospection(node: GNode, name: string, vars: Variables, _selections: Selection[]): unknown {
  const data = child(node);
  const typeName = str(data.name);
  if (node.type === '__Field' || node.type === '__EnumValue') {
    if (name === 'name') return typeName;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    if (name === 'type') return { type: '__Type', data: { name: 'String' } } satisfies GNode;
    throw new GqlError(`Field '${name}' doesn't exist on type '${node.type}'`);
  }
  const enumValues = ENUM_VALUES[typeName];
  switch (name) {
    case 'name': return typeName;
    case 'description': return null;
    case 'kind': {
      if (enumValues !== undefined) return 'ENUM';
      if (SCALARS.has(typeName)) return 'SCALAR';
      if (typeName === 'SearchType') return 'ENUM';
      return 'OBJECT';
    }
    case 'fields': {
      const names = fieldNames(typeName);
      return names.map((field) => ({ type: '__Field', data: { name: field } }));
    }
    case 'enumValues': {
      return (enumValues ?? []).map((value) => ({ type: '__EnumValue', data: { name: value } }));
    }
    case 'interfaces': return [];
    case 'possibleTypes': return [];
    default:
      throw new GqlError(`Field '${name}' doesn't exist on type '__Type'`);
  }
}

// ------------------------------------------------------------------ mutations
function inputOf(args: Map<string, GqlValue>, vars: Variables): Record<string, unknown> {
  const raw = arg(args, 'input', vars);
  return isRecord(raw) ? raw : {};
}

function newIssue(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: nextIssueId(), number: repo.issueSeq++, title, body, state: 'open', labels: [], user: viewer,
    created_at: NOW, updated_at: NOW, closed_at: null, comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

function payload(name: string, fields: Record<string, unknown>): GNode {
  return { type: name, data: fields };
}

function resolveMutation(name: string, args: Map<string, GqlValue>, vars: Variables): unknown {
  const input = inputOf(args, vars);
  switch (name) {
    case 'createIssue': {
      const repo = findRepoByNodeId(input.repositoryId);
      if (repo === undefined) throw new GqlError('Could not resolve to a Repository with the global id supplied');
      const issue = newIssue(repo, str(input.title), str(input.body));
      return payload('CreateIssuePayload', { clientMutationId: input.clientMutationId ?? null, issue: { type: 'Issue', data: { issue } } satisfies GNode });
    }
    case 'closeIssue': {
      const found = findIssueByNodeId(input.issueId);
      if (found === undefined) throw new GqlError('Could not resolve to an Issue with the global id supplied');
      found.issue.state = 'closed';
      found.issue.closed_at = NOW;
      found.issue.updated_at = NOW;
      return payload('CloseIssuePayload', {
        clientMutationId: input.clientMutationId ?? null,
        issue: { type: 'Issue', data: { issue: found.issue } } satisfies GNode,
      });
    }
    case 'reopenIssue': {
      const found = findIssueByNodeId(input.issueId);
      if (found === undefined) throw new GqlError('Could not resolve to an Issue with the global id supplied');
      found.issue.state = 'open';
      found.issue.closed_at = null;
      found.issue.updated_at = NOW;
      return payload('ReopenIssuePayload', {
        clientMutationId: input.clientMutationId ?? null,
        issue: { type: 'Issue', data: { issue: found.issue } } satisfies GNode,
      });
    }
    case 'createPullRequest': {
      const repo = findRepoByNodeId(input.repositoryId);
      if (repo === undefined) throw new GqlError('Could not resolve to a Repository with the global id supplied');
      const headRef = str(input.headRefName);
      const baseRef = str(input.baseRefName, repo.defaultBranch);
      const headSha = branchSha(repo, headRef);
      const baseSha = branchSha(repo, baseRef);
      if (headSha === null) throw new GqlError(`Could not resolve to a node with the global id of '${headRef}'`);
      if (baseSha === null) throw new GqlError(`Could not resolve to a node with the global id of '${baseRef}'`);
      const pull: Pull = {
        id: nextPullId(), number: repo.pullSeq++, title: str(input.title), body: str(input.body),
        state: 'open', head: headRef, base: baseRef, headSha, baseSha, user: viewer,
        created_at: NOW, updated_at: NOW, closed_at: null, merged_at: null,
        merge_commit_sha: null, merged: false, mergeable: true, draft: input.draft === true,
      };
      repo.pulls.push(pull);
      return payload('CreatePullRequestPayload', {
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: { type: 'PullRequest', data: { pull } } satisfies GNode,
      });
    }
    case 'mergePullRequest': {
      const found = findPullByNodeId(input.pullRequestId);
      if (found === undefined) throw new GqlError('Could not resolve to a PullRequest with the global id supplied');
      const { repo, pull } = found;
      if (pull.merged) throw new GqlError(`Pull request #${pull.number} is already merged`);
      const currentTip = branchSha(repo, pull.base) ?? pull.baseSha;
      const merged = fileMap(repo, currentTip === '' ? pull.baseSha : currentTip);
      const head = fileMap(repo, pull.headSha);
      for (const path of changedPaths(repo, pull)) {
        const value = head.get(path);
        if (value === undefined) merged.delete(path);
        else merged.set(path, value);
      }
      const who = { name: viewer.name, email: viewer.email, epoch: NOW_EPOCH, tz: '+0000' };
      const method = str(input.mergeMethod, 'MERGE').toUpperCase();
      const message = `${method === 'SQUASH' ? 'Squash merge' : method === 'REBASE' ? 'Rebase merge' : 'Merge'} pull request #${pull.number} from ${pull.head}`;
      const mergeSha = putCommit({ tree: buildTree(merged), parents: currentTip === '' ? [] : [currentTip], author: who, committer: who, message });
      setBranch(repo, pull.base, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = NOW;
      pull.closed_at = NOW;
      pull.merge_commit_sha = mergeSha;
      pull.updated_at = NOW;
      return payload('MergePullRequestPayload', {
        clientMutationId: input.clientMutationId ?? null,
        pullRequest: { type: 'PullRequest', data: { pull } } satisfies GNode,
      });
    }
    case 'addComment': {
      const subjectId = input.subjectId;
      const body = str(input.body);
      const issue = findIssueByNodeId(subjectId);
      let comment: Comment | undefined;
      if (issue !== undefined) {
        comment = { id: nextCommentId(), body, user: viewer, created_at: NOW, updated_at: NOW };
        issue.issue.comments.push(comment);
        issue.issue.updated_at = NOW;
      } else {
        const found = findPullByNodeId(subjectId);
        if (found === undefined) throw new GqlError('Could not resolve to a node with the global id supplied');
        comment = { id: nextCommentId(), body, user: viewer, created_at: NOW, updated_at: NOW };
      }
      return payload('AddCommentPayload', {
        clientMutationId: input.clientMutationId ?? null,
        commentEdge: {
          type: 'IssueCommentEdge',
          data: { cursor: encodeCursor(comment.id), node: { type: 'IssueComment', data: { comment } } satisfies GNode },
        } satisfies GNode,
      });
    }
    default:
      throw new GqlError(`Field '${name}' doesn't exist on type 'Mutation'`);
  }
}

// ------------------------------------------------------------------ the HTTP handler
interface GraphQLRequest { query: string; variables: Variables }

function errorBody(message: string): Record<string, unknown> {
  return { data: null, errors: [{ message, locations: [{ line: 1, column: 1 }] }] };
}

function executeOne(request: GraphQLRequest): Record<string, unknown> {
  const parser = new Parser(request.query);
  let operation: Operation;
  try {
    operation = parser.parseDocument();
    operation = { ...operation, selections: parser.expand(operation.selections) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorBody(`Syntax Error: ${message}`);
  }
  const root: GNode = { type: operation.type === 'mutation' ? 'Mutation' : 'Query', data: {} };
  try {
    const data = resolveSet(root, operation.selections, request.variables);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return errorBody(err.message);
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return errorBody(message);
  }
}

function requestOf(value: unknown): GraphQLRequest | null {
  if (!isRecord(value) || typeof value.query !== 'string') return null;
  const variables = isRecord(value.variables) ? (value.variables as Variables) : {};
  return { query: value.query, variables };
}

export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') {
    methodNotAllowed(ctx, 'POST');
    return;
  }
  if (ctx.token === null || ctx.token === '') {
    sendMessage(ctx, 401, 'Requires authentication', { 'x-github-request-id': undefined });
    return;
  }
  const body = ctx.json();
  if (Array.isArray(body)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of body) {
      const request = requestOf(entry);
      answers.push(request === null ? errorBody('A query string is required') : executeOne(request));
    }
    sendJson(ctx, 200, answers);
    return;
  }
  const request = requestOf(body);
  if (request === null) {
    sendJson(ctx, 200, errorBody('A query string is required'));
    return;
  }
  sendJson(ctx, 200, executeOne(request));
}
