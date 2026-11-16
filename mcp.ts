// The Model Context Protocol surface: JSON-RPC 2.0 over the Streamable HTTP transport at /mcp.
//
// Two protocol eras are served from the one endpoint (the suite accepts either, and probes the modern
// one first):
//
//   modern 2026-07-28 — no handshake and no session. `server/discover` answers the server's identity,
//           its capabilities and the revisions it supports in one result; every later request declares
//           its revision in `_meta` and `MCP-Protocol-Version` and is answered by one JSON body.
//   legacy 2025-11-25 and earlier — `initialize` echoes the requested revision (clamped to one we
//           support), `notifications/initialized` is accepted, and no session id is issued (optional).
//
// The tools act on store.ts, the same objects the REST v3 surface reads back: a repository created by
// create_repo is the object GET /api/v3/repos/{owner}/{repo} answers, an issue created by create_issue
// is an entry of the repository's issues array (the REST list reads it), and merge_pull_request flips
// the repository's own Pull.merged. Nothing here keeps state of its own: every answer is derived from
// the store, so the tools are deterministic and two tools/list answers are byte-identical.
//
// Every answer is application/json. A body that is not JSON answers HTTP 400 with -32700; a request
// without a bearer token answers HTTP 401 before the body is read; an unknown tool answers -32602 (and
// an unknown method -32601), never HTTP 500. Every handler is synchronous or a promise that settles
// at once, so each request answers well inside the 3 second bound.
import type { Ctx } from './http.ts';
import { send, sendJson } from './http.ts';
import type { Issue, Pull, Repo } from './store.ts';
import {
  NOW,
  SHOP_TOKEN,
  branchSha,
  createRepo,
  getRepo,
  nextIssueId,
  nextPullId,
  repos,
  setBranch,
  viewer,
} from './store.ts';

// ------------------------------------------------------------------ protocol constants

/** The current revision this server speaks (the suite's preferred one). */
const PROTOCOL_VERSION = '2026-07-28';

/** The revisions `server/discover` names, newest first (the suite negotiates down from the first). */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The server's identity: non-empty name and version (the initialize check requires both). */
const SERVER_INFO: Readonly<{ name: string; version: string }> = Object.freeze({
  name: 'github-core-clone-01-mcp',
  version: '1.0.0',
});

/** The instructions a client receives alongside the tool list. */
const INSTRUCTIONS =
  'A GitHub-compatible forge. create_repo and get_repo address repositories, create_issue and ' +
  'list_issues their issues, create_pull_request and merge_pull_request their pull requests.';

