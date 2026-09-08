#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (args.includes('--help')) {
  console.log(`Browser loading benchmark (uses demo files unless --directory is explicitly supplied).

  npm run bench:browser
  npm run bench:browser -- --directory ~/.codex
  npm run bench:browser -- --directory ~/.codex --active-only
  npm run bench:browser -- --directory ~/.codex --archived-only
  npm run bench:browser -- --directory ~/.codex --limit 50 --url http://127.0.0.1:5173

Options: --directory PATH, --active-only, --archived-only, --limit N, --root SESSION_ID,
         --workers N, --url VITE_DEV_URL, --output REPORT_PATH, --headed.

Only sessions/, archived_sessions/, and session_index.jsonl are admitted.
The report contains aggregate timings and counts, never session content or titles.`);
  process.exit(0);
}
const selectedDirectory = value('--directory');
const isReal = !!selectedDirectory;
const directory = isReal
  ? path.resolve(selectedDirectory.replace(/^~(?=\/|$)/, os.homedir()))
  : path.resolve('public/demo');
const limit = value('--limit') ? Number(value('--limit')) : Infinity;
const workers = Number(value('--workers') ?? 4);
if (!(limit > 0) || !(workers > 0 && workers <= 16 && Number.isInteger(workers)))
  throw new Error('Use a positive limit and 1–16 workers.');
if (args.includes('--active-only') && args.includes('--archived-only'))
  throw new Error('Choose either active-only or archived-only.');
const files = [];
async function walk(folder, prefix) {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(folder, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(absolute, relative);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await stat(absolute);
      files.push({ absolute, relative, bytes: info.size });
    }
  }
}
if (isReal) {
  if (!args.includes('--archived-only')) await walk(path.join(directory, 'sessions'), 'sessions');
  if (!args.includes('--active-only'))
    await walk(path.join(directory, 'archived_sessions'), 'archived_sessions');
} else await walk(directory, 'sessions');
files.sort((a, b) => a.bytes - b.bytes);
if (Number.isFinite(limit)) files.splice(limit);
const rolloutCount = files.length;
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
if (!rolloutCount)
  throw new Error('No scoped rollout files found. Check public/demo or select a Codex directory.');
