// GitHub REST v3 surface: repos, contents, issues, pulls, protocol.
import type { Ctx } from './http.ts';
import { baseOrigin, linkHeader, methodNotAllowed, pageParams, sendEmpty, sendJson, sendMessage } from './http.ts';
import {
  NOW, NOW_EPOCH, SHOP_TOKEN, branchSha, buildTree, commitLog, createRepo, deleteRepo, flattenTree, getObj,
  getRepo, listBranches, nextCommentId, nextIssueId, nextLabelId, nextPullId, parseCommit, putBlob, putCommit,
  repos, setBranch, userByName, viewer,
  type Comment, type Issue, type Label, type Pull, type Repo,
} from './store.ts';

const API = '/api/v3';
const AUTH: Record<string, string> = { 'x-oauth-scopes': 'repo, read:org' };
const isAuthed = (ctx: Ctx): boolean => ctx.token !== null && ctx.token === SHOP_TOKEN;

function objBody(ctx: Ctx): Record<string, unknown> | null {
  const value = ctx.json();
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');

const USER_CACHE = new Map<string, Record<string, unknown>>();

function userJson(login: string): Record<string, unknown> {
  const hit = USER_CACHE.get(login);
  if (hit !== undefined) return hit;
  const user = userByName(login);
  const built: Record<string, unknown> = { login: user.login, id: user.id, node_id: `U_${user.id}`, type: 'User', name: user.name, email: user.email,
    avatar_url: `http://entry/avatars/${user.login}.png`, html_url: `http://entry/${user.login}` };
  USER_CACHE.set(login, built);
  return built;
}
const labelJson = (label: Label): Record<string, unknown> => ({ id: label.id, node_id: `LA_${label.id}`, name: label.name, color: label.color, default: false, description: label.description });

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return { id: issue.id, node_id: `I_${issue.id}`, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, labels: issue.labels.map(labelJson), user: userJson(issue.user.login), assignee: null, assignees: [],
    comments: issue.comments.length, locked: false, author_association: 'OWNER', created_at: issue.created_at,
    updated_at: issue.updated_at, closed_at: issue.closed_at,
    url: `http://entry${API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}` };
}
const commentJson = (comment: Comment): Record<string, unknown> => ({ id: comment.id, node_id: `IC_${comment.id}`, body: comment.body,
  user: userJson(comment.user.login), created_at: comment.created_at, updated_at: comment.updated_at });

function repoJson(repo: Repo): Record<string, unknown> {
  return { id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: userJson(repo.owner),
    private: repo.private, description: repo.description, fork: false, default_branch: repo.defaultBranch,
    created_at: repo.created_at, updated_at: repo.updated_at, pushed_at: repo.pushed_at,
    html_url: `http://entry/${repo.owner}/${repo.name}`, url: `http://entry${API}/repos/${repo.owner}/${repo.name}`,
    clone_url: `http://entry/${repo.owner}/${repo.name}.git`,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    visibility: repo.private ? 'private' : 'public', permissions: { admin: true, push: true, pull: true } };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return { id: pull.id, node_id: `PR_${pull.id}`, number: pull.number, state: pull.state, title: pull.title, body: pull.body,
    draft: pull.draft, merged: pull.merged, mergeable: pull.mergeable, merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha, closed_at: pull.closed_at, created_at: pull.created_at, updated_at: pull.updated_at,
    user: userJson(pull.user.login),
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, repo: repoJson(repo) },
    html_url: `http://entry/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `http://entry${API}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` };
}

function commitFiles(repo: Repo, sha: string): Map<string, { mode: string; sha: string }> {
  const obj = getObj(sha);
  return obj === undefined || obj.type !== 'commit' ? new Map() : flattenTree(parseCommit(obj.data).tree);
}
const blobText = (sha: string): string => getObj(sha)?.data.toString('utf8') ?? '';

function writeChange(repo: Repo, parent: string | null, path: string, content: Buffer | null, message: string): { commit: string; blobSha: string | null } {
  const files = parent === null ? new Map<string, { mode: string; sha: string }>() : commitFiles(repo, parent);
  let blobSha: string | null = null;
  if (content === null) files.delete(path);
  else {
    blobSha = putBlob(content);
    files.set(path, { mode: '100644', sha: blobSha });
  }
  const who = { name: viewer.name, email: viewer.email, epoch: NOW_EPOCH, tz: '+0000' };
  const commit = putCommit({ tree: buildTree(files), parents: parent === null ? [] : [parent], author: who, committer: who, message });
  return { commit, blobSha };
}

interface FileDiff { filename: string; status: string; additions: number; deletions: number; changes: number }

