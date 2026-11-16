// The git smart-HTTP surface: protocol v2 upload-pack (advertisement, ls-refs, fetch,
// including shallow/deepen and sideband packfiles) and v0 receive-pack (command list,
// pack ingest with deltas, fast-forward checks, report-status over sideband).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Ctx } from './http.ts';
import { send, sendMessage } from './http.ts';
import { getRepo, objects, objSha, parseTree, type GObj, type Repo } from './store.ts';

const ZERO = '0'.repeat(40);
const PKT_MAX = 65515;

// ------------------------------------------------------------------ pkt-line
function pkt(text: string | Buffer): Buffer {
  const data = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packets { lines: string[]; rest: Buffer }

/** Decode pkt-lines until a flush; `rest` is whatever followed it (a push pack). */
function readPackets(body: Buffer): Packets {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const head = body.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    i += 4;
    if (len === 0) return { lines, rest: body.subarray(i) };
    if (len === 1 || len === 2) continue; // delim / response-end
    if (len < 4 || i + len - 4 > body.length) break;
    lines.push(body.toString('utf8', i, i + len - 4));
    i += len - 4;
  }
  return { lines, rest: body.subarray(Math.min(i, body.length)) };
}

// ------------------------------------------------------------------ objects
function hashOf(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'binary'), data])).digest('hex');
}

function commitParents(sha: string): string[] {
  const obj = objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return [];
  const out: string[] = [];
  const text = obj.data.toString('utf8');
  const end = text.indexOf('\n\n');
  for (const line of (end < 0 ? text : text.slice(0, end)).split('\n')) {
    if (line.startsWith('parent ')) out.push(line.slice(7).trim());
  }
  return out;
}

function commitTree(sha: string): string | null {
  const obj = objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const m = /^tree ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8', 0, 200));
  return m === null ? null : m[1];
}

/** Peel a tag chain to its non-tag target. */
function peel(sha: string): string {
  let cur = sha;
  for (let i = 0; i < 20; i += 1) {
    const obj = objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8', 0, 200));
    if (m === null) return cur;
    cur = m[1];
  }
  return cur;
}

/** Commit ancestry from `tips`, with an optional generation limit. */
function commitSet(tips: Iterable<string>, depth: number | null): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ sha: string; level: number }> = [];
  for (const tip of tips) queue.push({ sha: tip, level: 1 });
  while (queue.length > 0) {
    const { sha, level } = queue.shift() as { sha: string; level: number };
    if (commits.has(sha)) continue;
    const obj = objects.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'tag') { queue.push({ sha: peel(sha), level }); continue; }
    if (obj.type !== 'commit') continue;
    commits.add(sha);
    const parents = commitParents(sha);
    if (depth !== null && level >= depth) {
      if (parents.length > 0) boundary.add(sha);
      continue;
    }
    for (const parent of parents) queue.push({ sha: parent, level: level + 1 });
  }
  return { commits, boundary };
}

/** Every object reachable from `tips` (commits, their trees and blobs, tags). */
function objectClosure(tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    const obj = objects.get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const tree = commitTree(sha);
      if (tree !== null) queue.push(tree);
      for (const parent of commitParents(sha)) queue.push(parent);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8', 0, 200));
      if (m !== null) queue.push(m[1]);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.sha.toString('hex'));
      }
    }
  }
  return seen;
}

/** Non-commit objects for a set of commits (their trees and blobs). */
function treeObjects(commits: Iterable<string>): Set<string> {
  const trees: string[] = [];
  for (const sha of commits) {
    const tree = commitTree(sha);
    if (tree !== null) trees.push(tree);
  }
  const seen = new Set<string>();
  const queue: string[] = [...trees];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    const obj = objects.get(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.sha.toString('hex'));
      }
    }
  }
  return seen;
}

// ------------------------------------------------------------------ pack write
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function entryHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let rest = size;
  let byte = (type << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return Buffer.from(out);
}

