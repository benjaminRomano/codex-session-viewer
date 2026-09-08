import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const moduleUrl = new URL('../scripts/check-deployment.mjs', import.meta.url).href;
const { checkDeployment } = (await import(moduleUrl)) as {
  checkDeployment(url: string, staticDir: string): Promise<{ files: number; bytes: number }>;
};
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'";
const JS = '/assets/app-abcdefgh.js';
const CSS = '/assets/app-abcdefgh.css';
const WASM = '/assets/engine-abcdefgh.wasm';
const MISSING = '/assets/__missing__.wasm';
interface Override {
  status?: number;
  body?: string;
  headers?: Record<string, string | null>;
}
let directory: string;
let server: Server;
let url: string;
let files: Record<string, Buffer>;
let overrides: Map<string, Override>;
let requests: Map<string, number>;
let transientPath: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'deployment-check-'));
  files = {
    '/index.html': Buffer.from('<!doctype html><title>Synthetic bundle</title>'),
    [JS]: Buffer.from('export const ready = true;'),
    [CSS]: Buffer.from('body { color: #333 }'),
    [WASM]: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  overrides = new Map();
  requests = new Map();
  transientPath = undefined;
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  server = createServer((request, response) => {
    const name = new URL(request.url!, 'http://localhost').pathname;
    const count = (requests.get(name) ?? 0) + 1;
    requests.set(name, count);
    const file = name === '/' ? '/index.html' : name;
    const override = overrides.get(name);
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
    };
    const headers: Record<string, string> = {
      'content-type': mime[path.extname(file)] ?? 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': CSP,
      'cache-control': file === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    };
    for (const [key, value] of Object.entries(override?.headers ?? {})) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
    const status =
      name === transientPath && count === 1 ? 503 : (override?.status ?? (files[file] ? 200 : 404));
    response.writeHead(status, headers);
    response.end(override?.body ?? files[file] ?? 'Missing synthetic asset');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP test server');
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  try {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('static deployment verification', () => {
  it('checks exact files, root entry, binary bytes, headers and a genuine missing asset', async () => {
    await expect(checkDeployment(url, directory)).resolves.toEqual({
      files: 4,
      bytes: Object.values(files).reduce((total, body) => total + body.length, 0),
    });
    expect([...requests.keys()].sort()).toEqual(
      ['/', '/index.html', JS, CSS, WASM, MISSING].sort(),
    );
  });

  it.each<[string, string, Override, RegExp]>([
    ['changed asset bytes', JS, { body: 'export const ready = false;' }, /deployed bytes differ/],
    [
      'wrong WASM MIME',
      WASM,
      { headers: { 'content-type': 'text/html' } },
      /incorrect Content-Type/,
    ],
    ['missing nosniff', JS, { headers: { 'x-content-type-options': null } }, /missing nosniff/],
    [
      'missing referrer policy',
      JS,
      { headers: { 'referrer-policy': null } },
      /missing no-referrer/,
    ],
    [
      'external connections',
      JS,
      {
        headers: { 'content-security-policy': CSP.replace("connect-src 'self'", 'connect-src *') },
      },
      /invalid CSP connect-src/,
    ],
    [
      'missing WASM execution policy',
      JS,
      { headers: { 'content-security-policy': CSP.replace(" 'wasm-unsafe-eval'", '') } },
      /invalid CSP script-src/,
    ],
    [
      'framing allowed',
      JS,
      {
        headers: {
          'content-security-policy': CSP.replace(
            "frame-ancestors 'none'",
            "frame-ancestors 'self'",
          ),
        },
      },
      /invalid CSP frame-ancestors/,
    ],
    [
      'duplicate CSP directives',
      JS,
      { headers: { 'content-security-policy': `SCRIPT-SRC *; ${CSP}` } },
      /duplicate CSP directive/,
    ],
    [
      'duplicate CSP directives in reverse case order',
      JS,
      { headers: { 'content-security-policy': `${CSP}; SCRIPT-SRC 'self' 'wasm-unsafe-eval'` } },
      /duplicate CSP directive/,
    ],
    [
      'stale index cache',
      '/index.html',
      { headers: { 'cache-control': 'public, max-age=31536000, immutable' } },
      /cache must revalidate/,
    ],
    [
      'mutable hashed asset cache',
      JS,
      { headers: { 'cache-control': 'public, max-age=31536000' } },
      /cached immutably/,
    ],
    [
      'SPA fallback for missing WASM',
      MISSING,
      { status: 200, body: '<html>fallback</html>' },
      /expected HTTP 404, received 200/,
    ],
    [
      'redirected root',
      '/',
      { status: 307, headers: { location: '/index.html' } },
      /expected HTTP 200, received 307/,
    ],
  ])('rejects %s', async (_name, relative, override, error) => {
    overrides.set(relative, override);
    await expect(checkDeployment(url, directory)).rejects.toThrow(error);
  });

  it('retries transient readiness errors without accepting a different asset', async () => {
    transientPath = WASM;
    await expect(checkDeployment(url, directory)).resolves.toMatchObject({ files: 4 });
    expect(requests.get(WASM)).toBe(2);
  });

  it('rejects staged symlinks before making network requests', async () => {
    await symlink(path.join(directory, 'index.html'), path.join(directory, 'linked.html'));
    await expect(checkDeployment(url, directory)).rejects.toThrow(
      'staged symlinks are not supported',
    );
    expect(requests.size).toBe(0);
  });
});