function diffFiles(repo: Repo, baseSha: string, headSha: string): FileDiff[] {
  const base = commitFiles(repo, baseSha);
  const head = commitFiles(repo, headSha);
  const out: FileDiff[] = [];
  for (const path of new Set<string>([...base.keys(), ...head.keys()])) {
    const a = base.get(path);
    const b = head.get(path);
    if (a !== undefined && b !== undefined && a.sha === b.sha) continue;
    const status = a === undefined ? 'added' : b === undefined ? 'removed' : 'modified';
    const beforeLines = a === undefined ? 0 : blobText(a.sha).split('\n').length;
    const afterLines = b === undefined ? 0 : blobText(b.sha).split('\n').length;
    out.push({ filename: path, status, additions: status === 'removed' ? 0 : Math.max(1, afterLines),
      deletions: status === 'added' ? 0 : beforeLines, changes: Math.max(1, afterLines + beforeLines) });
  }
  return out.sort((x, y) => (x.filename < y.filename ? -1 : 1));
}

export async function handleRest(ctx: Ctx): Promise<void> {
  if (!isAuthed(ctx)) {
    sendMessage(ctx, 401, 'Requires authentication', AUTH);
    return;
  }
  const seg = ctx.path.slice(API.length).split('/').filter((part) => part.length > 0);
  if (seg.length === 0) {
    sendJson(ctx, 200, { current_user_url: `http://entry${API}/user`, repository_url: `http://entry${API}/repos/{owner}/{repo}`,
      user_repositories_url: `http://entry${API}/user/repos{?type,page,per_page,sort}`, rate_limit_url: `http://entry${API}/rate_limit`,
      graphql_url: 'http://entry/api/graphql', installed_version: '17.0.0-makefun' }, AUTH);
    return;
  }
  if (seg[0] === 'meta') {
    sendJson(ctx, 200, { installed_version: '17.0.0-makefun', verifiable_password_authentication: false }, AUTH);
    return;
  }
  if (seg[0] === 'user') {
    if (seg[1] === undefined) return sendJson(ctx, 200, userJson(viewer.login), AUTH);
    if (seg[1] === 'repos') {
      if (ctx.method === 'POST') return createUserRepo(ctx);
      if (ctx.method === 'GET') return listUserRepos(ctx);
      return methodNotAllowed(ctx, 'GET, POST');
    }
    return sendMessage(ctx, 404, 'Not Found', AUTH);
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = getRepo(seg[1], seg[2]);
    if (repo === undefined) return sendMessage(ctx, 404, 'Not Found', AUTH);
    const prefix = `${API}/repos/${seg[1]}/${seg[2]}/`;
    return repoRoutes(ctx, repo, ctx.path.startsWith(prefix) ? ctx.path.slice(prefix.length) : '', seg.slice(3));
  }
  sendMessage(ctx, 404, 'Not Found', AUTH);
}

async function createUserRepo(ctx: Ctx): Promise<void> {
  const body = objBody(ctx);
  if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
  const name = str(body.name).trim();
  if (name === '') return sendMessage(ctx, 422, 'Repository name is required', AUTH);
  if (getRepo(viewer.login, name) !== undefined) return sendMessage(ctx, 422, 'Repository creation failed: name already exists on this account', AUTH);
  sendJson(ctx, 201, repoJson(createRepo(viewer.login, name, str(body.description), bool(body.private, false))), AUTH);
}

function listUserRepos(ctx: Ctx): void {
  const { perPage, page } = pageParams(ctx.query);
  const all: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner === viewer.login) all.push(repo);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const next = start + perPage < all.length ? `${baseOrigin(ctx)}${API}/user/repos?per_page=${perPage}&page=${page + 1}` : null;
  sendJson(ctx, 200, slice.map(repoJson), { ...AUTH, ...linkHeader(next) });
}

