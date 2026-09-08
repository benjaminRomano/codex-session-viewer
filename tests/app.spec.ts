import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
let directory: string;
const rootId = '00000000-0000-4000-8000-000000000001';
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'codex-viewer-test-'));
  await mkdir(path.join(directory, 'sessions'), { recursive: true });
  await mkdir(path.join(directory, 'archived_sessions'), { recursive: true });
  for (const [index, name] of [
    'demo-root',
    'demo-parser',
    'demo-timeline',
    'demo-review',
  ].entries()) {
    await copyFile(
      path.resolve(`public/demo/${name}.jsonl`),
      path.join(directory, index === 1 ? 'archived_sessions' : 'sessions', `${name}.jsonl`),
    );
  }
  await writeFile(
    path.join(directory, 'session_index.jsonl'),
    JSON.stringify({
      id: rootId,
      thread_name: 'Fixture root',
      updated_at: '2026-09-07T20:00:00Z',
    }) + '\n',
  );
  const archived = [
    {
      timestamp: '2026-09-06T12:00:00Z',
      type: 'session_meta',
      payload: { id: '00000000-0000-4000-8000-000000000005' },
    },
    {
      timestamp: '2026-09-06T12:00:01Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'archive-turn' },
    },
    {
      timestamp: '2026-09-06T12:00:01Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Archived root request' },
    },
    {
      timestamp: '2026-09-06T12:00:02Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'archive-turn' },
    },
  ];
  await writeFile(
    path.join(directory, 'archived_sessions', 'archive-root.jsonl'),
    archived.map((record) => JSON.stringify(record)).join('\n'),
  );
  await writeFile(path.join(directory, 'auth.json'), 'THIS MUST NOT BE READ');
});
test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('imports active and archived files, uses index titles, focuses turns, and exports metadata', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outbound: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:5177/') && !r.url().startsWith('data:'))
      outbound.push(r.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open your Codex sessions' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(directory);
  await expect(page.locator('.session-row')).toHaveCount(2, { timeout: 30000 });
  await page.getByRole('button', { name: /^Fixture root / }).click();
  await expect(page.locator('.scope-toolbar')).toContainText('4 agents', { timeout: 30000 });
  await expect(page.getByRole('region', { name: 'Session performance timeline' })).toBeVisible();
  await page.getByRole('button', { name: /^2 Run a final smoke test/ }).click();
  await expect(page.locator('.trace-info')).toContainText('1 agent');
  await expect(page.locator('.trace-time')).toHaveText('8.00 s');
  await expect(page.locator('.prompt-block')).toHaveText('Run a final smoke test');
  await expect(page.locator('.session-list')).toHaveCount(0);
  await expect(page.locator('.span-detail-title')).toContainText('Turn 2');
  await page.getByRole('button', { name: 'Whole session', exact: true }).click();
  await page.locator('.agent-scope-row').filter({ hasText: 'Parser ·' }).click();
  await expect(page.getByRole('button', { name: 'Back to main session' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to main session' }).click();
  await page.getByRole('button', { name: 'All sessions', exact: true }).click();
  await expect(page.locator('.empty-trace')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Session performance timeline' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Archive filter' }).selectOption('archived');
  await expect(page.locator('.session-row')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('.session-row')).toContainText('Archived root request');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export session index' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('codex-session-index.json');
  expect(await page.locator('body').innerText()).not.toMatch(/inferred/i);
  expect(errors).toEqual([]);
  expect(outbound).toEqual([]);
});

test('refreshes the current upload selection and always loads the complete graph', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(directory);
  await expect(page.locator('.session-row')).toHaveCount(2, { timeout: 30000 });
  await page.getByRole('button', { name: /^Fixture root / }).click();
  await expect(page.locator('.scope-toolbar')).toContainText('4 agents', { timeout: 30000 });
  await expect(page.getByRole('combobox', { name: 'Agent loading mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load descendant agents' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click();
  await expect(page.locator('.session-row')).toHaveCount(2);
  await page.getByRole('button', { name: /^Fixture root / }).click();
  const metadata = await page.evaluate(() => localStorage.getItem('codex-session-viewer:metadata'));
  expect(metadata).toBeNull();
  expect(await page.locator('body').innerText()).not.toContain('Diagnostics');
});

test('sidebar and details dock collapse independently, resize, and preserve session navigation', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Explore example', exact: true })
    .click();
  await expect(page.locator('.scope-toolbar')).toContainText('4 agents', { timeout: 30000 });
  await expect(page.locator('.session-list')).toHaveCount(0);
  await expect(page.locator('.agent-scope-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Turn', exact: true }).click();
  await expect(page.locator('.prompt-block')).toContainText('Build a session trace viewer');
  await page.getByRole('button', { name: 'Collapse details panel', exact: true }).click();
  expect((await page.locator('.details-panel').boundingBox())!.height).toBeLessThan(40);
  await page.getByRole('button', { name: 'Expand details panel', exact: true }).click();
  const before = (await page.locator('.details-panel').boundingBox())!.height;
  await page.getByRole('separator', { name: 'Resize details panel' }).focus();
  await page.keyboard.press('ArrowUp');
  expect((await page.locator('.details-panel').boundingBox())!.height).toBeGreaterThan(before);
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowUp');
  expect((await page.locator('.details-panel').boundingBox())!.height).toBe(
    page.viewportSize()!.height - 180,
  );
  for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowDown');
  expect((await page.locator('.details-panel').boundingBox())!.height).toBe(100);
  await page.getByRole('button', { name: 'All sessions', exact: true }).click();
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(page.locator('.empty-trace')).toBeVisible();
  await page.locator('.session-row').first().click();
  await expect(page.locator('.scope-toolbar')).toContainText('4 agents', { timeout: 30000 });
  await expect(page.locator('.agent-icon')).toHaveCount(3);
  await expect(page.locator('.turn-icon')).toHaveCount(2);
});

test('turn selection replaces the trace excerpt with the complete prompt in the dock', async ({
  page,
}) => {
  const prompt = 'Complete text λ and 🌐 with quotes "kept" and newlines.\n'.repeat(2500);
  const records = [
    { timestamp: '2026-09-07T12:00:00Z', type: 'session_meta', payload: { id: rootId } },
    {
      timestamp: '2026-09-07T12:00:01Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'long-turn' },
    },
    {
      timestamp: '2026-09-07T12:00:01.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<recommended_plugins>Auxiliary context only</recommended_plugins>',
          },
        ],
      },
    },
    {
      timestamp: '2026-09-07T12:00:02Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt },
    },
    {
      timestamp: '2026-09-07T12:00:03Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'long-turn' },
    },
  ];
  const folder = await mkdtemp(path.join(os.tmpdir(), 'codex-full-prompt-'));
  try {
    await mkdir(path.join(folder, 'sessions'));
    await writeFile(
      path.join(folder, 'sessions', 'prompt.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n'),
    );
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles(folder);
    await expect(page.locator('.session-row')).toHaveCount(1, { timeout: 30000 });
    await page.locator('.session-row').click();
    await page.getByRole('button', { name: 'Turn', exact: true }).click();
    await expect(page.locator('.detail-loading')).toHaveCount(0);
    await expect.poll(() => page.locator('.prompt-block').textContent()).toBe(prompt);
    await expect(page.locator('.span-detail-title strong')).toHaveText('Turn 1');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('large structured output stays valid on each displayed detail page', async ({ page }) => {
  const text = 'A structured payload with λ and newlines.\n'.repeat(50_000);
  const records = [
    { timestamp: '2026-09-07T12:00:00Z', type: 'session_meta', payload: { id: rootId } },
    {
      timestamp: '2026-09-07T12:00:01Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'structured-turn' },
    },
    {
      timestamp: '2026-09-07T12:00:01.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Inspect structured output' },
    },
    {
      timestamp: '2026-09-07T12:00:02Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'structured-call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat result.json' }),
      },
    },
    {
      timestamp: '2026-09-07T12:00:03Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'structured-call',
        output: { status: 'success', payload: { text } },
      },
    },
    {
      timestamp: '2026-09-07T12:00:04Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'structured-turn' },
    },
  ];
  const folder = await mkdtemp(path.join(os.tmpdir(), 'codex-structured-output-'));
  try {
    await mkdir(path.join(folder, 'sessions'));
    await writeFile(
      path.join(folder, 'sessions', 'structured.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n'),
    );
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles(folder);
    await expect(page.locator('.session-row')).toHaveCount(1, { timeout: 30000 });
    await page.locator('.session-row').click();
    await page
      .locator('.trace-heading')
      .getByRole('button', { name: 'Critical path', exact: true })
      .click();
    await page
      .locator('.critical-content tbody tr')
      .filter({ hasText: 'exec_command' })
      .first()
      .click();
    await expect(page.locator('.details-tabs button.active')).toHaveText('Critical path');
    await expect(page.locator('.critical-content .span-detail-title')).toContainText(
      'exec_command',
    );
    await expect(page.locator('.critical-content tbody tr.selected')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Load more contents' })).toBeEnabled({
      timeout: 30000,
    });
    while (await page.getByRole('button', { name: 'Load more contents' }).count()) {
      await page.getByRole('button', { name: 'Load more contents' }).click();
      await expect(page.locator('.detail-loading')).toHaveCount(0, { timeout: 30000 });
    }
    const outputs = await page.locator('.output-block').allTextContents();
    expect(outputs.length).toBeGreaterThan(1);
    const copied = await page
      .locator('.output-block')
      .first()
      .evaluate((element) => {
        const chunks = element.querySelectorAll('.text-chunk');
        const range = document.createRange();
        range.setStart(chunks[0].firstChild!, 10);
        range.setEnd(chunks[1].firstChild!, 20);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        const clipboardData = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData }));
        selection.removeAllRanges();
        return {
          text: clipboardData.getData('text/plain'),
          expected: (chunks[0].textContent + chunks[1].textContent).slice(
            10,
            chunks[0].textContent!.length + 20,
          ),
        };
      });
    expect(copied.text).toBe(copied.expected);
    const parsed = outputs.map((output) => JSON.parse(output));
    expect(parsed.every((output) => output.status === 'success')).toBe(true);
    expect(parsed.map((output) => output.payload.text).join('')).toBe(text);
    expect(await page.locator('.code-block').allTextContents()).toEqual(
      outputs.map(() => 'cat result.json'),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('session info reports identities and diagnostics; C toggles only outside dialogs and inputs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Verify the copy payload without reading or changing the host clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (text: string) => {
        (window as unknown as { copiedSessionId: string }).copiedSessionId = text;
      },
    });
  });
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(directory);
  await page.getByRole('button', { name: /^Fixture root / }).click();
  await expect(page.locator('.scope-toolbar')).toContainText('4 agents', { timeout: 30000 });
  await expect(page.locator('.sidebar-footer')).toHaveCount(0);
  const critical = page
    .locator('.trace-info')
    .getByRole('button', { name: 'Critical path', exact: true, includeHidden: true });
  await expect(critical).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Session info', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Session info' });
  await expect(dialog.getByLabel('Session ID', { exact: true })).toHaveValue(rootId);
  await expect(dialog).toContainText('session-parser-v1-stream-9');
  await expect(dialog).toContainText('sessions/demo-root.jsonl');
  await dialog.getByRole('button', { name: 'Copy session ID' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Session ID copied');
  expect(
    await page.evaluate(() => (window as unknown as { copiedSessionId: string }).copiedSessionId),
  ).toBe(rootId);
  await page.keyboard.press('c');
  await expect(critical).toHaveAttribute('aria-pressed', 'false');
  await dialog
    .getByRole('combobox', { name: 'Session', exact: true })
    .selectOption('00000000-0000-4000-8000-000000000002');
  await expect(dialog.getByLabel('Session ID', { exact: true })).toHaveValue(
    '00000000-0000-4000-8000-000000000002',
  );
  await expect(dialog).toContainText('Archived');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('c');
  await expect(critical).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.critical-content')).toBeVisible();
  await page.keyboard.press('c');
  await expect(critical).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+c');
  await expect(critical).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});
