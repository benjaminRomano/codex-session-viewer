import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function openLog(page: Page) {
  await page.goto('/');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Explore example', exact: true })
    .click();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-agent-count', '4', {
    timeout: 30000,
  });
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: 'Session Log', exact: true })
    .click();
  await expect(page.locator('.session-log-entry').first()).toBeVisible();
}

async function settleScroll(page: Page) {
  await page.evaluate(async () => {
    // Layout, deferred ResizeObserver measurements, then their React commit.
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

async function seekLog(page: Page, entry: Locator) {
  const scroll = page.getByRole('region', { name: 'Session log entries' });
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleScroll(page);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await entry.count()) {
      await entry.scrollIntoViewIfNeeded();
      return;
    }
    await scroll.evaluate((element) => {
      element.scrollTop += element.clientHeight * 0.8;
    });
    await settleScroll(page);
  }
  throw new Error('The requested entry was not reached by scrolling the session log.');
}

test('session log hover highlights spans, clicking focuses them, and call/result contents stay separate', async ({
  page,
}) => {
  await openLog(page);
  const canvas = page.getByTestId('timeline-canvas');
  const initialCount = await canvas.getAttribute('data-span-count');
  const initialAgents = await canvas.getAttribute('data-agent-count');
  const viewDuration = async () =>
    Number(await page.locator('.timeline-ruler').getAttribute('data-view-end')) -
    Number(await page.locator('.timeline-ruler').getAttribute('data-view-start'));
  const initialDuration = await viewDuration();
  const call = page
    .locator('.session-log-entry[data-log-phase="call"]')
    .filter({ hasText: 'Promise.all' });
  await seekLog(page, call);
  await expect(call).toHaveCount(1);
  const spanId = await call.getAttribute('data-span-id');
  await call.hover();
  await expect(canvas).toHaveAttribute('data-highlighted-id', spanId!);
  await call.locator('.session-log-focus').click();
  await expect(page.locator('.session-log')).toBeVisible();
  await expect(
    page.locator('.details-tabs').getByRole('button', { name: 'Session Log', exact: true }),
  ).toHaveClass('active');
  expect(await viewDuration()).toBe(initialDuration);
  await expect(canvas).toHaveAttribute('data-span-count', initialCount!);
  await expect(canvas).toHaveAttribute('data-agent-count', initialAgents!);
  // Leaving the log resets its request counter. The same entry must still
  // recenter after returning, even when its next request is nonce 1 again.
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: /^Selection/ })
    .click();
  await page.keyboard.press('f');
  await expect.poll(viewDuration).toBe(10000);
  const centeredStart = Date.parse('2026-09-07T20:00:17Z');
  await page.keyboard.down('d');
  await page.waitForTimeout(90);
  await page.keyboard.up('d');
  await expect
    .poll(async () => Number(await page.locator('.timeline-ruler').getAttribute('data-view-start')))
    .toBeGreaterThan(centeredStart);
  await page.waitForTimeout(750);
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: 'Session Log', exact: true })
    .click();
  await seekLog(page, call);
  await call.locator('.session-log-focus').click();
  await expect(page.locator('.timeline-ruler')).toHaveAttribute(
    'data-view-start',
    String(centeredStart),
  );
  await expect.poll(viewDuration).toBe(10000);
  await expect(canvas).toHaveAttribute('data-span-count', initialCount!);
  await call.getByRole('button', { name: 'Full contents', exact: true }).click();
  await expect(call.locator('.session-log-contents .code-block')).toContainText('Promise.all');
  await expect(call.locator('.session-log-contents .output-block')).toHaveCount(0);
  const result = page
    .locator('.session-log-entry[data-log-phase="result"]')
    .filter({ hasText: 'Typecheck passed. 24 parser tests passed.' });
  await seekLog(page, result);
  await expect(result).toHaveCount(1);
  expect(await result.getAttribute('data-span-id')).toBe(spanId);
  await result.getByRole('button', { name: 'Full contents', exact: true }).click();
  await expect(result.locator('.session-log-contents .output-block')).toContainText(
    '24 parser tests passed',
  );
  await expect(result.locator('.session-log-contents .code-block')).toHaveCount(0);
  await expect(call.getByRole('button', { name: 'Full contents', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const message = page.locator('.session-log-entry[data-log-role="assistant"]').first();
  await seekLog(page, message);
  await message.locator('.session-log-message').click({ position: { x: 5, y: 5 } });
  expect(await viewDuration()).toBe(10000);
  await expect(canvas).toHaveAttribute('data-span-count', initialCount!);
  await expect(page.locator('.timeline-sr-status')).toContainText('Assistant message');
  const selectedMessage = await page.locator('.timeline-sr-status').textContent();
  const userPreview = page
    .locator('.session-log-entry[data-log-role="user"]')
    .first()
    .locator('.session-log-message');
  await seekLog(page, userPreview);
  await userPreview.scrollIntoViewIfNeeded();
  const previewBox = (await userPreview.boundingBox())!;
  await page.mouse.move(previewBox.x + 2, previewBox.y + 7);
  await page.mouse.down();
  await page.mouse.move(previewBox.x + 170, previewBox.y + 7, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0))
    .toBeGreaterThan(0);
  await expect(page.locator('.timeline-sr-status')).toHaveText(selectedMessage!);
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: /^Selection/ })
    .click();
  await expect(canvas).not.toHaveAttribute('data-highlighted-id');
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: 'Session Log', exact: true })
    .click();
  await page.locator('.turn-row').filter({ hasText: 'Run a final smoke test' }).click();
  await expect(canvas).not.toHaveAttribute('data-highlighted-id');
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: 'Session Log', exact: true })
    .click();
  await expect(page.locator('.session-log')).toContainText('Run a final smoke test');
  await expect(page.locator('.session-log')).not.toContainText('Promise.all');
});