function repoRoutes(ctx: Ctx, repo: Repo, restPath: string, seg: string[]): void {
  const head = seg[0];
  const method = ctx.method;
  if (head === undefined) {
    if (method === 'GET') return sendJson(ctx, 200, repoJson(repo), AUTH);
    if (method === 'PATCH') {
      const body = objBody(ctx);
      if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updated_at = NOW;
      return sendJson(ctx, 200, repoJson(repo), AUTH);
    }
    if (method === 'DELETE') {
      deleteRepo(repo.owner, repo.name);
      return sendEmpty(ctx, 204, AUTH);
    }
    return methodNotAllowed(ctx, 'GET, PATCH, DELETE');
  }
  if (head === 'branches') {
    if (seg[1] !== undefined) {
      const sha = branchSha(repo, seg[1]);
      if (sha === null) return sendMessage(ctx, 404, 'Branch not found', AUTH);
      return sendJson(ctx, 200, { name: seg[1], commit: { sha }, protected: false }, AUTH);
    }
    return sendJson(ctx, 200, listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false })), AUTH);
  }
  if (head === 'commits') {
    if (seg[1] === undefined) {
      const ref = ctx.query.get('sha') ?? ctx.query.get('ref') ?? '';
      let start = branchSha(repo, repo.defaultBranch) ?? '';
      if (ref !== '') start = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : '');
      if (start === '') return sendJson(ctx, 200, [], AUTH);
      return sendJson(ctx, 200, commitLog(repo, start).map((entry) => ({
        sha: entry.sha,
        commit: { author: { name: entry.info.authorName, email: entry.info.authorEmail, date: iso(entry.info.authorEpoch) },
          committer: { name: entry.info.authorName, email: entry.info.authorEmail, date: iso(entry.info.authorEpoch) },
          message: entry.info.message, tree: { sha: entry.info.tree } },
        parents: entry.info.parents.map((sha) => ({ sha })),
      })), AUTH);
    }
    const sha = seg[1];
    const obj = getObj(sha);
    if (obj === undefined || obj.type !== 'commit') return sendMessage(ctx, 404, 'Not Found', AUTH);
    const info = parseCommit(obj.data);
    return sendJson(ctx, 200, { sha,
      commit: { author: { name: info.authorName, email: info.authorEmail, date: iso(info.authorEpoch) },
        committer: { name: info.authorName, email: info.authorEmail, date: iso(info.authorEpoch) },
        message: info.message, tree: { sha: info.tree } },
      parents: info.parents.map((parent) => ({ sha: parent })), files: diffFiles(repo, info.parents[0] ?? '', sha) }, AUTH);
  }
  if (head === 'git' && seg[1] === 'refs') {
    if (method === 'POST') {
      const body = objBody(ctx);
      if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === '' || sha === '') return sendMessage(ctx, 422, 'ref and sha are required', AUTH);
      repo.refs.set(ref, sha);
      repo.updated_at = NOW;
      return sendJson(ctx, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } }, AUTH);
    }
    return sendJson(ctx, 200, [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })), AUTH);
  }
  if (head === 'contents') return contentsRoutes(ctx, repo, restPath.slice('contents/'.length).replace(/^\/+|\/+$/g, ''));
  if (head === 'labels') {
    if (method === 'GET') return sendJson(ctx, 200, repo.labels.map(labelJson), AUTH);
    const body = objBody(ctx);
    if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
    const name = str(body.name);
    if (name === '') return sendMessage(ctx, 422, 'name is required', AUTH);
    const found = repo.labels.find((label) => label.name === name);
    if (found !== undefined) return sendJson(ctx, 201, labelJson(found), AUTH);
    const label: Label = { id: nextLabelId(), name, color: str(body.color, 'ededed'), description: null };
    repo.labels.push(label);
    return sendJson(ctx, 201, labelJson(label), AUTH);
  }
  if (head === 'issues') return issueRoutes(ctx, repo, seg.slice(1));
  if (head === 'pulls') return pullRoutes(ctx, repo, seg.slice(1));
  sendMessage(ctx, 404, 'Not Found', AUTH);
}

