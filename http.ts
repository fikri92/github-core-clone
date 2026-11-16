// HTTP helpers shared by every module: one request context, JSON answers, error shapes.
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly token: string | null;
  /** The request also carried a session/query token the entry accepted. */
  readonly json: () => unknown;
}

export const JSON_TYPE = 'application/json; charset=utf-8';
let requestSeq = 0;

export function nextRequestId(): string {
  requestSeq += 1;
  return `mf-${requestSeq.toString(16).padStart(8, '0')}`;
}

export function send(ctx: Ctx, status: number, body: Buffer, type: string, headers: Record<string, string | undefined> = {}): void {
  const res = ctx.res;
  if (res.headersSent) return;
  const out: Record<string, string | number> = {
    'content-type': type,
    'content-length': body.length,
    'x-github-request-id': (headers['x-github-request-id'] as string) ?? nextRequestId(),
  };
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = v;
  res.writeHead(status, out);
  res.end(body);
}

export function sendJson(ctx: Ctx, status: number, value: unknown, headers: Record<string, string | undefined> = {}): void {
  const text = JSON.stringify(value);
  send(ctx, status, Buffer.from(text, 'utf8'), JSON_TYPE, headers);
}

export function sendMessage(ctx: Ctx, status: number, message: string, headers: Record<string, string | undefined> = {}): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' }, headers);
}

export function sendEmpty(ctx: Ctx, status: number, headers: Record<string, string | undefined> = {}): void {
  send(ctx, status, Buffer.alloc(0), JSON_TYPE, headers);
}

export function sendHtml(ctx: Ctx, status: number, html: string): void {
  send(ctx, status, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
}

export function methodNotAllowed(ctx: Ctx, allow: string): void {
  sendMessage(ctx, 405, 'Method Not Allowed', { allow });
}

/** A pagination Link header for `next` (absolute URL) when there is one. */
export function linkHeader(next: string | null): Record<string, string | undefined> {
  return next === null ? {} : { link: `<${next}>; rel="next"` };
}

export function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(100, Math.trunc(perRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

export function baseOrigin(ctx: Ctx): string {
  const host = (ctx.req.headers.host as string | undefined) ?? '127.0.0.1';
  return `http://${host}`;
}