/** A version-2 pack of plain (non-delta) objects, trailer included. */
function buildPack(shas: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  const list: string[] = [];
  for (const sha of shas) {
    const obj = objects.get(sha);
    if (obj !== undefined) list.push(sha);
  }
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const sha of list) {
    const obj = objects.get(sha) as GObj;
    parts.push(entryHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Split a buffer into sideband band-1 pkt-lines (no trailing flush). */
function band1(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += PKT_MAX) {
    const slice = data.subarray(i, Math.min(i + PKT_MAX, data.length));
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ------------------------------------------------------------------ pack read
interface Ingested { count: number; ok: boolean; detail: string }

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } | null {
  try {
    const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { data: res.buffer, next: offset + res.engine.bytesWritten };
  } catch {
    return null;
  }
}

function readVarintSize(buf: Buffer, start: number): { size: number; next: number } | null {
  let i = start;
  let byte = buf[i++];
  if (byte === undefined) return null;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buf[i++];
    if (byte === undefined) return null;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i++];
      if (byte === undefined) throw new Error('delta truncated');
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) { off += delta[i++] * 2 ** shift; }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) { size += delta[i++] * 2 ** shift; }
        shift += 8;
      }
      if (size === 0) size = 0x10000;
      base.copy(out, written, off, off + size);
      written += size;
    } else if (op !== 0) {
      delta.copy(out, written, i, i + op);
      i += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a push pack into the store; resolves OFS_DELTA and REF_DELTA. */
export function ingestPack(pack: Buffer): Ingested {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') {
    return { count: 0, ok: false, detail: 'protocol error: not a packfile' };
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { count: 0, ok: false, detail: `unsupported pack version ${version}` };
  const declared = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, end)).digest('hex');
  if (pack.subarray(end).toString('hex') !== computed) return { count: 0, ok: false, detail: 'pack checksum mismatch' };
  const byOffset = new Map<number, { type: GObj['type']; data: Buffer }>();
  const pending: Array<{ offset: number; baseOffset: number | null; baseSha: string | null; type: GObj['type'] | null; data: Buffer }> = [];
  let offset = 12;
  let parsed = 0;
  while (offset < end && parsed < declared) {
    const start = offset;
    const head = readVarintSize(pack, offset);
    if (head === null) return { count: parsed, ok: false, detail: 'truncated pack entry' };
    const typeCode = (pack[offset] >> 4) & 0x07;
    offset = head.next;
    let baseOffset: number | null = null;
    let baseSha: string | null = null;
    if (typeCode === 6) {
      let byte = pack[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated === null) return { count: parsed, ok: false, detail: 'corrupt zlib stream' };
    offset = inflated.next;
    const typeName = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : typeCode === 4 ? 'tag' : null;
    const item = { offset: start, baseOffset, baseSha, type: typeName as GObj['type'] | null, data: inflated.data };
    if (typeCode === 6 || typeCode === 7) {
      pending.push(item);
    } else if (typeName !== null) {
      byOffset.set(start, { type: typeName, data: inflated.data });
      putObject(typeName, inflated.data);
    } else {
      return { count: parsed, ok: false, detail: `unknown pack object type ${typeCode}` };
    }
    parsed += 1;
    if (offset > end) return { count: parsed, ok: false, detail: 'pack overran its trailer' };
  }
  for (const item of pending) {
    const base = item.baseOffset !== null
      ? byOffset.get(item.baseOffset)
      : (objects.get(item.baseSha as string) as GObj | undefined);
    if (base === undefined) return { count: parsed, ok: false, detail: 'delta base is missing' };
    let data: Buffer;
    try {
      data = applyDelta(base.data, item.data);
    } catch (err) {
      return { count: parsed, ok: false, detail: `delta failed: ${(err as Error).message}` };
    }
    byOffset.set(item.offset, { type: base.type, data });
    putObject(base.type, data);
  }
  return { count: declared, ok: true, detail: 'ok' };
}

