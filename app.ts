import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendMessage } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';
import type { Ctx } from './http.ts';

const MAX_BODY = 8 * 1024 * 1024;

export interface AppState {
  requests: number;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

function tokenOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  return match === null ? null : (match[1] ?? null);
}

export function createApp() {
  const state: AppState = { requests: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const question = req.url ?? '/';
    const at = question.indexOf('?');
    const path = at === -1 ? question : question.slice(0, at);
    const search = at === -1 ? '' : question.slice(at + 1);
    void (async () => {
      let body: Buffer = Buffer.alloc(0);
      try {
        body = await readBody(req);
      } catch {
        sendMessage({ req, res, method: req.method ?? 'GET', path, query: new URLSearchParams(search), token: null, body: Buffer.alloc(0), json: () => null }, 413, 'Payload too large');
        return;
      }
      let parsed: unknown = undefined;
      let parsedOnce = false;
      let parseFailed = false;
      const ctx: Ctx = {
        req,
        res,
        method: (req.method ?? 'GET').toUpperCase(),
        path,
        query: new URLSearchParams(search),
        token: tokenOf(req),
        body,
        json(): unknown {
          if (!parsedOnce) {
            parsedOnce = true;
            try {
              const text = body.toString('utf8');
              parsed = text.trim() === '' ? null : JSON.parse(text);
            } catch {
              parseFailed = true;
              parsed = null;
            }
          }
          if (parseFailed) throw new Error('malformed json');
          return parsed;
        },
      };
      state.requests += 1;
      try {
        if (path === '/healthz' || path === '/healthz/') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (path === '/mcp' || path.startsWith('/mcp/')) {
          await handleMcp(ctx);
          return;
        }
        if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
          await handleGraphql(ctx);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(ctx);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) {
          await handleGit(ctx);
          return;
        }
        if (path === '/' || path === '') {
          sendJson(ctx, 200, { name: 'github-core-clone', ok: true, surfaces: ['/api/v3', '/api/graphql', '/mcp', '/{owner}/{repo}.git'] });
          return;
        }
        sendMessage(ctx, 404, 'Not Found');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'error';
        if (message === 'malformed json') {
          if (!res.headersSent) sendMessage(ctx, 400, 'Problems parsing JSON');
          return;
        }
        if (!res.headersSent) sendMessage(ctx, 500, 'Internal Server Error');
      }
    })();
  });
  return { server, state };
}
