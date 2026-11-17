// github-core-clone entry point.
//
// The suite scores the HTTP server app.ts builds; this file only carries the lifecycle the
// harness expects. Three steps, in order:
//   1. read MAKEFUN_ENV_URL, the origin of the env that drives the trial; without it nothing
//      can be reached, so the program stops with exit code 1 straight away;
//   2. bind an ephemeral port (the kernel picks it, the env owns 8080) and POST that port to
//      $ENV/register; the env remembers the caller's address and dials it from then on;
//   3. poll $ENV/done until it answers {"done": true}, then close the listener and exit 0.
import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 100;
const RETRY_CEILING_MS = 1_000;
const DONE_POLL_MS = 40;

function die(reason: string): never {
  process.stderr.write(`github-core-clone: ${reason}\n`);
  process.exit(1);
}

function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') die('MAKEFUN_ENV_URL is unset, so there is no env to register with');
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoff(attempt: number): number {
  const grown = RETRY_FIRST_MS * 2 ** Math.min(attempt, 8);
  return grown < RETRY_CEILING_MS ? grown : RETRY_CEILING_MS;
}

// A request that hangs must not hang the whole trial: every fetch carries a deadline.
function deadline(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function bind(server: ReturnType<typeof createApp>['server']): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') die('the listener has no bound port');
  return address.port;
}

// 200 means this process registered; 409 means another entry registered first, which is not this
// process's to repair. A 4xx/5xx is retried while the env may still be booting.
async function register(origin: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ port }),
        signal: deadline(),
      });
      if (answer.status === 200) return;
      if (answer.status === 409) {
        process.stderr.write('github-core-clone: register answered 409, another entry holds the env\n');
        return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      process.stderr.write(`github-core-clone: register attempt ${attempt} failed: ${text}\n`);
    }
    await sleep(backoff(attempt));
  }
}

async function suiteOver(origin: string): Promise<boolean> {
  try {
    const answer = await fetch(`${origin}/done`, {
      headers: { accept: 'application/json' },
      signal: deadline(),
    });
    if (!answer.ok) return false;
    const body = (await answer.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const origin = envOrigin();
  const { server } = createApp();
  const port = await bind(server);
  await register(origin, port);
  while (!(await suiteOver(origin))) {
    await sleep(DONE_POLL_MS);
  }
  process.stderr.write(`github-core-clone: suite over on port ${port}, stopping\n`);
  server.close();
  process.exit(0);
}

void main().catch((err: unknown) => {
  const text = err instanceof Error ? err.message : String(err);
  die(text);
});