function putObject(type: GObj['type'], data: Buffer): string {
  const sha = objSha(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

// ------------------------------------------------------------------ advertisement
function refList(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, sha] of repo.refs) if (objects.has(sha)) out.push({ name, sha });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

const UPLOAD_CAPS_V0 = [
  'multi_ack_detailed', 'thin-pack', 'side-band-64k', 'ofs-delta', 'shallow',
  'no-progress', 'include-tag', 'agent=makefun-forge/1.0', 'object-format=sha1',
].join(' ');

const RECEIVE_CAPS = [
  'report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta',
  'agent=makefun-forge/1.0', 'object-format=sha1',
].join(' ');

const V2_CAPS = [
  'version 2',
  'agent=makefun-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'server-option',
  'object-format=sha1',
];

function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  const out: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (v2) {
    out.push(pkt('version 2\n'));
    for (const line of V2_CAPS.slice(1)) out.push(pkt(`${line}\n`));
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  const refs = refList(repo);
  const head = refs.find((ref) => ref.name === `refs/heads/${repo.defaultBranch}`);
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    out.push(pkt(`${ZERO} capabilities^{}\u0000${caps}\n`));
  } else if (head !== undefined) {
    out.push(pkt(`${head.sha} HEAD\u0000${caps}\n`));
    for (const ref of refs) out.push(pkt(`${ref.sha} ${ref.name}\n`));
  } else {
    out.push(pkt(`${refs[0].sha} ${refs[0].name}\u0000${caps}\n`));
    for (const ref of refs.slice(1)) out.push(pkt(`${ref.sha} ${ref.name}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ ls-refs
function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let wantPeel = false;
  let wantSymref = false;
  let wantUnborn = false;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') wantPeel = true;
    else if (line === 'symrefs') wantSymref = true;
    else if (line === 'unborn') wantUnborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const refs = refList(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    const head = refs.find((ref) => ref.name === headTarget);
    if (head !== undefined) {
      out.push(pkt(`${head.sha} HEAD${wantSymref ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (wantUnborn) {
      out.push(pkt(`unborn HEAD${wantSymref ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (wantSymref && ref.name.startsWith('refs/heads/')) line += ` symref-target:${ref.name}`;
    if (wantPeel) {
      const peeled = peel(ref.sha);
      if (peeled !== ref.sha) line += ` peeled:${peeled}`;
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ fetch
function parseFetchArgs(args: string[]) {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let filter: string | null = null;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    } else if (line.startsWith('filter ')) filter = line.slice(7).trim();
  }
  return { wants, haves, shallows, depth, filter };
}

/** Arguments for the want side: peel annotated tags to their commit. */
function wantCommits(wants: string[]): string[] {
  const out: string[] = [];
  for (const want of wants) {
    const obj = objects.get(want);
    if (obj === undefined) continue;
    out.push(obj.type === 'tag' ? peel(want) : want);
  }
  return out;
}

function handleFetch(repo: Repo, args: string[]): Buffer {
  const { wants, haves, shallows, depth, filter } = parseFetchArgs(args);
  const out: Buffer[] = [];
  const valid = wants.filter((want) => /^[0-9a-f]{40}$/.test(want) && objects.has(want));
  if (valid.length === 0) {
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  const { commits, boundary } = commitSet(wantCommits(valid), depth);
  let send: Set<string>;
  if (depth !== null) {
    // A shallow fetch sends exactly what the new commits need; the haves' history is already held
    // except for the generation the deeper boundary uncovered.
    const haveSet = new Set(haves);
    const fresh = new Set([...commits].filter((sha) => !haveSet.has(sha)));
    send = new Set<string>([...fresh, ...treeObjects(fresh)]);
    for (const want of valid) {
      const obj = objects.get(want);
      if (obj !== undefined && obj.type === 'tag' && filter === null) send.add(want);
    }
  } else {
    const wanted = new Set<string>(commits);
    for (const want of valid) {
      const obj = objects.get(want);
      if (obj !== undefined && obj.type === 'tag' && filter === null) wanted.add(want);
    }
    send = new Set<string>([...wanted, ...treeObjects(commits)]);
    if (haves.length > 0) {
      const held = objectClosure(haves);
      for (const sha of [...send]) if (held.has(sha)) send.delete(sha);
    }
  }
  const shallowLines: string[] = [];
  if (depth !== null) {
    for (const sha of boundary) shallowLines.push(`shallow ${sha}\n`);
    for (const sha of shallows) {
      if (!boundary.has(sha) && commits.has(sha)) shallowLines.push(`unshallow ${sha}\n`);
    }
    for (const sha of shallows) {
      if (!commits.has(sha) && !boundary.has(sha)) shallowLines.push(`shallow ${sha}\n`);
    }
  }
  if (shallowLines.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const line of shallowLines) out.push(pkt(line));
    out.push(FLUSH);
  }
  out.push(pkt('packfile\n'));
  for (const chunk of band1(buildPack(send))) out.push(chunk);
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ receive-pack
function isAncestor(old: string, tip: string): boolean {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (sha === old) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (seen.size > 200000) return false;
    for (const parent of commitParents(sha)) queue.push(parent);
  }
  return false;
}

interface RefCommand { old: string; next: string; ref: string }

function handleReceive(repo: Repo, body: Buffer): Buffer {
  const { lines, rest } = readPackets(body);
  const commands: RefCommand[] = [];
  const caps = new Set<string>();
  lines.forEach((raw, index) => {
    let line = raw.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap) caps.add(cap);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length < 3) return;
    commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  });
  const sideband = caps.has('side-band-64k');
  let unpack = 'ok';
  if (rest.length > 0) {
    const ingested = ingestPack(rest);
    if (!ingested.ok) unpack = ingested.detail;
  }
  const report: Buffer[] = [];
  const replies: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpack !== 'ok') {
    for (const command of commands) replies.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      const refOk = /^refs\/[^\s]+$/.test(command.ref) && !/[\u0000-\u001f]/.test(command.ref);
      if (!refOk) { replies.push({ ref: command.ref, ok: false, reason: 'funny refname' }); continue; }
      const deleting = command.next === ZERO;
      if (deleting) {
        if (current === undefined) { replies.push({ ref: command.ref, ok: false, reason: 'no such ref' }); continue; }
        if (command.old !== ZERO && current !== command.old) { replies.push({ ref: command.ref, ok: false, reason: 'stale info' }); continue; }
        repo.refs.delete(command.ref);
        replies.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (!objects.has(command.next)) { replies.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' }); continue; }
      if (command.old === ZERO) {
        if (current !== undefined) { replies.push({ ref: command.ref, ok: false, reason: 'already exists' }); continue; }
      } else {
        if (current !== undefined && current !== command.old) { replies.push({ ref: command.ref, ok: false, reason: 'stale info' }); continue; }
        if (current === undefined) { replies.push({ ref: command.ref, ok: false, reason: 'no such ref' }); continue; }
        if (command.ref.startsWith('refs/heads/') && !isAncestor(command.old, command.next)) {
          replies.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.next);
      replies.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  report.push(pkt(`unpack ${unpack}\n`));
  for (const reply of replies) {
    report.push(reply.ok ? pkt(`ok ${reply.ref}\n`) : pkt(`ng ${reply.ref} ${reply.reason}\n`));
  }
  const inner = Buffer.concat([...report, FLUSH]);
  if (sideband) {
    const out = band1(inner);
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  return inner;
}

// ------------------------------------------------------------------ router
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/(?:info\/refs|git-upload-pack|git-receive-pack))$/;

export async function handleGit(ctx: Ctx): Promise<boolean> {
  const match = GIT_PATH.exec(ctx.path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const sub = match[3];
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendMessage(ctx, 404, 'Not Found');
    return true;
  }
  if (sub === '/info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendMessage(ctx, 403, 'Unsupported service');
      return true;
    }
    if (ctx.method !== 'GET') {
      sendMessage(ctx, 405, 'Method Not Allowed', { allow: 'GET' });
      return true;
    }
    const header = ctx.req.headers['git-protocol'];
    const wantsV2 = service === 'git-upload-pack' && typeof header === 'string' && /version=2/.test(header);
    send(ctx, 200, advertisement(repo, service, wantsV2), `application/x-${service}-advertisement`, {
      'cache-control': 'no-cache',
    });
    return true;
  }
  if (ctx.method !== 'POST') {
    sendMessage(ctx, 405, 'Method Not Allowed', { allow: 'POST' });
    return true;
  }
  const service = sub === '/git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  const type = `application/x-${service}-result`;
  let body: Buffer;
  try {
    body = service === 'git-upload-pack' ? uploadPackResponse(repo, ctx.body) : handleReceive(repo, ctx.body);
  } catch (err) {
    sendMessage(ctx, 400, 'Bad Request');
    return true;
  }
  send(ctx, 200, body, type, { 'cache-control': 'no-cache' });
  return true;
}

function uploadPackResponse(repo: Repo, body: Buffer): Buffer {
  const { lines } = readPackets(body);
  let command = '';
  const args: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('command=')) { command = line.slice(8); continue; }
    if (line.startsWith('agent=') || line.startsWith('object-format=') || line.startsWith('server-option=')) continue;
    args.push(raw);
  }
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return handleFetch(repo, args);
  if (command === '' && args.some((arg) => arg.startsWith('want '))) return handleFetch(repo, args);
  throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
}
