import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: Buffer;
  json(): unknown;
}

export interface HeaderMap {
  [name: string]: string | undefined;
}

const requestIds = new WeakMap<ServerResponse, string>();

export function makeRequestId(): string {
  const alphabet = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < 16; i += 1) out += alphabet[Math.floor(Math.random() * 16)];
  return `${out}:${Date.now().toString(36).toUpperCase()}`;
}

export function requestId(ctx: Ctx): string {
  const hit = requestIds.get(ctx.res);
  if (hit !== undefined) return hit;
  const made = makeRequestId();
  requestIds.set(ctx.res, made);
  return made;
}

function baseHeaders(ctx: Ctx, headers: HeaderMap | undefined, contentType: string): Record<string, string> {
  const merged: Record<string, string> = { 'content-type': contentType, 'x-github-request-id': requestId(ctx) };
  if (headers === undefined) return merged;
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (value === undefined) continue;
    merged[name.toLowerCase()] = value;
  }
  return merged;
}

export function send(ctx: Ctx, status: number, body: string | Buffer, contentType: string, headers?: HeaderMap): void {
  const out = baseHeaders(ctx, headers, contentType);
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  out['content-length'] = String(buffer.length);
  ctx.res.writeHead(status, out);
  ctx.res.end(buffer);
}

export function sendJson(ctx: Ctx, status: number, value: unknown, headers?: HeaderMap): void {
  send(ctx, status, JSON.stringify(value), 'application/json; charset=utf-8', headers);
}

export function sendMessage(ctx: Ctx, status: number, message: string, headers?: HeaderMap): void {
  sendJson(ctx, status, { message }, headers);
}

export function sendEmpty(ctx: Ctx, status: number, headers?: HeaderMap): void {
  const out = baseHeaders(ctx, headers, 'application/json; charset=utf-8');
  out['content-length'] = '0';
  ctx.res.writeHead(status, out);
  ctx.res.end();
}

export function methodNotAllowed(ctx: Ctx, allow: string): void {
  sendMessage(ctx, 405, `Method not allowed: ${ctx.method} on ${ctx.path}`, { allow });
}

export function linkHeader(next: string | null): HeaderMap {
  return { link: next === null ? undefined : `<${next}>; rel="next"` };
}

export function baseOrigin(ctx: Ctx): string {
  const host = (ctx.req.headers.host as string | undefined) ?? '127.0.0.1';
  return `http://${host}`;
}

export function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const rawPer = Number(query.get('per_page') ?? '');
  const rawPage = Number(query.get('page') ?? '');
  let perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.floor(rawPer) : 30;
  if (perPage > 100) perPage = 100;
  let page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  if (page < 1) page = 1;
  return { perPage, page };
}

export function bearerOf(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(raw);
  if (match === null) return null;
  return match[1] ?? null;
}

export function parseJsonBody(body: string): unknown {
  if (body.trim() === '') return null;
  return JSON.parse(body);
}
