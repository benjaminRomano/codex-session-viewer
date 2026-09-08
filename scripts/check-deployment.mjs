#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const HASHED_ASSET = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm)$/;
const MIME = {
  '.html': ['text/html'],
  '.js': ['text/javascript', 'application/javascript'],
  '.css': ['text/css'],
  '.wasm': ['application/wasm'],
};
class VerificationError extends Error {}
class ContentMismatchError extends VerificationError {}
class TransientVerificationError extends VerificationError {}
const TRANSIENT_STATUSES = new Set([404, 429, 500, 502, 503, 504]);
function requireThat(condition, message) {
  if (!condition) throw new VerificationError(message);
}

function checkHeaders(response, relative) {
  const headers = response.headers;
  requireThat(
    headers.get('x-content-type-options')?.toLowerCase() === 'nosniff',
    `${relative}: missing nosniff`,
  );
  requireThat(
    headers.get('referrer-policy')?.toLowerCase() === 'no-referrer',
    `${relative}: missing no-referrer`,
  );
  const policy = new Map();
  for (const directive of (headers.get('content-security-policy') ?? '').split(';')) {
    const [rawName, ...values] = directive.trim().split(/\s+/);
    const name = rawName.toLowerCase();
    requireThat(!policy.has(name), `${relative}: duplicate CSP directive`);
    if (name) policy.set(name, values);
  }
  for (const [name, values] of [
    ['connect-src', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['script-src', ["'self'", "'wasm-unsafe-eval'"]],
  ]) {
    const actual = policy.get(name) ?? [];
    requireThat(
      actual.length === values.length && values.every((value) => actual.includes(value)),
      `${relative}: invalid CSP ${name}`,
    );
  }
  const allowed = MIME[path.extname(relative)];
  if (allowed) {
    const mime = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    requireThat(allowed.includes(mime), `${relative}: incorrect Content-Type`);
  }
  const cache = new Set(
    (headers.get('cache-control') ?? '')
      .toLowerCase()
      .split(',')
      .map((part) => part.trim()),
  );
  if (relative === 'index.html') {
    requireThat(
      !cache.has('immutable') &&
        (cache.has('no-cache') ||
          cache.has('no-store') ||
          (cache.has('max-age=0') && cache.has('must-revalidate'))),
      'index.html: cache must revalidate',
    );
  } else if (HASHED_ASSET.test(relative)) {
    requireThat(
      cache.has('public') &&
        cache.has('immutable') &&
        !cache.has('no-cache') &&
        !cache.has('no-store') &&
        [...cache].some((part) => /^max-age=[1-9]\d*$/.test(part)),
      `${relative}: hashed asset must be cached immutably`,
    );
  }
}

async function inventory(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    requireThat(!entry.isSymbolicLink(), `${name}: staged symlinks are not supported`);
    if (entry.isDirectory()) files.push(...(await inventory(directory, name)));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(directory, name));
      files.push({
        relative: name,
        bytes: bytes.length,
        hash: createHash('sha256').update(bytes).digest('hex'),
      });
    } else throw new VerificationError(`${name}: unsupported staged file type`);
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function verify(url, file, signal, missing = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const expectedStatus = missing ? 404 : 200;
      if (response.status !== expectedStatus) {
        await response.body?.cancel();
        if (attempt < 2 && TRANSIENT_STATUSES.has(response.status)) {
          await delay(attempt ? 750 : 250, undefined, { signal });
          continue;
        }
        const ErrorType = TRANSIENT_STATUSES.has(response.status)
          ? TransientVerificationError
          : VerificationError;
        throw new ErrorType(
          `${file.relative}: expected HTTP ${expectedStatus}, received ${response.status}`,
        );
      }
      if (missing) {
        await response.body?.cancel();
        return;
      }
      try {
        checkHeaders(response, file.relative);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      if (response.body)
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > file.bytes)
            throw new ContentMismatchError(`${file.relative}: deployed bytes differ`);
          hash.update(chunk);
        }
      if (bytes !== file.bytes || hash.digest('hex') !== file.hash)
        throw new ContentMismatchError(`${file.relative}: deployed bytes differ`);
      return;
    } catch (error) {
      if (signal.aborted)
        throw new VerificationError(
          'Deployment verification cancelled or exceeded its 120-second deadline',
        );
      if (error instanceof VerificationError || attempt === 2) throw error;
      await delay(attempt ? 750 : 250, undefined, { signal });
    }
  }
}

async function waitForIndex(base, index, signal) {
  const readiness = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
  let attempt = 0;
  while (true) {
    try {
      // The production alias can briefly retain the prior document. Wait for
      // both entry routes before requesting assets named only by the new build.
      await verify(base, index, readiness);
      await verify(new URL('index.html', base), index, readiness);
      return;
    } catch (error) {
      if (signal.aborted)
        throw new VerificationError('Deployment verification exceeded its 120-second deadline');
      if (readiness.aborted)
        throw new VerificationError('Production index did not become ready within 40 seconds');
      if (
        error instanceof VerificationError &&
        !(error instanceof ContentMismatchError) &&
        !(error instanceof TransientVerificationError)
      )
        throw error;
      try {
        await delay(Math.min(250 * 2 ** attempt++, 2_000), undefined, { signal: readiness });
      } catch {
        throw new VerificationError(
          signal.aborted
            ? 'Deployment verification exceeded its 120-second deadline'
            : 'Production index did not become ready within 40 seconds',
        );
      }
    }
  }
}

/** Verify the staged static bundle without uploading or changing any deployment. */
export async function checkDeployment(url, staticDir) {
  const base = new URL(url);
  requireThat(
    ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    'Use an HTTP(S) deployment URL without credentials, query or fragment',
  );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const files = await inventory(path.resolve(staticDir));
  const index = files.find((file) => file.relative === 'index.html');
  requireThat(index, 'The staged static directory must contain index.html');
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
  await waitForIndex(base, index, signal);
  const requests = [
    ...files.map((file) => ({
      file,
      url: new URL(file.relative.split('/').map(encodeURIComponent).join('/'), base),
    })),
    { file: index, url: base },
    {
      file: { relative: 'assets/__missing__.wasm' },
      url: new URL('assets/__missing__.wasm', base),
      missing: true,
    },
  ];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (cursor < requests.length && !signal.aborted) {
      const request = requests[cursor++];
      await verify(request.url, request.file, signal, request.missing);
    }
  });
  try {
    await Promise.all(workers);
  } catch (error) {
    abort.abort();
    await Promise.allSettled(workers);
    throw error;
  }
  requireThat(!signal.aborted, 'Deployment verification exceeded its deadline');
  return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4)
      throw new Error('Usage: node scripts/check-deployment.mjs URL STATIC_DIR');
    const result = await checkDeployment(process.argv[2], process.argv[3]);
    console.log(
      `Verified ${result.files} deployed files (${result.bytes} bytes), root document and missing-asset 404.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
