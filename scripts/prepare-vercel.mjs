import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demoNames = [
  'demo-root.jsonl',
  'demo-parser.jsonl',
  'demo-timeline.jsonl',
  'demo-review.jsonl',
];
const fixtureDirectory = fileURLToPath(new URL('../public/demo/', import.meta.url));
const assetName = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css|wasm)$/;
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function readRegularFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${filename}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readArtifact(inputDir) {
  if (!(await lstat(inputDir)).isDirectory()) {
    throw new Error('Input must be a directory, not a symlink.');
  }
  const files = new Map();
  async function visit(relativeDirectory) {
    const names = (await readdir(path.join(inputDir, relativeDirectory))).sort();
    for (const name of names) {
      const relative = path.posix.join(relativeDirectory, name);
      const filename = path.join(inputDir, relative);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${relative}`);
      if (info.isDirectory()) {
        if (relative !== 'assets' && relative !== 'demo') {
          throw new Error(`Unexpected artifact directory: ${relative}`);
        }
        await visit(relative);
        continue;
      }
      if (!info.isFile()) throw new Error(`Not a regular artifact file: ${relative}`);
      const extension = relativeDirectory === 'assets' ? assetName.exec(name)?.[1] : undefined;
      const isDemo = relativeDirectory === 'demo' && demoNames.includes(name);
      if (relative !== 'index.html' && !extension && !isDemo) {
        throw new Error(`Unexpected artifact file: ${relative}`);
      }
      const bytes = await readRegularFile(filename);
      if (
        extension === 'wasm' &&
        !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
      ) {
        throw new Error(`Invalid WebAssembly header: ${relative}`);
      }
      if (isDemo && !bytes.equals(await readFile(path.join(fixtureDirectory, name)))) {
        throw new Error(`Demo does not match the checked-in synthetic fixture: ${relative}`);
      }
      files.set(relative, bytes);
    }
  }
  await visit('');
  for (const required of ['index.html', ...demoNames.map((name) => `demo/${name}`)]) {
    if (!files.has(required)) throw new Error(`Missing required artifact file: ${required}`);
  }
  for (const extension of ['js', 'css', 'wasm']) {
    if (
      ![...files.keys()].some(
        (name) => name.startsWith('assets/') && name.endsWith(`.${extension}`),
      )
    ) {
      throw new Error(`Missing hashed ${extension} asset.`);
    }
  }
  return files;
}

function configuration(files) {
  const assetPaths = [...files.keys()]
    .filter((name) => name.startsWith('assets/'))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const overrides = {};
  for (const name of files.keys()) {
    if (name.endsWith('.wasm')) overrides[name] = { contentType: 'application/wasm' };
    if (name.endsWith('.jsonl')) overrides[name] = { contentType: 'application/x-ndjson' };
  }
  return {
    version: 3,
    routes: [
      {
        src: '^/.*$',
        headers: {
          'Content-Security-Policy': contentSecurityPolicy,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
        continue: true,
      },
      { src: '^/(?:index\\.html)?$', headers: { 'Cache-Control': 'no-cache' }, continue: true },
      {
        src: `^/(?:${assetPaths.join('|')})$`,
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        continue: true,
      },
      { src: '^/$', dest: '/index.html' },
      { handle: 'filesystem' },
      { src: '^/.*$', status: 404 },
    ],
    overrides,
  };
}

/** Package an already-verified build without including any source or local data. */
export async function prepareVercel(inputDir = 'dist', outputDir = 'outputs/vercel') {
  const input = path.resolve(inputDir);
  const output = path.resolve(outputDir);
  if (isWithin(input, output) || isWithin(output, input)) {
    throw new Error('Input and output directories must not overlap.');
  }
  try {
    await lstat(output);
    throw new Error('Output already exists; use a fresh staging directory. No files were removed.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const files = await readArtifact(input);
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(output), '.vercel-package-'));
  try {
    const buildOutput = path.join(temporary, '.vercel', 'output');
    const staticDirectory = path.join(buildOutput, 'static');
    await mkdir(path.join(staticDirectory, 'assets'), { recursive: true });
    await mkdir(path.join(staticDirectory, 'demo'));
    for (const [relative, bytes] of files) {
      await writeFile(path.join(staticDirectory, relative), bytes, { flag: 'wx' });
    }
    await writeFile(
      path.join(buildOutput, 'config.json'),
      `${JSON.stringify(configuration(files), null, 2)}\n`,
      { flag: 'wx' },
    );
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { directory: output, files: files.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 4) {
    process.stderr.write('Usage: node scripts/prepare-vercel.mjs [dist] [outputs/vercel]\n');
    process.exitCode = 1;
  } else {
    try {
      const result = await prepareVercel(process.argv[2], process.argv[3]);
      process.stdout.write(`Prepared ${result.files} static files in ${result.directory}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
