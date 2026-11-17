// The Model Context Protocol surface: JSON-RPC 2.0 over the Streamable HTTP transport, revision
// 2026-07-28 (server/discover) or a handshake revision (initialize + notifications/initialized).
// Every tool acts on the same in-memory store REST v3 serves, so ids are shared across surfaces.
import type { Ctx } from './http.ts';
import { methodNotAllowed, sendEmpty, sendJson, sendMessage } from './http.ts';
import {
  NOW, NOW_EPOCH, branchSha, buildTree, createRepo, flattenTree, getObj, getRepo, nextIssueId,
  nextLabelId, nextPullId, parseCommit, putCommit, setBranch, userByName, viewer,
  type Issue, type Label, type Pull, type Repo,
} from './store.ts';

const API = 'http://entry/api/v3';
const SESSION_ID = 'forge-mcp-session-1';
const LATEST_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', title: 'GitHub-compatible forge', version: '1.0.0' };
const INSTRUCTIONS = 'A GitHub-compatible forge. create_repo, create_issue, create_pull_request and merge_pull_request write to the same store the REST v3 API and the git smart-HTTP remote serve.';

// ------------------------------------------------------------------ small value helpers
type Args = Record<string, unknown>;
type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

const ok = (value: unknown): Outcome => ({ ok: true, value });
const fail = (message: string): Outcome => ({ ok: false, message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

function intOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

// ------------------------------------------------------------------ JSON shapes (REST parity)
function userJson(login: string): Record<string, unknown> {
  const user = userByName(login);
  return {
    login: user.login, id: user.id, node_id: `U_${user.id}`, type: 'User', name: user.name, email: user.email,
    avatar_url: `http://entry/avatars/${user.login}.png`, html_url: `http://entry/${user.login}`,
  };
}

const labelJson = (label: Label): Record<string, unknown> => ({
  id: label.id, node_id: `LA_${label.id}`, name: label.name, color: label.color, default: false, description: label.description,
});

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: `I_${issue.id}`, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map(labelJson), user: userJson(issue.user.login), assignee: null,
    assignees: [], comments: issue.comments.length, locked: false, author_association: 'OWNER',
    created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.closed_at,
    url: `${API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner), private: repo.private, description: repo.description, fork: false,
    default_branch: repo.defaultBranch, created_at: repo.created_at, updated_at: repo.updated_at,
    pushed_at: repo.pushed_at, html_url: `http://entry/${repo.owner}/${repo.name}`,
    url: `${API}/repos/${repo.owner}/${repo.name}`, clone_url: `http://entry/${repo.owner}/${repo.name}.git`,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const slim = { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: userJson(repo.owner) };
  return {
    id: pull.id, node_id: `PR_${pull.id}`, number: pull.number, state: pull.state, title: pull.title,
    body: pull.body, draft: pull.draft, merged: pull.merged, mergeable: pull.mergeable,
    merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha, closed_at: pull.closed_at,
    created_at: pull.created_at, updated_at: pull.updated_at, user: userJson(pull.user.login),
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, repo: slim },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, repo: slim },
    html_url: `http://entry/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${API}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ------------------------------------------------------------------ trees and merges
function fileMap(sha: string): Map<string, { mode: string; sha: string }> {
  const obj = getObj(sha);
  return obj === undefined || obj.type !== 'commit' ? new Map() : flattenTree(parseCommit(obj.data).tree);
}

function changedPaths(baseSha: string, headSha: string): string[] {
  const base = fileMap(baseSha);
  const head = fileMap(headSha);
  const out: string[] = [];
  for (const [path, value] of head) if (base.get(path)?.sha !== value.sha) out.push(path);
  for (const path of base.keys()) if (!head.has(path)) out.push(path);
  return out.sort();
}

function mergePull(repo: Repo, pull: Pull, message: string): Outcome {
  if (pull.merged) return fail(`Pull request #${pull.number} is already merged`);
  if (!pull.mergeable) return fail(`Pull request #${pull.number} is not mergeable`);
  const currentTip = branchSha(repo, pull.base) ?? pull.baseSha;
  const changed = changedPaths(pull.baseSha, pull.headSha);
  const moved = new Set(changedPaths(pull.baseSha, currentTip));
  if (changed.some((path) => moved.has(path))) return fail(`Pull request #${pull.number} is not mergeable: the base branch moved`);
  const head = fileMap(pull.headSha);
  const merged = fileMap(currentTip === '' ? pull.baseSha : currentTip);
  for (const path of changed) {
    const value = head.get(path);
    if (value === undefined) merged.delete(path);
    else merged.set(path, value);
  }
  const who = { name: viewer.name, email: viewer.email, epoch: NOW_EPOCH, tz: '+0000' };
  const sha = putCommit({
    tree: buildTree(merged), parents: currentTip === '' ? [] : [currentTip], author: who, committer: who, message,
  });
  setBranch(repo, pull.base, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = NOW;
  pull.closed_at = NOW;
  pull.merge_commit_sha = sha;
  pull.updated_at = NOW;
  return ok({ sha, merged: true, message: 'Pull request successfully merged' });
}

// ------------------------------------------------------------------ argument resolution
function ownerRepo(args: Args): { owner: string; repo: string } | null {
  let owner = str(args.owner).trim();
  let repo = str(args.repo).trim();
  const full = str(args.full_name).trim();
  if (full.includes('/')) {
    const parts = full.split('/');
    if (owner === '') owner = parts[0];
    if (repo === '') repo = parts.slice(1).join('/');
  }
  if (repo === '') repo = str(args.repository).trim();
  if (repo === '') repo = str(args.repo_name).trim();
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function repoOf(args: Args): Repo | null {
  const target = ownerRepo(args);
  if (target === null) return null;
  return getRepo(target.owner, target.repo) ?? null;
}

function pullNumberOf(args: Args): number | null {
  return intOf(args.pull_number) ?? intOf(args.number) ?? intOf(args.pullNumber) ?? intOf(args.pull_request_number);
}

function labelList(repo: Repo, raw: unknown): Label[] | string {
  const wanted: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out: Label[] = [];
  for (const value of wanted) {
    const name = typeof value === 'string' ? value.trim() : isRecord(value) ? str(value.name).trim() : '';
    if (name === '') continue;
    const label = repo.labels.find((candidate) => candidate.name === name);
    if (label === undefined) return `Label does not exist: ${name}`;
    out.push(label);
  }
  return out;
}

// ------------------------------------------------------------------ tool schemas
const S = (description: string): Record<string, unknown> => ({ type: 'string', description });
const N = (description: string): Record<string, unknown> => ({ type: 'integer', description });
const B = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const LIST = (description: string): Record<string, unknown> => ({ type: 'array', items: { type: 'string' }, description });

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const OWNER = S('Repository owner login. May be omitted when full_name is given.');
const REPO = S('Repository name, without the owner. May be omitted when full_name is given.');
const FULL = S('owner/repo, filled in beside owner and repo.');

interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Args) => Outcome;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open an issue on a repository. Returns the issue object with its id, number and state.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      title: S('Issue title. Required.'),
      body: S('Issue body, as markdown.'),
      labels: LIST('Label names that already exist on the repository.'),
    }, ['owner', 'repo', 'title']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const title = str(args.title).trim();
      if (title === '') return fail('Missing required argument: title');
      const labels = labelList(repo, args.labels);
      if (typeof labels === 'string') return fail(labels);
      const issue: Issue = {
        id: nextIssueId(), number: repo.issueSeq++, title, body: str(args.body), state: 'open',
        labels, user: viewer, created_at: NOW, updated_at: NOW, closed_at: null, comments: [],
      };
      repo.issues.push(issue);
      return ok(issueJson(repo, issue));
    },
  },
  {
    name: 'create_label',
    title: 'Create label',
    description: 'Create a label on a repository so an issue may carry it. Returns the label object.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      name: S('Label name. Required.'),
      color: S('Six-digit hex colour without the leading hash.'),
      description: S('Label description.'),
    }, ['owner', 'repo', 'name']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const name = str(args.name).trim();
      if (name === '') return fail('Missing required argument: name');
      const found = repo.labels.find((candidate) => candidate.name === name);
      if (found !== undefined) return ok(labelJson(found));
      const label: Label = {
        id: nextLabelId(), name, color: str(args.color, 'ededed').replace(/^#/, ''), description: str(args.description) || null,
      };
      repo.labels.push(label);
      return ok(labelJson(label));
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a branch that exists to another branch. Returns the pull request object.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      title: S('Pull request title. Required.'),
      head: S('Head branch, optionally owner:branch. Required.'),
      base: S('Base branch. Defaults to the default branch.'),
      body: S('Pull request body, as markdown.'),
      draft: B('Whether the pull request is a draft.'),
    }, ['owner', 'repo', 'title', 'head', 'base']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const title = str(args.title).trim();
      if (title === '') return fail('Missing required argument: title');
      const headRaw = str(args.head).trim();
      if (headRaw === '') return fail('Missing required argument: head');
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string).trim() : headRaw;
      const base = str(args.base).trim() || repo.defaultBranch;
      const headSha = branchSha(repo, head);
      const baseSha = branchSha(repo, base);
      if (headSha === null) return fail(`Head branch ${head} does not exist in ${repo.owner}/${repo.name}`);
      if (baseSha === null) return fail(`Base branch ${base} does not exist in ${repo.owner}/${repo.name}`);
      const pull: Pull = {
        id: nextPullId(), number: repo.pullSeq++, title, body: str(args.body), state: 'open', head, base,
        headSha, baseSha, user: viewer, created_at: NOW, updated_at: NOW, closed_at: null, merged_at: null,
        merge_commit_sha: null, merged: false, mergeable: true, draft: bool(args.draft, false),
      };
      repo.pulls.push(pull);
      repo.updated_at = NOW;
      return ok(pullJson(repo, pull));
    },
  },
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a repository owned by the authenticated user. Returns the repository object with its id.',
    inputSchema: schema({
      name: S('Repository name, without the owner. Required unless full_name is given.'),
      description: S('Short repository description.'),
      private: B('Whether the repository is private.'),
      owner: S('Owner login; defaults to the authenticated user.'),
      full_name: FULL,
    }, ['name']),
    run: (args) => {
      const full = str(args.full_name).trim();
      let name = str(args.name).trim();
      if (name === '' && full.includes('/')) name = full.split('/').slice(1).join('/');
      if (name === '') return fail('Missing required argument: name');
      const owner = str(args.owner).trim() || (full.includes('/') ? full.split('/')[0] : viewer.login);
      const existing = getRepo(owner, name);
      if (existing !== undefined) return ok(repoJson(existing));
      const repo = createRepo(owner, name, str(args.description), bool(args.private, false));
      return ok(repoJson(repo));
    },
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Read one issue of a repository by its number. Returns the issue object or an error.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      number: N('Issue number. Required.'),
    }, ['owner', 'repo', 'number']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const number = intOf(args.number) ?? intOf(args.issue_number);
      if (number === null) return fail('Missing required argument: number');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return fail(`Issue #${number} not found in ${repo.owner}/${repo.name}`);
      return ok(issueJson(repo, issue));
    },
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request',
    description: 'Read one pull request of a repository by its number. Returns the pull request object or an error.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      pull_number: N('Pull request number. Required.'),
    }, ['owner', 'repo', 'pull_number']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const number = pullNumberOf(args);
      if (number === null) return fail('Missing required argument: pull_number');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return fail(`Pull request #${number} not found in ${repo.owner}/${repo.name}`);
      return ok(pullJson(repo, pull));
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name. Returns the repository object, or an error when it is absent.',
    inputSchema: schema({ owner: OWNER, repo: REPO, full_name: FULL }, ['owner', 'repo']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) {
        const target = ownerRepo(args);
        return fail(target === null ? 'Missing required arguments: owner and repo' : `Repository ${target.owner}/${target.repo} not found`);
      }
      return ok(repoJson(repo));
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, newest number first. Returns an array of issue objects.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      state: S('open, closed or all. Defaults to all.'),
    }, ['owner', 'repo']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const state = str(args.state, 'all').toLowerCase();
      let list = repo.issues.slice();
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      return ok(list.map((issue) => issueJson(repo, issue)));
    },
  },
  {
    name: 'list_labels',
    title: 'List labels',
    description: 'List the labels of a repository. Returns an array of label objects.',
    inputSchema: schema({ owner: OWNER, repo: REPO, full_name: FULL }, ['owner', 'repo']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      return ok(repo.labels.map(labelJson));
    },
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List the pull requests of a repository, newest number first. Returns an array of pull request objects.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      state: S('open, closed, merged or all. Defaults to all.'),
    }, ['owner', 'repo']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const state = str(args.state, 'all').toLowerCase();
      let list = repo.pulls.slice();
      if (state === 'open') list = list.filter((pull) => !pull.merged && pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => !pull.merged && pull.state === 'closed');
      else if (state === 'merged') list = list.filter((pull) => pull.merged);
      list.sort((a, b) => b.number - a.number);
      return ok(list.map((pull) => pullJson(repo, pull)));
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge an open pull request into its base branch. Returns the merge commit sha and merged:true.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      pull_number: N('Pull request number. Required.'),
      commit_message: S('Commit message for the merge commit.'),
    }, ['owner', 'repo', 'pull_number']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const number = pullNumberOf(args);
      if (number === null) return fail('Missing required argument: pull_number');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return fail(`Pull request #${number} not found in ${repo.owner}/${repo.name}`);
      const message = str(args.commit_message) || `Merge pull request #${pull.number} from ${pull.head}`;
      return mergePull(repo, pull, message);
    },
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description: 'Change the title, body, state or labels of an issue. Returns the updated issue object.',
    inputSchema: schema({
      owner: OWNER, repo: REPO, full_name: FULL,
      number: N('Issue number. Required.'),
      title: S('New title.'),
      body: S('New body.'),
      state: S('open or closed.'),
      labels: LIST('Replacement label names.'),
    }, ['owner', 'repo', 'number']),
    run: (args) => {
      const repo = repoOf(args);
      if (repo === null) return fail('Missing required arguments: owner and repo');
      const number = intOf(args.number) ?? intOf(args.issue_number);
      if (number === null) return fail('Missing required argument: number');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return fail(`Issue #${number} not found in ${repo.owner}/${repo.name}`);
      if (typeof args.title === 'string') issue.title = args.title;
      if (typeof args.body === 'string') issue.body = args.body;
      const state = str(args.state).toLowerCase();
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closed_at = state === 'closed' ? NOW : null;
      }
      if (args.labels !== undefined) {
        const labels = labelList(repo, args.labels);
        if (typeof labels === 'string') return fail(labels);
        issue.labels = labels;
      }
      issue.updated_at = NOW;
      return ok(issueJson(repo, issue));
    },
  },
];