function contentsRoutes(ctx: Ctx, repo: Repo, filePath: string): void {
  const method = ctx.method;
  const ref = ctx.query.get('ref') ?? '';
  const branch = ref === '' ? repo.defaultBranch : (repo.refs.has(`refs/heads/${ref}`) ? ref : (repo.refs.has(`refs/tags/${ref}`) ? ref : ''));
  if (branch === '') return sendMessage(ctx, 404, 'Not Found', AUTH);
  const tip = repo.refs.get(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) ?? '';
  const files = tip === '' ? new Map<string, { mode: string; sha: string }>() : commitFiles(repo, tip);

  if (method === 'GET') {
    const file = files.get(filePath);
    if (file !== undefined) {
      const data = getObj(file.sha)?.data ?? Buffer.alloc(0);
      return sendJson(ctx, 200, { name: filePath.split('/').pop(), path: filePath, sha: file.sha, size: data.length,
        type: 'file', encoding: 'base64', content: data.toString('base64').replace(/(.{60})/g, '$1\n'),
        url: `http://entry${API}/repos/${repo.owner}/${repo.name}/contents/${filePath}` }, AUTH);
    }
    const prefix = filePath === '' ? '' : `${filePath}/`;
    const seen = new Set<string>();
    const entries: Record<string, unknown>[] = [];
    for (const [path, value] of files) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      const first = remainder.split('/')[0];
      if (first === undefined || first === '' || seen.has(first)) continue;
      seen.add(first);
      if (remainder.includes('/')) entries.push({ name: first, path: `${prefix}${first}`, sha: value.sha, size: 0, type: 'dir' });
      else {
        const data = getObj(value.sha)?.data ?? Buffer.alloc(0);
        entries.push({ name: first, path: `${prefix}${first}`, sha: value.sha, size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') });
      }
    }
    if (entries.length === 0) return sendMessage(ctx, 404, 'Not Found', AUTH);
    return sendJson(ctx, 200, entries.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1)), AUTH);
  }

  if (method === 'PUT') {
    const body = objBody(ctx);
    if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
    const encoded = str(body.content);
    if (encoded === '') return sendMessage(ctx, 422, 'content is required', AUTH);
    const content = Buffer.from(encoded.replace(/\n/g, ''), 'base64');
    const targetBranch = str(body.branch, repo.defaultBranch);
    const existing = files.get(filePath);
    const providedSha = typeof body.sha === 'string' ? body.sha : null;
    if (existing !== undefined) {
      if (providedSha === null) return sendMessage(ctx, 422, 'sha is required when updating an existing file', AUTH);
      if (providedSha !== existing.sha) return sendMessage(ctx, 409, 'sha does not match the current file', AUTH);
    } else if (providedSha !== null) return sendMessage(ctx, 422, 'sha does not match any file', AUTH);
    const change = writeChange(repo, repo.refs.get(`refs/heads/${targetBranch}`) ?? null, filePath, content, str(body.message, 'update'));
    setBranch(repo, targetBranch, change.commit);
    return sendJson(ctx, existing === undefined ? 201 : 200, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: change.blobSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
      commit: { sha: change.commit, author: { name: viewer.name, email: viewer.email, date: NOW } } }, AUTH);
  }

  if (method === 'DELETE') {
    const body = objBody(ctx);
    if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
    const existing = files.get(filePath);
    if (existing === undefined) return sendMessage(ctx, 404, 'Not Found', AUTH);
    const providedSha = typeof body.sha === 'string' ? body.sha : null;
    if (providedSha !== null && providedSha !== existing.sha) return sendMessage(ctx, 409, 'sha does not match the current file', AUTH);
    const targetBranch = str(body.branch, repo.defaultBranch);
    const change = writeChange(repo, repo.refs.get(`refs/heads/${targetBranch}`) ?? null, filePath, null, str(body.message, 'delete'));
    setBranch(repo, targetBranch, change.commit);
    return sendJson(ctx, 200, { commit: { sha: change.commit }, content: null }, AUTH);
  }
  return methodNotAllowed(ctx, 'GET, PUT, DELETE');
}

function issueRoutes(ctx: Ctx, repo: Repo, seg: string[]): void {
  const method = ctx.method;
  if (seg[0] === undefined) {
    if (method === 'POST') {
      const body = objBody(ctx);
      if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
      const wanted = Array.isArray(body.labels) ? body.labels.map((value) => String(value)) : [];
      const attached: Label[] = [];
      for (const name of wanted) {
        const label = repo.labels.find((candidate) => candidate.name === name);
        if (label === undefined) return sendMessage(ctx, 422, `Label does not exist: ${name}`, AUTH);
        attached.push(label);
      }
      const issue: Issue = { id: nextIssueId(), number: repo.issueSeq++, title: str(body.title), body: str(body.body),
        state: 'open', labels: attached, user: viewer, created_at: NOW, updated_at: NOW, closed_at: null, comments: [] };
      repo.issues.push(issue);
      return sendJson(ctx, 201, issueJson(repo, issue), AUTH);
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.slice();
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((x, y) => (direction === 'asc' ? x.number - y.number : y.number - x.number));
      const { perPage, page } = pageParams(ctx.query);
      const start = (page - 1) * perPage;
      return sendJson(ctx, 200, list.slice(start, start + perPage).map((issue) => issueJson(repo, issue)), AUTH);
    }
    return methodNotAllowed(ctx, 'GET, POST');
  }
  const number = Number(seg[0]);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (seg[1] === 'comments') {
    if (issue === undefined) return sendMessage(ctx, 404, 'Not Found', AUTH);
    if (method === 'POST') {
      const body = objBody(ctx);
      if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
      const comment: Comment = { id: nextCommentId(), body: str(body.body), user: viewer, created_at: NOW, updated_at: NOW };
      issue.comments.push(comment);
      return sendJson(ctx, 201, commentJson(comment), AUTH);
    }
    return sendJson(ctx, 200, issue.comments.map(commentJson), AUTH);
  }
  if (issue === undefined) return sendMessage(ctx, 404, 'Not Found', AUTH);
  if (method === 'GET') return sendJson(ctx, 200, issueJson(repo, issue), AUTH);
  if (method === 'PATCH') {
    const body = objBody(ctx) ?? {};
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') {
      issue.state = body.state;
      issue.closed_at = body.state === 'closed' ? NOW : null;
    }
    if (Array.isArray(body.labels)) {
      const next: Label[] = [];
      for (const value of body.labels) {
        const label = repo.labels.find((candidate) => candidate.name === String(value));
        if (label === undefined) return sendMessage(ctx, 422, `Label does not exist: ${String(value)}`, AUTH);
        next.push(label);
      }
      issue.labels = next;
    }
    issue.updated_at = NOW;
    return sendJson(ctx, 200, issueJson(repo, issue), AUTH);
  }
  return methodNotAllowed(ctx, 'GET, PATCH');
}

