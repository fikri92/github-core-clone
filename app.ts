// The entry's HTTP surface: one server, one dispatcher, one request context per request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendJson, sendMessage, type Ctx } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

const MAX_BODY = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearer(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const space = header.indexOf(' ');
    if (space > 0) {
      const scheme = header.slice(0, space).toLowerCase();
      const value = header.slice(space + 1).trim();
      if ((scheme === 'bearer' || scheme === 'token') && value !== '') return value;
    }
    if (header.startsWith('Basic ')) return header.slice(6);
  }
  const queryToken = url.searchParams.get('access_token');
  return queryToken !== null && queryToken !== '' ? queryToken : null;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const method = (req.method ?? 'GET').toUpperCase();
      let body = Buffer.alloc(0);
      if (method !== 'GET' && method !== 'HEAD') {
        try {
          body = await readBody(req);
        } catch {
          sendMessage({ req, res, method, path: url.pathname, url, query: url.searchParams, body, token: null, json: () => null }, 413, 'Payload Too Large');
          return;
        }
      }
      const ctx: Ctx = {
        req, res, method,
        path: url.pathname,
        url,
        query: url.searchParams,
        body,
        token: bearer(req, url),
        json: () => {
          try {
            return JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            return null;
          }
        },
      };

      if (ctx.path === '/healthz') {
        sendJson(ctx, 200, { ok: true });
        return;
      }
      if (ctx.path === '/api/v3' || ctx.path.startsWith('/api/v3/')) {
        await handleRest(ctx);
        return;
      }
      if (ctx.path === '/api/graphql' || ctx.path === '/graphql') {
        await handleGraphql(ctx);
        return;
      }
      if (ctx.path === '/mcp' || ctx.path.startsWith('/mcp/')) {
        await handleMcp(ctx);
        return;
      }
      if (await handleGit(ctx)) return;
      sendMessage(ctx, 404, 'Not Found');
    })().catch((err: unknown) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }));
        } else {
          res.end();
        }
      } catch {
        // the socket is gone; nothing left to answer
      }
    });
  });
}
