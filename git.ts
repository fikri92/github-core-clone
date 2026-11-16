// git smart-HTTP: protocol v2 upload-pack (ls-refs, fetch) and receive-pack (push).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Ctx } from './http.ts';
import { send, sendMessage } from './http.ts';
import { getRepo, objects, putObj, type Repo } from './store.ts';

const ZERO = '0000000000000000000000000000000000000000';

// ------------------------------------------------------------------ pkt-line
const pkt = (payload: string | Buffer): Buffer => {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data]);
};
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet { kind: 'data' | 'flush' | 'delim'; payload: Buffer }

function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

const text = (packet: Packet): string => packet.payload.toString('utf8').replace(/\n$/, '');

// ------------------------------------------------------------------ pack objects
const TYPE_NAMES: Record<number, 'commit' | 'tree' | 'blob' | 'tag'> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const size = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  size();
  const target = size();
  const out = Buffer.alloc(target);
  let written = 0;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let offset = 0;
      let length = 0;
      if (cmd & 0x01) offset |= delta[pos++];
      if (cmd & 0x02) offset |= delta[pos++] << 8;
      if (cmd & 0x04) offset |= delta[pos++] << 16;
      if (cmd & 0x08) offset |= delta[pos++] << 24;
      if (cmd & 0x10) length |= delta[pos++];
      if (cmd & 0x20) length |= delta[pos++] << 8;
      if (cmd & 0x40) length |= delta[pos++] << 16;
      if (length === 0) length = 0x10000;
      base.copy(out, written, offset, offset + length);
      written += length;
    } else if (cmd !== 0) {
      delta.copy(out, written, pos, pos + cmd);
      written += cmd;
      pos += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}

interface ReadPack { objects: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> }

function readPack(pack: Buffer): ReadPack {
  const found = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  let pos = 12;
  let count = pack.readUInt32BE(8);
  const byOffset = new Map<number, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  while (count-- > 0 && pos < pack.length - 20) {
    const start = pos;
    let byte = pack[pos++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseRef: number | null = null;
    if (typeCode === 6) {
      byte = pack[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseRef = start - offset;
    } else if (typeCode === 7) {
      baseRef = -1;
    }
    const info = inflateSync(pack.subarray(pos), { info: true } as never) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const inflater = info.buffer;
    let data = inflater;
    pos += info.engine.bytesWritten;
    let type: 'commit' | 'tree' | 'blob' | 'tag' | null = TYPE_NAMES[typeCode] ?? null;
    if (typeCode === 6) {
      const baseEntry = baseRef === null ? null : byOffset.get(baseRef);
      if (baseEntry === undefined || baseEntry === null) throw new Error('missing ofs-delta base');
      data = applyDelta(baseEntry.data, data);
      type = baseEntry.type;
    } else if (typeCode === 7) {
      const oid = data.subarray(0, 20).toString('hex');
      data = data.subarray(20);
      const baseEntry = found.get(oid) ?? (objects.get(oid) as { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer } | undefined);
      if (baseEntry === undefined) throw new Error('missing ref-delta base');
      data = applyDelta(baseEntry.data, data);
      type = baseEntry.type;
    }
    if (type === null) throw new Error(`bad pack object type ${typeCode}`);
    const sha = objShaLocal(type, data);
    const entry = { type, data };
    found.set(sha, entry);
    byOffset.set(start, entry);
  }
  return { objects: found };
}

function objShaLocal(type: string, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'binary'), data])).digest('hex');
}

function writePack(entries: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('PACK', 'ascii'));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(entries.length, 4);
  parts.push(header);
  for (const entry of entries) {
    const code = TYPE_CODES[entry.type];
    let size = entry.data.length;
    const bytes: number[] = [];
    let first = (code << 4) | (size & 15);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes), deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------ object graph
interface Entry { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }

const getEntry = (sha: string): Entry | undefined => {
  const obj = objects.get(sha);
  return obj === undefined ? undefined : { type: obj.type, data: obj.data };
};

function parentsOf(sha: string): string[] {
  const entry = getEntry(sha);
  if (entry === undefined || entry.type !== 'commit') return [];
  const head = entry.data.toString('utf8').split('\n\n')[0];
  const out: string[] = [];
  for (const line of head.split('\n')) if (line.startsWith('parent ')) out.push(line.slice(7).trim());
  return out;
}

function treeOf(sha: string): string {
  const entry = getEntry(sha);
  if (entry === undefined) return '';
  const head = entry.data.toString('utf8').split('\n\n')[0];
  for (const line of head.split('\n')) if (line.startsWith('tree ')) return line.slice(5).trim();
  return '';
}