test('session log continuously virtualizes thousands of variable-height entries and retains paged details', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  const original = await readFile(path.join(process.cwd(), 'public/demo/demo-root.jsonl'), 'utf8');
  const records = original
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const prompt =
    'Review the entire implementation. ' +
    'Unicode payload 🧭 漢字 '.repeat(5000) +
    '\nFINAL LOG PAYLOAD';
  records.find((record) => record.payload?.type === 'user_message').payload.message = prompt;
  const longToolName =
    'functions.mcp__an_exceptionally_long_connector_name__inspect_detailed_results';
  const longAgentName = 'A very long agent name that must remain separate from the tool';
  const childRecords = (
    await readFile(path.join(process.cwd(), 'public/demo/demo-parser.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  childRecords[0].payload.agent_nickname = longAgentName;
  childRecords.find((record) => record.payload?.name === 'functions.exec_command').payload.name =
    longToolName;
  await page.route('**/demo/demo-parser.jsonl', (route) =>
    route.fulfill({
      contentType: 'application/jsonl',
      body: childRecords.map((record) => JSON.stringify(record)).join('\n'),
    }),
  );
  for (let i = 0; i < 4000; i++) {
    records.push({
      timestamp: new Date(Date.parse('2026-09-07T20:01:50Z') + i * 10).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: `Progress log message ${i}\n${'A variable-height preview with enough words to wrap at narrow widths. '.repeat((i % 4) + 1)}`,
          },
        ],
      },
    });
  }
  const pagedOutput = 'Paged output '.repeat(100000) + '\nFINAL PAGED OUTPUT';
  records.push(
    {
      timestamp: '2026-09-07T20:02:31.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'functions.exec_command',
        call_id: 'last-log-tool',
        arguments: '{"cmd":"inspect final output"}',
      },
    },
    {
      timestamp: '2026-09-07T20:02:32.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'last-log-tool', output: pagedOutput },
    },
  );
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await page.route('**/demo/demo-root.jsonl', (route) =>
    route.fulfill({
      contentType: 'application/jsonl',
      body: records.map((record) => JSON.stringify(record)).join('\n'),
    }),
  );
  await openLog(page);
  const scroll = page.getByRole('region', { name: 'Session log entries' });
  const mounted = page.locator('.session-log-entry');
  await expect
    .poll(async () => Number(await page.locator('.session-log').getAttribute('data-entry-count')))
    .toBeGreaterThan(4000);
  await expect.poll(() => mounted.count()).toBeLessThan(80);
  await expect(page.getByRole('button', { name: /Earlier entries|Later entries/ })).toHaveCount(0);
  const firstTool = page
    .locator('.session-log-entry[data-log-phase="call"]')
    .filter({ hasText: longToolName });
  await seekLog(page, firstTool);
  await expect(firstTool.locator('.session-log-source')).toHaveText(longAgentName);
  await expect(firstTool.locator('.session-log-phase')).toHaveText('call');
  await page.locator('.session-log').evaluate((element) => {
    element.style.maxWidth = '360px';
  });
  await settleScroll(page);
  const overlaps = await firstTool.locator('.session-log-entry-heading').evaluate((heading) => {
    const rectangles = Array.from(heading.children)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0);
    return rectangles.slice(1).filter((rect, index) => rect.left < rectangles[index].right - 1)
      .length;
  });
  expect(overlaps).toBe(0);
  expect(
    await firstTool
      .locator('.session-log-focus strong')
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThan(20);
  expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.locator('.session-log').evaluate((element) => {
    element.style.maxWidth = '';
  });
  await settleScroll(page);
  const user = page.locator('.session-log-entry[data-log-role="user"]').first();
  await seekLog(page, user);
  await expect(user.locator('.session-log-message')).not.toContainText('FINAL LOG PAYLOAD');
  await user.getByRole('button', { name: 'Full contents', exact: true }).click();
  await expect(user.locator('.prompt-block')).toHaveText(prompt, { timeout: 30000 });
  // A retained expanded row must not turn the rest of the list into mounted DOM.
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await settleScroll(page);
  await expect.poll(() => mounted.count()).toBeLessThan(80);
  await expect(user.locator('.prompt-block')).toHaveText(prompt);
  await expect(page.locator('.session-log-entry.expanded')).toHaveCount(1);
  const anchor = await scroll.evaluate(
    (element) =>
      new Promise<{ id: string; offset: number } | undefined>((resolve) => {
        // Resize during a real backward scroll, before the virtualizer's idle
        // debounce can clear its direction. Its scroll handler runs first.
        element.addEventListener(
          'scroll',
          () => {
            const viewport = element.getBoundingClientRect();
            const row = Array.from(
              element.querySelectorAll<HTMLElement>('.session-log-entry'),
            ).find((entry) => {
              const rect = entry.getBoundingClientRect();
              return rect.top >= viewport.top + 10 && rect.top < viewport.bottom;
            });
            const result = row
              ? { id: row.dataset.logId!, offset: row.getBoundingClientRect().top - viewport.top }
              : undefined;
            element.closest<HTMLElement>('.session-log')!.style.maxWidth = '360px';
            resolve(result);
          },
          { once: true },
        );
        element.scrollTop -= 40;
      }),
  );
  expect(anchor).toBeDefined();
  await settleScroll(page);
  const anchoredRow = page.locator(`.session-log-entry[data-log-id="${anchor!.id}"]`);
  await expect(anchoredRow).toHaveCount(1);
  await expect
    .poll(async () => {
      const row = await anchoredRow.boundingBox();
      const viewport = await scroll.boundingBox();
      return row && viewport ? Math.abs(row.y - viewport.y - anchor!.offset) : Infinity;
    })
    .toBeLessThan(80);
  const rowOverlaps = await scroll.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll('.session-log-virtual-row')).map((row) =>
      row.getBoundingClientRect(),
    );
    return rows.slice(1).filter((row, index) => row.top < rows[index].bottom - 1).length;
  });
  expect(rowOverlaps).toBe(0);
  expect(
    await page
      .locator('.details-content')
      .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  await page.locator('.session-log').evaluate((element) => {
    element.style.maxWidth = '';
  });
  await settleScroll(page);
  const lastResult = page
    .locator('.session-log-entry[data-log-phase="result"]')
    .filter({ hasText: 'Paged output' });
  await expect
    .poll(async () => {
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await settleScroll(page);
      return lastResult.count();
    })
    .toBe(1);
  await expect(
    page.locator('.session-log-message').filter({ hasText: 'Progress log message 3999' }),
  ).toHaveCount(1);
  await lastResult.scrollIntoViewIfNeeded();
  await lastResult.getByRole('button', { name: 'Full contents', exact: true }).click();
  await expect(page.locator('.session-log-entry.expanded')).toHaveCount(1);
  await expect(
    lastResult.getByRole('button', { name: 'Load more contents', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(lastResult.locator('.output-block')).not.toContainText('FINAL PAGED OUTPUT');
  await lastResult.getByRole('button', { name: 'Load more contents', exact: true }).click();
  await expect
    .poll(async () => (await lastResult.locator('.output-block').allTextContents()).join(''))
    .toBe(pagedOutput);
  await expect.poll(() => mounted.count()).toBeLessThan(80);
  await lastResult.getByRole('button', { name: 'Collapse contents', exact: true }).click();
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await settleScroll(page);
  await expect(user.locator('.session-log-message')).toBeVisible();
  await expect(page.locator('.session-log-contents')).toHaveCount(0);
  await expect.poll(() => mounted.count()).toBeLessThan(80);
  await settleScroll(page);
  expect(pageErrors).toEqual([]);
});