const TOOL_BY_NAME = new Map<string, ToolDef>(TOOLS.map((tool) => [tool.name, tool]));
const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
}));

function findTool(raw: string): ToolDef | null {
  const lower = raw.trim().toLowerCase();
  if (lower === '') return null;
  const direct = TOOL_BY_NAME.get(lower);
  if (direct !== undefined) return direct;
  const cut = lower.lastIndexOf('__');
  if (cut >= 0) {
    const hit = TOOL_BY_NAME.get(lower.slice(cut + 2));
    if (hit !== undefined) return hit;
  }
  for (const tool of TOOLS) if (lower.endsWith(tool.name)) return tool;
  return null;
}

// ------------------------------------------------------------------ JSON-RPC plumbing
function rpcResponse(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcId(raw: Record<string, unknown>): string | number | null {
  const value = raw.id;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value) ?? 'null';
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
  if (isRecord(value)) out.structuredContent = value;
  return out;
}

function capabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
    prompts: { listChanged: false },
    completions: {},
    logging: {},
  };
}

function toolArguments(raw: unknown): Args {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

/** One JSON-RPC message -> one response object, or null for a notification. */
function handleMessage(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  const method = str(raw.method);
  if (method === '') return rpcError(rpcId(raw), -32600, 'Invalid Request: missing method');
  if (method.startsWith('notifications/')) return null;
  if (!Object.prototype.hasOwnProperty.call(raw, 'id')) return null;
  const id = rpcId(raw);
  const params = isRecord(raw.params) ? raw.params : {};
  const declared = str(params.protocolVersion);
  switch (method) {
    case 'initialize': {
      const version = PROTOCOL_VERSIONS.includes(declared) ? declared : LATEST_PROTOCOL;
      return rpcResponse(id, {
        protocolVersion: version,
        capabilities: capabilities(),
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'server/discover': {
      return rpcResponse(id, {
        supportedVersions: [...PROTOCOL_VERSIONS],
        protocolVersion: LATEST_PROTOCOL,
        capabilities: capabilities(),
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResponse(id, {});
    case 'tools/list':
      return rpcResponse(id, { tools: TOOL_LIST });
    case 'tools/call': {
      const name = str(params.name);
      if (name === '') return rpcError(id, -32602, 'Invalid params: a tool name is required');
      const tool = findTool(name);
      if (tool === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
      let outcome: Outcome;
      try {
        outcome = tool.run(toolArguments(params.arguments));
      } catch (err) {
        outcome = fail(err instanceof Error ? err.message : String(err));
      }
      if (!outcome.ok) return rpcResponse(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      return rpcResponse(id, toolResult(outcome.value));
    }
    case 'resources/list':
      return rpcResponse(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResponse(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResponse(id, { prompts: [] });
    case 'completion/complete':
      return rpcResponse(id, { completion: { values: [], total: 0, hasMore: false } });
    case 'logging/setLevel':
      return rpcResponse(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ------------------------------------------------------------------ the HTTP handler
export async function handleMcp(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') {
    if (ctx.method === 'DELETE') {
      sendEmpty(ctx, 204);
      return;
    }
    methodNotAllowed(ctx, 'POST, DELETE');
    return;
  }
  const authorization = ctx.req.headers.authorization;
  if (typeof authorization !== 'string' || authorization.trim() === '') {
    sendMessage(ctx, 401, 'Requires authentication');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, rpcError(null, -32700, 'Parse error: the request body is not valid JSON'));
    return;
  }
  try {
    if (Array.isArray(parsed)) {
      const answers: Record<string, unknown>[] = [];
      for (const entry of parsed) {
        const answer = handleMessage(entry);
        if (answer !== null) answers.push(answer);
      }
      if (answers.length === 0) sendEmpty(ctx, 202);
      else sendJson(ctx, 200, answers);
      return;
    }
    if (!isRecord(parsed)) {
      sendJson(ctx, 400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object or a batch array'));
      return;
    }
    const answer = handleMessage(parsed);
    if (answer === null) {
      sendEmpty(ctx, 202);
      return;
    }
    const headers: Record<string, string | undefined> = parsed.method === 'initialize' ? { 'mcp-session-id': SESSION_ID } : {};
    sendJson(ctx, 200, answer, headers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx, 200, rpcError(null, -32603, `Internal error: ${message}`));
  }
}