function treeEntries(data: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    out.push({ mode, name, sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

function collectTree(sha: string, into: Map<string, Entry>): void {
  if (into.has(sha)) return;
  const entry = getEntry(sha);
  if (entry === undefined) return;
  into.set(sha, entry);
  if (entry.type === 'tree') for (const child of treeEntries(entry.data)) collectTree(child.sha, into);
  if (entry.type === 'tag') {
    const target = entry.data.toString('utf8').split('\n')[0].slice(7).trim();
    if (target !== '') collectTree(target, into);
  }
}

/** Everything reachable from `wants` minus everything reachable from `haves`, honouring `depth`. */
function collect(wants: string[], haves: string[], depth: number | null, knownShallow: string[]): { entries: Entry[]; shallow: string[]; unshallow: string[] } {
  const held = new Map<string, Entry>();
  const haveQueue = [...haves];
  const haveWalked = new Set<string>();
  while (haveQueue.length > 0) {
    const sha = haveQueue.pop() as string;
    if (haveWalked.has(sha)) continue;
    haveWalked.add(sha);
    const entry = getEntry(sha);
    if (entry === undefined) continue;
    held.set(sha, entry);
    if (entry.type === 'commit') {
      collectTree(treeOf(sha), held);
      for (const parent of parentsOf(sha)) haveQueue.push(parent);
    } else {
      collectTree(sha, held);
    }
  }
  const seen = new Map<string, Entry>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const shallowSet = new Set(knownShallow);
  const queue: { sha: string; level: number }[] = wants.map((sha) => ({ sha, level: 0 }));
  const walked = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift() as { sha: string; level: number };
    if (walked.has(item.sha)) continue;
    walked.add(item.sha);
    const entry = getEntry(item.sha);
    if (entry === undefined) continue;
    const alreadyHeld = held.has(item.sha);
    if (entry.type === 'commit') {
      if (!alreadyHeld) {
        seen.set(item.sha, entry);
        collectTree(treeOf(item.sha), seen);
      }
      const parents = parentsOf(item.sha);
      if (!alreadyHeld && depth !== null && item.level + 1 >= depth) {
        if (parents.length > 0) shallow.push(item.sha);
        continue;
      }
      for (const parent of parents) queue.push({ sha: parent, level: item.level + 1 });
    } else if (!alreadyHeld) {
      collectTree(item.sha, seen);
    }
  }
  for (const boundary of shallowSet) if (!shallow.includes(boundary)) unshallow.push(boundary);
  const entries: Entry[] = [];
  for (const [sha, entry] of seen) if (!held.has(sha)) entries.push(entry);
  return { entries, shallow, unshallow };
}

// ------------------------------------------------------------------ advertisement
const UPLOAD_CAPS = ['agent=git/makefun-1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta', 'agent=git/makefun-1.0'];

function advertiseV2(repo: Repo): Buffer {
  const parts = [pkt('version 2\n')];
  for (const cap of UPLOAD_CAPS) parts.push(pkt(`${cap}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : ['side-band-64k', 'ofs-delta', 'shallow', 'multi_ack_detailed', 'thin-pack', 'no-progress', 'agent=git/makefun-1.0', 'symref=HEAD:refs/heads/' + repo.defaultBranch];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const lines: Buffer[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const ordered: [string, string][] = [];
  if (head !== undefined) ordered.push(['HEAD', head]);
  for (const [name, sha] of refs) ordered.push([name, sha]);
  if (ordered.length === 0) {
    lines.push(pkt(`${ZERO} capabilities^{}\u0000${caps.join(' ')}\n`));
  } else {
    ordered.forEach(([name, sha], index) => {
      lines.push(pkt(index === 0 ? `${sha} ${name}\u0000${caps.join(' ')}\n` : `${sha} ${name}\n`));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ------------------------------------------------------------------ handlers
export async function handleGit(ctx: Ctx): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.path);
  if (match === null) return false;
  const repo = getRepo(match[1], match[2]);
  if (repo === undefined) {
    sendMessage(ctx, 404, 'Not Found');
    return true;
  }
  const route = match[3];

  if (route === 'info/refs') {
    const service = ctx.query.get('service') ?? '';
    const wantsV2 = (ctx.req.headers['git-protocol'] as string | undefined ?? '').includes('version=2');
    if (service === 'git-upload-pack') {
      const body = wantsV2 ? advertiseV2(repo) : Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, advertiseV0(repo, 'git-upload-pack')]);
      send(ctx, 200, body, 'application/x-git-upload-pack-advertisement', {
        'cache-control': 'no-cache, max-age=0, must-revalidate',
        pragma: 'no-cache',
        expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
      });
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH, advertiseV0(repo, 'git-receive-pack')]);
      send(ctx, 200, body, 'application/x-git-receive-pack-advertisement', {
        'cache-control': 'no-cache, max-age=0, must-revalidate',
        pragma: 'no-cache',
      });
      return true;
    }
    sendMessage(ctx, 403, 'Smart HTTP is not enabled for this repository');
    return true;
  }

  const packets = decodePackets(ctx.body);
  if (route === 'git-upload-pack') {
    const command = packets.find((packet) => packet.kind === 'data' && text(packet).startsWith('command='));
    if (command !== undefined && text(command) === 'command=ls-refs') {
      send(ctx, 200, lsRefs(repo, packets), 'application/x-git-upload-pack-result');
      return true;
    }
    send(ctx, 200, fetch(repo, packets), 'application/x-git-upload-pack-result');
    return true;
  }
  send(ctx, 200, receivePack(repo, ctx.body, packets), 'application/x-git-receive-pack-result');
  return true;
}

function lsRefs(repo: Repo, packets: Packet[]): Buffer {
  const args = packets.filter((packet) => packet.kind === 'data').map(text);
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const out: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const head = repo.refs.get(headTarget);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    if (head !== undefined) out.push(pkt(`${head}${' '.repeat(1)}HEAD${wantSymrefs ? ` symref-target:${headTarget}` : ''}\n`));
    else if (wantUnborn) out.push(pkt(`unborn HEAD${wantSymrefs ? ` symref-target:${headTarget}` : ''}\n`));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, sha] of refs) {
    if (!keep(name)) continue;
    let line = `${sha} ${name}`;
    if (wantSymrefs && name === headTarget) line += ` symref-target:${headTarget}`;
    if (wantPeel) {
      const entry = getEntry(sha);
      if (entry !== undefined && entry.type === 'tag') {
        const target = entry.data.toString('utf8').split('\n')[0].slice(7).trim();
        if (target !== '') line += ` peeled:${target}`;
      }
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function fetch(repo: Repo, packets: Packet[]): Buffer {
  const args = packets.filter((packet) => packet.kind === 'data').map(text);
  const wants = args.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
  const haves = args.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const shallow = args.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
  const deepenLine = args.find((line) => line.startsWith('deepen '));
  const depth = deepenLine === undefined ? null : Number(deepenLine.slice(7).trim());
  const out: Buffer[] = [];
  if (wants.length === 0) {
    out.push(FLUSH);
    return Buffer.concat(out);
  }
  const effective = depth;
  const gathered = collect(wants, haves, effective, shallow);
  if (haves.length > 0) {
    out.push(pkt('acknowledgments\n'));
    for (const have of haves.slice(0, 1)) out.push(pkt(`ACK ${have}\n`));
    out.push(pkt('ready\n'), FLUSH);
  }
  if (depth !== null || gathered.shallow.length > 0 || gathered.unshallow.length > 0) {
    out.push(pkt('shallow-info\n'));
    for (const sha of gathered.shallow) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of gathered.unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(FLUSH);
  }
  const entries = gathered.entries.filter((entry): entry is Entry => entry !== undefined && entry.data !== undefined);
  const pack = writePack(entries);
  out.push(pkt('packfile\n'));
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ receive-pack
interface PushCommand { old: string; next: string; ref: string }

function splitReceive(body: Buffer): { commands: PushCommand[]; caps: string[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let i = 0;
  let packStart = body.length;
  while (i + 4 <= body.length) {
    const len = parseInt(body.toString('ascii', i, i + 4), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) { packStart = i + 4; break; }
    if (len < 4) break;
    const payload = body.subarray(i + 4, i + len);
    i += len;
    let line = payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      caps = line.slice(nul + 1).split(' ').filter((value) => value.length > 0);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]) === true && /^[0-9a-f]{40}$/.test(parts[1]) === true) {
      commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
    }
  }
  return { commands, caps, pack: body.subarray(packStart) };
}

function isAncestor(ancestor: string, descendant: string, limit = 5000): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  let steps = 0;
  while (queue.length > 0 && steps < limit) {
    const sha = queue.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    steps += 1;
    for (const parent of parentsOf(sha)) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

function receivePack(repo: Repo, body: Buffer, _packets: Packet[]): Buffer {
  const { commands, caps, pack } = splitReceive(body);
  let unpackStatus = 'ok';
  if (pack.length > 0) {
    try {
      const read = readPack(pack);
      for (const [sha, entry] of read.objects) {
        if (!objects.has(sha)) objects.set(sha, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackStatus = `error ${err instanceof Error ? err.message : 'bad pack'}`;
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    if (command.ref.startsWith('refs/') === false) {
      results.push({ ref: command.ref, ok: false, reason: 'funny refname' });
      continue;
    }
    if (command.next === ZERO) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (current === undefined) {
      repo.refs.set(command.ref, command.next);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === command.next) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.old !== ZERO && command.old !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (isAncestor(current, command.next) === false && command.ref.startsWith('refs/tags/') === false) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.next);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const lines: string[] = [`unpack ${unpackStatus}`];
  for (const result of results) lines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  const out: Buffer[] = [];
  const wantsBoth = caps.includes('report-status') || caps.includes('report-status-v2');
  if (caps.includes('side-band-64k')) {
    for (const line of wantsBoth ? lines : []) out.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
  } else {
    for (const line of wantsBoth ? lines : []) out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}
