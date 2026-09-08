import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/prepare-vercel.mjs', import.meta.url));
const fixtureDirectory = fileURLToPath(new URL('../public/demo/', import.meta.url));
const { prepareVercel } = (await import(pathToFileURL(script).href)) as {
  prepareVercel(input: string, output: string): Promise<{ directory: string; files: number }>;
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function artifact() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-vercel-test-'));
  temporaryDirectories.push(root);
  const input = path.join(root, 'dist');
  const output = path.join(root, 'deployment');
  await mkdir(path.join(input, 'assets'), { recursive: true });
  await cp(fixtureDirectory, path.join(input, 'demo'), { recursive: true });
  const files = {
    'index.html': Buffer.from('<!doctype html><script src="./assets/index-aB0_-123.js"></script>'),
    'assets/index-aB0_-123.js': Buffer.from('export const text = "Synthetic ☃ fixture";\n'),
    'assets/index-12345678.css': Buffer.from('body { color: #24292e; }\n'),
    'assets/session_parser_bg-ABCDEFGH.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  await Promise.all(
    Object.entries(files).map(([name, bytes]) => writeFile(path.join(input, name), bytes)),
  );
  return { root, input, output };
}

async function inventory(directory: string, relative = ''): Promise<string[]> {
  const entries: string[] = [];
  for (const name of await readdir(path.join(directory, relative))) {
    const filename = path.join(relative, name);
    if ((await lstat(path.join(directory, filename))).isDirectory()) {
      entries.push(...(await inventory(directory, filename)));
    } else {
      entries.push(filename);
    }
  }
  return entries.sort();
}

test('packages only byte-identical static assets with production Vercel headers and real 404s', async () => {
  const { input, output } = await artifact();
  const result = await prepareVercel(input, output);
  expect(result).toEqual({ directory: output, files: 8 });
  expect(await readdir(output)).toEqual(['.vercel']);
  expect(await readdir(path.join(output, '.vercel'))).toEqual(['output']);
  const buildOutput = path.join(output, '.vercel/output');
  expect((await readdir(buildOutput)).sort()).toEqual(['config.json', 'static']);
  const staticDirectory = path.join(buildOutput, 'static');
  const names = await inventory(input);
  expect(await inventory(staticDirectory)).toEqual(names);
  for (const name of names) {
    expect(await readFile(path.join(staticDirectory, name))).toEqual(
      await readFile(path.join(input, name)),
    );
  }
  const config = JSON.parse(await readFile(path.join(buildOutput, 'config.json'), 'utf8'));
  expect(config.version).toBe(3);
  expect(config.routes[0].headers).toEqual({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  expect(config.routes[1].headers['Cache-Control']).toBe('no-cache');
  expect(new RegExp(config.routes[1].src).test('/')).toBe(true);
  expect(new RegExp(config.routes[1].src).test('/index.html')).toBe(true);
  expect(config.routes[2].headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  const immutableAssets = new RegExp(config.routes[2].src);
  for (const name of names.filter((name) => name.startsWith('assets/'))) {
    expect(immutableAssets.test(`/${name}`)).toBe(true);
  }
  expect(immutableAssets.test('/assets/__missing__.wasm')).toBe(false);
  expect(immutableAssets.test('/assets/index-aB0_-123Xjs')).toBe(false);
  expect(immutableAssets.test('/assets/index-aB0_-123.js/extra')).toBe(false);
  expect(config.routes.slice(3)).toEqual([
    { src: '^/$', dest: '/index.html' },
    { handle: 'filesystem' },
    { src: '^/.*$', status: 404 },
  ]);
  expect(config.overrides['assets/session_parser_bg-ABCDEFGH.wasm']).toEqual({
    contentType: 'application/wasm',
  });
});

test('CLI rejects unexpected files before creating a stage, leaving input untouched', async () => {
  const { input, output } = await artifact();
  const secret = 'synthetic credential: must never be copied';
  await writeFile(path.join(input, 'auth.json'), secret);
  await expect(execute(process.execPath, [script, input, output])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Unexpected artifact file: auth.json'),
  });
  await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(input, 'auth.json'), 'utf8')).toBe(secret);
});

test.each(['file', 'directory'])(
  'rejects an artifact %s symlink without following it',
  async (kind) => {
    const { root, input, output } = await artifact();
    if (kind === 'file') {
      const external = path.join(root, 'private.txt');
      await writeFile(external, 'synthetic private data');
      await symlink(external, path.join(input, 'assets/leak-12345678.js'));
    } else {
      await rm(path.join(input, 'assets'), { recursive: true });
      await symlink(root, path.join(input, 'assets'));
    }
    await expect(prepareVercel(input, output)).rejects.toThrow('Symlinks are not allowed');
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

test('rejects renamed session data, malformed WASM, missing fixtures, and unexpected nested files', async () => {
  const cases = [
    {
      name: 'demo/demo-root.jsonl',
      bytes: Buffer.from('{"message":"synthetic private session"}\n'),
      error: 'Demo does not match',
    },
    {
      name: 'assets/session_parser_bg-ABCDEFGH.wasm',
      bytes: Buffer.from('<!doctype html>'),
      error: 'Invalid WebAssembly header',
    },
    { name: 'demo/demo-root.jsonl', error: 'Missing required artifact file' },
    { name: 'assets/source-map.json', bytes: Buffer.from('{}'), error: 'Unexpected artifact file' },
  ];
  for (const entry of cases) {
    const { input, output } = await artifact();
    if (entry.bytes) await writeFile(path.join(input, entry.name), entry.bytes);
    else await rm(path.join(input, entry.name));
    await expect(prepareVercel(input, output)).rejects.toThrow(entry.error);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

test('refuses existing stages and overlapping input/output without deleting their contents', async () => {
  const { input, output } = await artifact();
  await mkdir(output);
  const marker = path.join(output, 'keep.txt');
  await writeFile(marker, 'Do not delete');
  await expect(prepareVercel(input, output)).rejects.toThrow('Output already exists');
  expect(await readFile(marker, 'utf8')).toBe('Do not delete');
  await expect(prepareVercel(input, path.join(input, 'stage'))).rejects.toThrow('must not overlap');
  await expect(prepareVercel(input, path.dirname(input))).rejects.toThrow('must not overlap');
  await expect(lstat(path.join(input, 'stage'))).rejects.toMatchObject({ code: 'ENOENT' });
});