function pullRoutes(ctx: Ctx, repo: Repo, seg: string[]): void {
  const method = ctx.method;
  if (seg[0] === undefined) {
    if (method === 'POST') {
      const body = objBody(ctx);
      if (body === null) return sendMessage(ctx, 400, 'Problems parsing JSON', AUTH);
      const parts = str(body.head).split(':');
      const headRef = parts[parts.length - 1];
      const baseRef = str(body.base, repo.defaultBranch);
      const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
      if (headSha === '' || baseSha === '') return sendMessage(ctx, 422, 'Validation Failed: head or base branch does not exist', AUTH);
      const pull: Pull = { id: nextPullId(), number: repo.pullSeq++, title: str(body.title), body: str(body.body),
        state: 'open', head: headRef, base: baseRef, headSha, baseSha, user: viewer, created_at: NOW, updated_at: NOW,
        closed_at: null, merged_at: null, merge_commit_sha: null, merged: false, mergeable: true, draft: bool(body.draft, false) };
      repo.pulls.push(pull);
      return sendJson(ctx, 201, pullJson(repo, pull), AUTH);
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.pulls.slice();
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((x, y) => y.number - x.number);
      const { perPage, page } = pageParams(ctx.query);
      const start = (page - 1) * perPage;
      return sendJson(ctx, 200, list.slice(start, start + perPage).map((pull) => pullJson(repo, pull)), AUTH);
    }
    return methodNotAllowed(ctx, 'GET, POST');
  }
  const number = Number(seg[0]);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return sendMessage(ctx, 404, 'Not Found', AUTH);
  if (seg[1] === 'files' && method === 'GET') return sendJson(ctx, 200, diffFiles(repo, pull.baseSha, pull.headSha), AUTH);
  if (seg[1] === 'merge' && method === 'PUT') {
    const body = objBody(ctx) ?? {};
    const currentTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    const changed = diffFiles(repo, pull.baseSha, pull.headSha);
    const moved = new Set(diffFiles(repo, pull.baseSha, currentTip).map((file) => file.filename));
    if (changed.some((file) => moved.has(file.filename))) return sendMessage(ctx, 405, 'Pull Request is not mergeable', AUTH);
    const headFiles = commitFiles(repo, pull.headSha);
    const merged = new Map(commitFiles(repo, currentTip));
    for (const file of changed) {
      if (file.status === 'removed') merged.delete(file.filename);
      else {
        const value = headFiles.get(file.filename);
        if (value !== undefined) merged.set(file.filename, value);
      }
    }
    const who = { name: viewer.name, email: viewer.email, epoch: NOW_EPOCH, tz: '+0000' };
    const message = str(body.commit_message, `Merge pull request #${pull.number} from ${pull.head}`);
    const mergeSha = putCommit({ tree: buildTree(merged), parents: currentTip === '' ? [] : [currentTip], author: who, committer: who, message });
    setBranch(repo, pull.base, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = NOW;
    pull.closed_at = NOW;
    pull.merge_commit_sha = mergeSha;
    return sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' }, AUTH);
  }
  if (seg[1] === undefined && method === 'GET') return sendJson(ctx, 200, pullJson(repo, pull), AUTH);
  if (seg[1] === undefined && method === 'PATCH') {
    const body = objBody(ctx) ?? {};
    if (typeof body.title === 'string') pull.title = body.title;
    if (typeof body.body === 'string') pull.body = body.body;
    return sendJson(ctx, 200, pullJson(repo, pull), AUTH);
  }
  return sendMessage(ctx, 404, 'Not Found', AUTH);
}