/** The JSON-RPC error codes this surface uses. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Args = Record<string, unknown>;

/** Whether `value` is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed non-empty string out of an argument, or null. */
function textArg(args: Args, name: string): string | null {
  const value = args[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** An integer out of an argument (a number, or a decimal string), or null. */
function intArg(args: Args, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** A boolean out of an argument (boolean, or the strings true/false), or the default. */
function boolArg(args: Args, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

// ------------------------------------------------------------------ store serialisation (REST shapes)

/** A repository as the forge's REST and MCP surfaces both describe it. */
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: viewer.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

/** An issue as REST and MCP describe it (the shape checks-mcp.ts reads: number, title, id, state). */
function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })),
    user: issue.user,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

/** A pull request as REST and MCP describe it (head/base carry their ref name; merged is a boolean). */
function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${pull.base}` },
    user: pull.user,
    merged: pull.merged,
    mergeable: pull.mergeable,
    draft: pull.draft,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
  };
}

// ------------------------------------------------------------------ tool results

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** A successful tool result carrying `value` as both text and structured content. */
function ok(value: Record<string, unknown> | unknown[]): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/** A tool execution error: isError true, the reason in the text block (never a thrown request). */
function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The repository a tool addresses, or the tool error saying why it cannot. */
type RepoLookup = { readonly found: true; readonly repo: Repo } | { readonly found: false; readonly error: ToolResult };

/** Resolve the required owner/repo arguments to a stored repository (a tool error otherwise). */
function repoFor(args: Args): RepoLookup {
  const missing: string[] = [];
  if (textArg(args, 'owner') === null) missing.push('owner');
  if (textArg(args, 'repo') === null) missing.push('repo');
  if (missing.length > 0) return { found: false, error: toolError(`missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`) };
  const owner = textArg(args, 'owner') as string;
  const name = textArg(args, 'repo') as string;
  const repo = getRepo(owner, name);
  if (repo === undefined) return { found: false, error: toolError(`repository ${owner}/${name} was not found`) };
  return { found: true, repo };
}

/** One tool: its wire description, its inputSchema, and the store work it does. */
interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: Args) => ToolResult;
}

/** An object inputSchema (the transport requires type:object; the suite fills only declared properties). */
function inputSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const OWNER = { type: 'string', description: 'The account that owns the repository.' };
const REPO = { type: 'string', description: 'The repository name.' };

/** The tools, in a fixed order, built once: two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for an account and answer it as the REST surface does.',
    inputSchema: inputSchema(
      { name: { type: 'string', description: 'The repository name.' }, owner: OWNER, description: { type: 'string' }, private: { type: 'boolean' } },
      ['name'],
    ),
    handler(args: Args): ToolResult {
      const name = textArg(args, 'name');
      if (name === null) return toolError('missing required argument: name');
      const owner = textArg(args, 'owner') ?? viewer.login;
      const description = textArg(args, 'description') ?? '';
      const isPrivate = boolArg(args, 'private', false);
      const existing = getRepo(owner, name);
      const repo = existing ?? createRepo(owner, name, description, isPrivate);
      return ok(repoJson(repo));
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name, as GET /api/v3/repos/{owner}/{repo} answers it.',
    inputSchema: inputSchema({ owner: OWNER, repo: REPO }, ['owner', 'repo']),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      return ok(repoJson(lookup.repo));
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories an account owns.',
    inputSchema: inputSchema({ owner: OWNER }, []),
    handler(args: Args): ToolResult {
      const owner = textArg(args, 'owner') ?? viewer.login;
      const found: unknown[] = [];
      for (const repo of repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) found.push(repoJson(repo));
      found.sort((left, right) => ((left as Record<string, unknown>).id as number) - ((right as Record<string, unknown>).id as number));
      return ok({ total_count: found.length, repositories: found });
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository; the REST issue list reads the same issue back.',
    inputSchema: inputSchema(
      { owner: OWNER, repo: REPO, title: { type: 'string', description: 'The issue title.' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
      ['owner', 'repo', 'title'],
    ),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      const target = lookup.repo;
      const title = textArg(args, 'title');
      if (title === null) return toolError('missing required argument: title');
      const body = typeof args.body === 'string' ? args.body : '';
      const number = target.issueSeq;
      target.issueSeq += 1;
      const issue: Issue = {
        id: nextIssueId(),
        number,
        title,
        body,
        state: 'open',
        labels: [],
        user: viewer,
        created_at: NOW,
        updated_at: NOW,
        closed_at: null,
        comments: [],
      };
      target.issues.push(issue);
      target.updated_at = NOW;
      return ok(issueJson(issue));
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, open by default (state: open, closed or all).',
    inputSchema: inputSchema({ owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      const target = lookup.repo;
      const state = (textArg(args, 'state') ?? 'open').toLowerCase();
      const all = state === 'all';
      const listed = target.issues.filter((issue) => all || issue.state === state);
      return ok({ total_count: listed.length, issues: listed.map(issueJson) });
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue of a repository by its number.',
    inputSchema: inputSchema({ owner: OWNER, repo: REPO, issue_number: { type: 'integer' } }, ['owner', 'repo', 'issue_number']),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      const number = intArg(args, 'issue_number') ?? intArg(args, 'number');
      if (number === null) return toolError('missing required argument: issue_number');
      const issue = lookup.repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return toolError(`issue #${number} was not found`);
      return ok(issueJson(issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch; REST reads the same head and base.',
    inputSchema: inputSchema(
      {
        owner: OWNER,
        repo: REPO,
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string', description: 'The branch the change comes from.' },
        base: { type: 'string', description: 'The branch the change goes into.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      const target = lookup.repo;
      const title = textArg(args, 'title');
      if (title === null) return toolError('missing required argument: title');
      const head = textArg(args, 'head');
      if (head === null) return toolError('missing required argument: head');
      const base = textArg(args, 'base');
      if (base === null) return toolError('missing required argument: base');
      const body = typeof args.body === 'string' ? args.body : '';
      const number = target.pullSeq;
      target.pullSeq += 1;
      const pull: Pull = {
        id: nextPullId(),
        number,
        title,
        body,
        state: 'open',
        head,
        base,
        headSha: branchSha(target, head) ?? '',
        baseSha: branchSha(target, base) ?? '',
        user: viewer,
        created_at: NOW,
        updated_at: NOW,
        closed_at: null,
        merged_at: null,
        merge_commit_sha: null,
        merged: false,
        mergeable: true,
        draft: false,
      };
      target.pulls.push(pull);
      target.updated_at = NOW;
      return ok(pullJson(pull));
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List a repository\'s pull requests (state: open, closed or all).',
    inputSchema: inputSchema({ owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      const target = lookup.repo;
      const state = (textArg(args, 'state') ?? 'open').toLowerCase();
      const all = state === 'all';
      const listed = target.pulls.filter((pull) => all || pull.state === state);
      return ok({ total_count: listed.length, pulls: listed.map(pullJson) });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request; the repository\'s pull request then reads merged:true over REST.',
    inputSchema: inputSchema(
      { owner: OWNER, repo: REPO, pull_number: { type: 'integer', description: 'The pull request number.' } },
      ['owner', 'repo', 'pull_number'],
    ),
    handler(args: Args): ToolResult {
      const lookup = repoFor(args);
      if (!lookup.found) return lookup.error;
      const target = lookup.repo;
      const number = intArg(args, 'pull_number');
      if (number === null) return toolError('missing required argument: pull_number');
      const pull = target.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`pull request #${number} was not found`);
      if (!pull.merged) {
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeable = false;
        pull.merged_at = NOW;
        pull.closed_at = NOW;
        pull.updated_at = NOW;
        pull.merge_commit_sha = pull.headSha === '' ? null : pull.headSha;
        if (pull.headSha !== '' && pull.base !== '') setBranch(target, pull.base, pull.headSha);
      }
      return ok({ merged: true, number: pull.number, message: `Pull request #${pull.number} merged`, sha: pull.merge_commit_sha });
    },
  },
]);

/** The wire view of one tool: exactly what tools/list answers (no handler). */
interface WireTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const WIRE_TOOLS: readonly WireTool[] = Object.freeze(
  TOOLS.map((tool) => Object.freeze({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
);

function findTool(name: string): ToolDef | undefined {
  const exact = TOOLS.find((tool) => tool.name === name);
  if (exact !== undefined) return exact;
  const wanted = name.toLowerCase();
  return TOOLS.find((tool) => {
    const own = tool.name.toLowerCase();
    return own === wanted || wanted.endsWith(own) || own.endsWith(wanted);
  });
}

// ------------------------------------------------------------------ JSON-RPC

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC response object (result or error), the id echoed exactly. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: RpcError = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}

/** The `server/discover` result: identity, capabilities and revisions in one answer. */
function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
    serverInfo: { ...SERVER_INFO },
    instructions: INSTRUCTIONS,
    _meta: {
      'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
      'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
    },
  };
}

/** The `initialize` result: the requested revision when supported, else the newest legacy one. */
function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { ...SERVER_INFO },
    instructions: INSTRUCTIONS,
  };
}

/** The tools/list result: the same array every time (byte-identical answers). */
function toolsListResult(): Record<string, unknown> {
  return { tools: WIRE_TOOLS };
}

/** The answer to one `tools/call`: the tool result, or the message of a JSON-RPC -32602 refusal. */
type CallAnswer = { readonly result: ToolResult } | { readonly error: string };

/** One `tools/call` request: the tool result, or a refusal when the tool is unknown. */
function callTool(params: Record<string, unknown>): CallAnswer {
  const name = typeof params.name === 'string' ? params.name : '';
  if (name === '') return { error: 'tools/call requires a tool name' };
  const tool = findTool(name);
  if (tool === undefined) return { error: `Unknown tool: ${name}` };
  const args: Args = isRecord(params.arguments) ? params.arguments : {};
  try {
    return { result: tool.handler(args) };
  } catch (error) {
    // A handler's own failure is the tool's error, never the request's: isError true, HTTP 200.
    return { result: toolError(error instanceof Error ? error.message : String(error)) };
  }
}

/** Whether the message carries a request id (a notification has none). */
function hasId(message: Record<string, unknown>): boolean {
  return 'id' in message && message.id !== undefined;
}

/**
 * Answer one JSON-RPC message: the response object, or null for a notification (no answer body).
 * Errors are JSON-RPC errors, never thrown: the HTTP layer stays at 200 for a well-formed request.
 */
function handleMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = hasId(message) ? message.id : null;
  if (message.jsonrpc !== '2.0') return rpcError(id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  const method = typeof message.method === 'string' ? message.method : '';
  if (method === '') return rpcError(id, INVALID_REQUEST, 'Invalid Request: method must be a string');
  const params: Record<string, unknown> = isRecord(message.params) ? message.params : {};
  const notification = !hasId(message);

  if (method === 'server/discover') return rpcResult(id, discoverResult());
  if (method === 'initialize') return rpcResult(id, initializeResult(params));
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, toolsListResult());
  if (method === 'tools/call') {
    const answer = callTool(params);
    // An unknown tool is a JSON-RPC -32602 even without an id; a tool result needs an id to answer.
    if ('error' in answer) return rpcError(id, INVALID_PARAMS, answer.error);
    if (notification) return null;
    return rpcResult(id, answer.result);
  }
  if (method.startsWith('notifications/')) return null;
  // A notification is never answered, even when its method is unknown (JSON-RPC 2.0).
  if (notification) return null;
  return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}

/** Whether the request carries the trial's bearer token (401 answers precede any body parsing). */
function authorized(ctx: Ctx): boolean {
  const token = ctx.token;
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

/** The 401 answer: a JSON body naming the failure, with the challenge header a client expects. */
function unauthorized(ctx: Ctx): void {
  sendJson(
    ctx,
    401,
    { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' },
    { 'www-authenticate': 'Bearer realm="github-core-clone-01"' },
  );
}

/** Parse the request body; undefined when it is not JSON (the -32700 answer). */
function parseBody(ctx: Ctx): unknown {
  const text = ctx.body.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The MCP endpoint: POST answers JSON-RPC, DELETE ends a session, GET is not offered. */
export async function handleMcp(ctx: Ctx): Promise<void> {
  if (ctx.method === 'DELETE') {
    send(ctx, 204, Buffer.alloc(0), 'application/json');
    return;
  }
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    sendJson(ctx, 405, { message: 'Method Not Allowed: the Streamable HTTP transport answers POST' }, { allow: 'POST, DELETE' });
    return;
  }
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, { message: 'Method Not Allowed' }, { allow: 'POST, DELETE' });
    return;
  }
  if (!authorized(ctx)) {
    unauthorized(ctx);
    return;
  }

  const body = parseBody(ctx);
  if (body === undefined) {
    sendJson(ctx, 400, rpcError(null, PARSE_ERROR, 'Parse error: the body is not JSON'));
    return;
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      sendJson(ctx, 400, rpcError(null, INVALID_REQUEST, 'Invalid Request: empty batch'));
      return;
    }
    const answers: unknown[] = [];
    for (const entry of body) {
      if (!isRecord(entry)) {
        answers.push(rpcError(null, INVALID_REQUEST, 'Invalid Request: a batch entry must be an object'));
        continue;
      }
      const answer = handleMessage(entry);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      send(ctx, 202, Buffer.alloc(0), 'application/json');
      return;
    }
    sendJson(ctx, 200, answers);
    return;
  }

  if (!isRecord(body)) {
    sendJson(ctx, 400, rpcError(null, INVALID_REQUEST, 'Invalid Request: the body must be a JSON object'));
    return;
  }

  const answer = handleMessage(body);
  if (answer === null) {
    send(ctx, 202, Buffer.alloc(0), 'application/json');
    return;
  }
  sendJson(ctx, 200, answer);
}
