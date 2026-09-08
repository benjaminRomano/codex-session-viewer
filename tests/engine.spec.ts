import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ParsedSession } from '../src/types';
const binary = path.resolve('target/debug/session-parser');
function native(input: string, args: string[] = []) {
  const process = spawnSync(binary, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (process.status !== 0)
    throw new Error(process.stderr || process.error?.message || 'Native parser failed');
  return JSON.parse(process.stdout);
}
test('native engine and browser WASM produce identical traces, metadata, and analysis', async ({
  page,
}) => {
  test.setTimeout(90000);
  const texts = await Promise.all(
    ['demo-root', 'demo-parser', 'demo-timeline', 'demo-review'].map((name) =>
      readFile(`public/demo/${name}.jsonl`, 'utf8'),
    ),
  );
  const expected = texts.map((text) => native(text) as ParsedSession);
  const metadata = texts.map((text) => native(text, ['--metadata']));
  await page.goto('/');
  const actual = await page.evaluate(async (texts) => {
    const modulePath = '/src/wasm/session_parser.js';
    const engine = await import(/* @vite-ignore */ modulePath);
    await engine.default();
    return texts.map((text) => ({
      trace: JSON.parse(engine.parse_session(text)),
      metadata: JSON.parse(engine.scan_metadata(text)),
    }));
  }, texts);
  expect(actual.map((x) => x.trace)).toEqual(expected);
  expect(actual.map((x) => x.metadata)).toEqual(metadata);
  expect(expected[0].turns).toHaveLength(2);
  expect(expected[0].metadata.childIds).toHaveLength(3);
  expect(expected[1].spans.some((s) => s.status === 'failed' || s.status === 'error')).toBe(true);
  const bounds = {
    start: expected[0].metadata.startTime,
    end: expected[0].metadata.endTime,
    rootId: expected[0].metadata.id,
  };
  const expectedAnalysis = native(JSON.stringify(expected), [
    '--analyze',
    bounds.rootId,
    String(bounds.start),
    String(bounds.end),
  ]);
  const actualAnalysis = await page.evaluate(
    async ({ expected, bounds }) => {
      const modulePath = '/src/wasm/session_parser.js';
      const engine = await import(/* @vite-ignore */ modulePath);
      await engine.default();
      return JSON.parse(
        engine.analyze_sessions(JSON.stringify(expected), bounds.rootId, bounds.start, bounds.end),
      );
    },
    { expected, bounds },
  );
  expect(actualAnalysis).toEqual(expectedAnalysis);
  expect(actualAnalysis.flows.length).toBeGreaterThanOrEqual(5);
  expect(actualAnalysis.path.segments.length).toBeGreaterThan(5);
  expect(actualAnalysis.path.total).toBeLessThanOrEqual(bounds.end - bounds.start);
});

test('browser streaming preserves UTF-8 and malformed final-line behavior', async ({ page }) => {
  await page.goto('/');
  const text =
    (await readFile('public/demo/demo-root.jsonl', 'utf8')).replace(
      'Build a session trace viewer',
      'Inspect λ → 🌐',
    ) + '{"type":"unfinished';
  const expected = native(text);
  const result = await page.evaluate(async (text) => {
    const modulePath = '/src/wasm/session_parser.js';
    const engine = await import(/* @vite-ignore */ modulePath);
    await engine.default();
    const parser = new engine.SessionParser();
    // Vary boundaries through escape sequences, Unicode and JSON token delimiters.
    const chars = [...text];
    for (let i = 0; i < chars.length; i += 7) parser.push(chars.slice(i, i + 7).join(''));
    return JSON.parse(parser.finish());
  }, text);
  expect(result).toEqual(expected);
  expect(result.metadata.malformedLines).toBe(1);
});

test('worker initialization retries a stale HTML asset response without a WASM compile failure', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/*.wasm*', async (route) => {
    requests++;
    if (requests === 1)
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Old asset missing</title>',
      });
    else await route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Explore example', exact: true })
    .click();
  await expect(page.locator('.scope-toolbar')).toContainText('4 agents', { timeout: 30000 });
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(requests).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});
