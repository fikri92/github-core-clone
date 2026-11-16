// Shared in-memory store: the scenario, git objects, repositories, issues and pulls.
// Everything is a plain Map/Buffer in this process: no fs, no network, no clock.
import { createHash } from 'node:crypto';
import { buildScenario, type Scenario, type ScenarioUser } from './scenario.ts';

export type { Scenario, ScenarioUser };
export const scenario: Scenario = buildScenario();
export const viewer: ScenarioUser = scenario.viewer;
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The trial's fixed "now": every created_at we mint comes from it, so runs are byte-identical. */
export const NOW = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00Z';
export const NOW_EPOCH = Math.floor(Date.parse(NOW) / 1000) || 1767225600;

// ------------------------------------------------------------------ git objects
export interface GObj { readonly type: 'blob' | 'tree' | 'commit' | 'tag'; readonly data: Buffer }
export const objects = new Map<string, GObj>();

export function sha1hex(buf: Buffer | string): string {
  return createHash('sha1').update(buf).digest('hex');
}
export function objSha(type: string, data: Buffer): string {
  return sha1hex(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'binary'), data]));
}
export function putObj(type: GObj['type'], data: Buffer): string {
  const sha = objSha(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}
export function putBlob(data: Buffer): string {
  return putObj('blob', data);
}
export function getObj(sha: string): GObj | undefined {
  return objects.get(sha);
}

export interface TreeEntry { readonly mode: string; readonly name: string; readonly sha: Buffer }

/** Parse a tree object into its entries (raw 20-byte sha kept for re-serialisation). */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    out.push({ mode, name, sha: data.subarray(nul + 1, nul + 21) });
    i = nul + 21;
  }
  return out;
}

export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'binary'), e.sha);
  return Buffer.concat(parts);
}

/** Build (and store) the nested trees for `files` (path -> {mode,sha}) and return the root tree sha. */
export function buildTree(files: ReadonlyMap<string, { mode: string; sha: string }>): string {
  interface Node { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], value);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, sha: Buffer.from(f.sha, 'hex') });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: Buffer.from(write(dir), 'hex') });
    return putObj('tree', serializeTree(entries));
  };
  return write(root);
}

/** Flatten a tree into path -> {mode, sha}. */
export function flattenTree(treeSha: string, prefix = '', into = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
  const obj = objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return into;
  for (const entry of parseTree(obj.data)) {
    const sha = entry.sha.toString('hex');
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(sha, path, into);
    else into.set(path, { mode: entry.mode, sha });
  }
  return into;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string; readonly epoch: number; readonly tz: string };
  readonly committer: { readonly name: string; readonly email: string; readonly epoch: number; readonly tz: string };
  readonly message: string;
}

export function commitPayload(info: CommitInfo): Buffer {
  const who = (w: { name: string; email: string; epoch: number; tz: string }): string => `${w.name} <${w.email}> ${w.epoch} ${w.tz}`;
  const lines = [`tree ${info.tree}`, ...info.parents.map((p) => `parent ${p}`), `author ${who(info.author)}`, `committer ${who(info.committer)}`, '', info.message];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Store a commit and return its sha. */
export function putCommit(info: CommitInfo): string {
  return putObj('commit', commitPayload(info));
}

/** Parse a commit object into the fields the forge needs. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  authorTz: string;
  message: string;
}
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], authorName: '', authorEmail: '', authorEpoch: 0, authorTz: '+0000', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.slice(7));
      if (m !== null) {
        out.authorName = m[1];
        out.authorEmail = m[2];
        out.authorEpoch = Number(m[3]);
        out.authorTz = m[4];
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ forge entities
export interface Label { name: string; color: string; description: string | null; id: number }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: ScenarioUser; created_at: string; updated_at: string; closed_at: string | null;
  comments: Comment[];
}
export interface Comment { id: number; body: string; user: ScenarioUser; created_at: string; updated_at: string }
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string; user: ScenarioUser;
  created_at: string; updated_at: string; closed_at: string | null; merged_at: string | null;
  merge_commit_sha: string | null; merged: boolean; mergeable: boolean; draft: boolean;
}
export interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string; created_at: string; updated_at: string; pushed_at: string | null;
  refs: Map<string, string>; issues: Issue[]; pulls: Pull[]; labels: Label[];
  issueSeq: number; pullSeq: number; commentSeq: number;
}

export const repos = new Map<string, Repo>();
let repoIdSeq = 9000;
let issueIdSeq = 50000;
let labelIdSeq = 70000;
let pullIdSeq = 60000;
let commentIdSeq = 80000;

export const repoKey = (owner: string, name: string): string => `${owner}/${name}`.toLowerCase();
export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: repoIdSeq++, owner, name, description, private: isPrivate,
    defaultBranch: 'main', created_at: NOW, updated_at: NOW, pushed_at: null,
    refs: new Map(), issues: [], pulls: [], labels: [], issueSeq: 1, pullSeq: 1, commentSeq: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}
export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}
export function nextIssueId(): number { return issueIdSeq++; }
export function nextLabelId(): number { return labelIdSeq++; }
export function nextPullId(): number { return pullIdSeq++; }
export function nextCommentId(): number { return commentIdSeq++; }

export function branchSha(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}
export function setBranch(repo: Repo, branch: string, sha: string): void {
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.pushed_at = NOW;
  repo.updated_at = NOW;
}
export function listBranches(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice(11), sha });
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}
export function listTags(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice(10), sha });
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Resolve a ref name or commit sha to a commit sha in this repo ('' -> default branch). */
export function resolveRef(repo: Repo, ref: string): string {
  if (ref === '') return branchSha(repo, repo.defaultBranch) ?? '';
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const direct = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
  if (direct !== undefined) return direct;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  return tag ?? '';
}

/** Every commit reachable from `start` (newest first), bounded by `limit`. */
export function commitLog(repo: Repo, start: string, limit = 1000): { sha: string; info: ParsedCommit }[] {
  const out: { sha: string; info: ParsedCommit }[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (sha === '' || seen.has(sha)) continue;
    seen.add(sha);
    const obj = objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.push({ sha, info });
    for (const parent of info.parents) queue.push(parent);
  }
  out.sort((a, b) => b.info.authorEpoch - a.info.authorEpoch);
  return out;
}

export function userByName(login: string): ScenarioUser {
  for (const u of scenario.users) if (u.login === login) return u;
  return { id: 2000, login, name: login, email: `${login}@example.invalid` };
}