if (isReal) {
  const indexPath = path.join(directory, 'session_index.jsonl');
  try {
    const info = await stat(indexPath);
    files.push({ absolute: indexPath, relative: 'session_index.jsonl', bytes: info.size });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
let server;
let browser;
const url = value('--url') ?? 'http://127.0.0.1:5175';
const output = path.resolve(value('--output') ?? 'outputs/benchmarks/browser.json');
try {
  if (!value('--url')) {
    console.log('CODEX_BENCH {"phase":"server-startup"}');
    // Other agents may be editing source while a multi-gigabyte scan runs. Disable HMR
    // so unrelated edits cannot navigate away and destroy a benchmark in progress.
    server = await createServer({
      server: { host: '127.0.0.1', port: 5175, strictPort: true, hmr: false },
    });
    await server.listen();
  }
  const launch = {
    headless: !args.includes('--headed'),
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  };
  console.log('CODEX_BENCH {"phase":"browser-startup"}');
  browser = await chromium.launch(launch);
  const page = await browser.newPage();
  page.setDefaultTimeout(isReal ? 600_000 : 30_000);
  page.on('console', (event) => {
    const text = event.text();
    if (text.startsWith('CODEX_BENCH ')) console.log(text);
  });
  console.log('CODEX_BENCH {"phase":"page-startup"}');
  // This measures SessionStore/ParserPool, not a second application instance.
  // Keep the origin for module imports, without mounting the UI's own workers.
  await page.route(new URL(url).href, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
  );
  // Awaited imports below provide readiness; background network idleness does not.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'benchmark-local-files';
    input.hidden = true;
    document.body.append(input);
  });
  // Playwright sets local paths with Chromium's file chooser protocol. It does not read and
  // serialize 21 GB of bytes through Node or send them to the Vite server.
  console.log('CODEX_BENCH {"phase":"file-selection"}');
  await page.locator('#benchmark-local-files').setInputFiles(files.map((file) => file.absolute));
  console.log(
    `CODEX_BENCH ${JSON.stringify({ phase: 'start', source: isReal ? 'local' : 'demo', files: rolloutCount, bytes: totalBytes, workers })}`,
  );
  const report = await page.evaluate(
    async ({ relativePaths, workers, requestedRoot }) => {
      const { SessionStore } = await import('/src/lib/session-store.ts');
      const { ParserPool, PARSER_VERSION } = await import('/src/lib/parser-pool.ts');
      const errorKinds = (errors) => {
        const counts = {};
        for (const error of errors) {
          const kind = /no valid session metadata/i.test(error)
            ? 'missing-session-metadata'
            : /identity differs/i.test(error)
              ? 'identity-mismatch'
              : /could not be read|permission|file or directory|not found|notreadable/i.test(error)
                ? 'file-access'
                : /unreachable|out of bounds|recursive use|null pointer/i.test(error)
                  ? 'parser-runtime'
                  : /memory|allocation/i.test(error)
                    ? 'memory'
                    : 'other';
          counts[kind] = (counts[kind] ?? 0) + 1;
        }
        return counts;
      };
      const errorNames = (errors) => {
        const counts = {};
        for (const error of errors) {
          const name = error.match(/: ([A-Za-z]+(?:Error|Exception)):/)?.[1] ?? 'Error';
          counts[name] = (counts[name] ?? 0) + 1;
        }
        return counts;
      };
      const input = document.querySelector('#benchmark-local-files');
      const selected = [...input.files];
      selected.forEach((file, index) =>
        Object.defineProperty(file, 'webkitRelativePath', {
          value: `.codex/${relativePaths[index]}`,
        }),
      );
      localStorage.removeItem('codex-session-viewer:metadata');
      let maxTimerDelay = 0,
        timerTicks = 0,
        previousTick = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxTimerDelay = Math.max(maxTimerDelay, now - previousTick - 10);
        previousTick = now;
        timerTicks++;
      }, 10);
      const longTasks = [];
      const observer = new PerformanceObserver((list) =>
        longTasks.push(...list.getEntries().map((entry) => entry.duration)),
      );
      try {
        observer.observe({ type: 'longtask', buffered: false });
      } catch {
        /* unsupported metric */
      }
      const store = new SessionStore(new ParserPool(workers));
      let lastReport = 0,
        firstVisibleMs = null;
      const coldStart = performance.now();
      try {
        const cold = await store.openFiles(selected, {
          concurrency: workers,
          onProgress: (progress) => {
            if (firstVisibleMs === null && progress.sessions.length)
              firstVisibleMs = performance.now() - coldStart;
            if (performance.now() - lastReport > 1000 || progress.phase === 'complete') {
              lastReport = performance.now();
              console.log(
                `CODEX_BENCH ${JSON.stringify({ phase: progress.phase, completed: progress.completed, total: progress.total, bytesProcessed: progress.bytesProcessed })}`,
              );
            }
          },
        });
        const coldMs = performance.now() - coldStart;
        const coldTimerDelay = maxTimerDelay;
        const coldLongTasks = [...longTasks];
        const warmStart = performance.now();
        const warm = await store.scan({ concurrency: workers });
        const warmMs = performance.now() - warmStart;
        const eligible = warm.sessions.filter(
          (entry) => !entry.parentId && entry.size < 128 * 1024 * 1024,
        );
        const candidates = eligible.some((entry) => !entry.archived)
          ? eligible.filter((entry) => !entry.archived)
          : eligible;
        candidates.sort(
          (a, b) => b.childIds.length - a.childIds.length || b.recordCount - a.recordCount,
        );
        const root = requestedRoot
          ? warm.sessions.find((entry) => entry.id === requestedRoot)
          : (candidates[0] ?? warm.sessions[0]);
        let graph = null;
        if (root) {
          const lazyStart = performance.now();
          const lazy = await store.loadGraph(root.id, { mode: 'lazy', concurrency: workers });
          const lazyMs = performance.now() - lazyStart;
          const eagerStart = performance.now();
          const eager = await store.loadGraph(root.id, { mode: 'eager', concurrency: workers });
          const eagerMs = performance.now() - eagerStart;
          graph = {
            rootBytes: root.size,
            lazyMs,
            lazyLoaded: lazy.sessions.size,
            lazyDiscovered: lazy.discovered,
            eagerMs,
            eagerLoaded: eager.sessions.size,
            eagerDiscovered: eager.discovered,
            missing: eager.missing.length,
            errors: Object.keys(eager.errors).length,
            spans: [...eager.sessions.values()].reduce(
              (sum, session) => sum + session.spans.length,
              0,
            ),
            warnings: [...eager.sessions.values()].reduce(
              (sum, session) => sum + session.warnings.length,
              0,
            ),
          };
        }
        const totalBytes = selected
          .filter((file, index) => relativePaths[index] !== 'session_index.jsonl')
          .reduce((sum, file) => sum + file.size, 0);
        return {
          parserVersion: PARSER_VERSION,
          workers,
          metadataWorkers: workers > 2 ? workers - 1 : workers,
          files: cold.fileCount,
          bytes: totalBytes,
          cold: {
            milliseconds: coldMs,
            megabytesPerSecond: totalBytes / 1e6 / (coldMs / 1000),
            firstSessionMs: firstVisibleMs,
            cacheHits: cold.cacheHits,
            indexedSessions: cold.sessions.length,
            errors: cold.errors.length,
            errorKinds: errorKinds(cold.errors),
            errorNames: errorNames(cold.errors),
            malformedLines: cold.sessions.reduce((sum, session) => sum + session.malformedLines, 0),
            oversizedLines: cold.sessions.reduce(
              (sum, session) => sum + (session.oversizedLines ?? 0),
              0,
            ),
            oversizedBytes: cold.sessions.reduce(
              (sum, session) => sum + (session.oversizedBytes ?? 0),
              0,
            ),
            elidedStrings: cold.sessions.reduce(
              (sum, session) => sum + (session.elidedStrings ?? 0),
              0,
            ),
            elidedBytes: cold.sessions.reduce(
              (sum, session) => sum + (session.elidedBytes ?? 0),
              0,
            ),
            records: cold.sessions.reduce((sum, session) => sum + session.recordCount, 0),
          },
          warm: {
            cacheScope: 'current-file-selection',
            milliseconds: warmMs,
            cacheHits: warm.cacheHits,
            errors: warm.errors.length,
            errorKinds: errorKinds(warm.errors),
            errorNames: errorNames(warm.errors),
          },
          responsiveness: {
            timerIntervalMs: 10,
            timerTicks,
            coldMaxTimerDelayMs: coldTimerDelay,
            maxTimerDelayMs: maxTimerDelay,
            coldLongTaskCount: coldLongTasks.length,
            coldLongestTaskMs: Math.max(0, ...coldLongTasks),
            longestTaskMs: Math.max(0, ...longTasks),
          },
          graph,
        };
      } finally {
        clearInterval(timer);
        observer.disconnect();
        store.dispose();
      }
    },
    { relativePaths: files.map((file) => file.relative), workers, requestedRoot: value('--root') },
  );
  const result = {
    timestamp: new Date().toISOString(),
    source: isReal ? 'local' : 'demo',
    includesArchives: isReal && !args.includes('--active-only'),
    includesActive: !args.includes('--archived-only'),
    browser: browser.version(),
    platform: process.platform,
    architecture: process.arch,
    ...report,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Aggregate report saved to ${path.relative(process.cwd(), output)}`);
  if (report.cold.errors || report.warm.errors) process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
}
