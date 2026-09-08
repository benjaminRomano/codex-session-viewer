import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test.setTimeout(90000);

async function openExample(page: Page) {
  await page.goto('/');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Explore example', exact: true })
    .click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-agent-count', '4');
}

async function geometry(page: Page) {
  const element = page.getByTestId('timeline-canvas');
  const canvas = await element.boundingBox();
  if (!canvas) throw new Error('Timeline canvas is not visible');
  const label = Number(await element.getAttribute('data-label-width'));
  const group = Number(await element.getAttribute('data-group-height'));
  const lane = Number(await element.getAttribute('data-lane-height'));
  return {
    ...canvas,
    label,
    group,
    lane,
    plot: canvas.width - label,
    at: (seconds: number, row: number) => ({
      x: canvas.x + label + (seconds / 108) * (canvas.width - label),
      y: canvas.y + group + row * lane + lane / 2,
    }),
  };
}

async function windowDuration(page: Page) {
  const ruler = page.locator('.timeline-ruler');
  return (
    Number(await ruler.getAttribute('data-view-end')) -
    Number(await ruler.getAttribute('data-view-start'))
  );
}

test('canvas multiselection, highlighted code, area selection, and measurement', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openExample(page);
  const box = await geometry(page);
  const code = box.at(22, 5);
  await page.mouse.click(code.x, code.y);
  await expect(page.locator('.details-tabs')).toContainText('Selection (1)');
  await expect(page.locator('.span-detail-title')).toContainText('functions.exec');
  await expect(page.locator('.code-block')).toContainText('Promise.all');
  await expect(page.locator('.code-block .hljs-keyword').first()).toBeVisible();
  const shell = box.at(2, 3);
  await page.keyboard.down('Shift');
  await page.mouse.click(shell.x, shell.y);
  await page.keyboard.up('Shift');
  await expect(page.locator('.details-tabs')).toContainText('Selection (2)');
  await page.keyboard.press('m');
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-measure-start');
  await expect(page.locator('.measurement')).toContainText('24.50 s');
  await page.locator('.measurement').getByRole('button', { name: 'Clear measurement' }).click();
  await expect(page.getByTestId('timeline-canvas')).not.toHaveAttribute('data-measure-start');
  await page.keyboard.press('Escape');
  await expect(page.locator('.details-tabs')).not.toContainText('Selection (');
  await page.mouse.move(box.x + box.label + 1, box.y + box.group + box.lane + 1);
  await page.mouse.down();
  await page.mouse.move(box.at(30, 5).x, box.y + box.group + box.lane * 6 - 1, { steps: 8 });
  await page.mouse.up();
  const selectionCount = await page.locator('.details-tabs').innerText();
  expect(Number(selectionCount.match(/Selection \((\d+)\)/)?.[1])).toBeGreaterThan(3);
  await page.screenshot({ path: 'output/playwright/timeline-selection.png' });
  expect(errors).toEqual([]);
});

test('Perfetto keyboard and pointer zoom, pan, fit, overview, and shortcuts', async ({ page }) => {
  await openExample(page);
  await expect(page.locator('.timeline-toolbar')).toHaveCount(0);
  await expect(page.locator('.timeline-status')).toHaveCount(0);
  const box = await geometry(page);
  await page.mouse.move(box.x + box.label + box.plot * 0.6, box.y + 70);
  const full = await windowDuration(page);
  await page.keyboard.down('w');
  await page.waitForTimeout(100);
  await page.keyboard.up('w');
  await expect.poll(() => windowDuration(page)).toBeLessThan(full * 0.95);
  await page.waitForTimeout(700);
  const zoomed = await windowDuration(page);
  const start = Number(await page.locator('.timeline-ruler').getAttribute('data-view-start'));
  await page.keyboard.down('d');
  await page.waitForTimeout(90);
  await page.keyboard.up('d');
  await expect
    .poll(async () => Number(await page.locator('.timeline-ruler').getAttribute('data-view-start')))
    .toBeGreaterThan(start);
  await page.waitForTimeout(700);
  expect(await windowDuration(page)).toBeCloseTo(zoomed, 1);
  await page.keyboard.press('f');
  await expect.poll(() => windowDuration(page)).toBe(full);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -127);
  await page.keyboard.up('Control');
  await expect.poll(() => windowDuration(page)).toBeCloseTo(full * 0.86, 1);
  await page.keyboard.press('f');
  await expect.poll(() => windowDuration(page)).toBe(full);
  const overview = await page.locator('.timeline-overview').boundingBox();
  if (!overview) throw new Error('No overview');
  await page.mouse.move(overview.x + box.label + box.plot * 0.1, overview.y + 20);
  await page.mouse.down();
  await page.mouse.move(overview.x + box.label + box.plot * 0.4, overview.y + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => windowDuration(page)).toBeCloseTo(full * 0.3, 0);
  await page.keyboard.press('?');
  await expect(page.locator('.timeline-help')).toContainText('Drag selects across tracks');
});

test('F centers the selection at 80% width and hover shows only duration and name', async ({
  page,
}) => {
  await openExample(page);
  const box = await geometry(page);
  const code = box.at(22, 5);
  await page.mouse.move(code.x, code.y);
  await expect(page.getByRole('tooltip')).toHaveText('8.00 s functions.exec');
  await expect(page.getByRole('tooltip')).not.toContainText('complete');
  await page.mouse.click(code.x, code.y);
  await page.keyboard.press('f');
  await expect.poll(() => windowDuration(page)).toBe(10000);
  await expect(page.locator('.timeline-ruler')).toHaveAttribute(
    'data-view-start',
    String(Date.parse('2026-09-07T20:00:17Z')),
  );
  await expect(page.locator('.timeline-ruler')).toHaveAttribute(
    'data-view-end',
    String(Date.parse('2026-09-07T20:00:27Z')),
  );
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('f');
  expect(await windowDuration(page)).toBe(10000);
  await page.screenshot({ path: 'output/playwright/timeline-focus-selection.png' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await expect.poll(() => windowDuration(page)).toBe(108000);
});

test('flow visibility, linked navigation, agent scope, and turn filtering', async ({ page }) => {
  await page.addInitScript(() => {
    const originalClear = CanvasRenderingContext2D.prototype.clearRect;
    const originalCurve = CanvasRenderingContext2D.prototype.bezierCurveTo;
    const state = window as unknown as { timelineFlows: { color: string; width: number }[] };
    state.timelineFlows = [];
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.dataset.testid === 'timeline-canvas') state.timelineFlows = [];
      return originalClear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.bezierCurveTo = function (...args) {
      if (this.canvas.dataset.testid === 'timeline-canvas')
        state.timelineFlows.push({ color: String(this.strokeStyle), width: this.lineWidth });
      return originalCurve.apply(this, args);
    };
  });
  await openExample(page);
  const flows = page.getByTestId('timeline-canvas');
  const drawnFlows = () =>
    page.evaluate(
      () =>
        (window as unknown as { timelineFlows: { color: string; width: number }[] }).timelineFlows,
    );
  await expect(flows).toHaveAttribute('data-flow-mode', 'selected');
  await expect(flows).toHaveAttribute('data-show-all-flows', 'false');
  await expect(flows).toHaveAttribute('data-show-selected-flows', 'true');
  await expect(flows).toHaveAttribute('data-enabled-flow-count', '0');
  await expect.poll(drawnFlows).toEqual([]);
  await page.keyboard.press('>');
  await expect(flows).toHaveAttribute('data-flow-mode', 'all');
  await expect
    .poll(async () =>
      (await drawnFlows()).some((flow) => flow.color === '#e88718' && flow.width === 2),
    )
    .toBe(true);
  const allCount = Number(await flows.getAttribute('data-enabled-flow-count'));
  expect(allCount).toBeGreaterThan(0);
  await page.keyboard.press('<');
  await expect(flows).toHaveAttribute('data-show-selected-flows', 'false');
  await expect(flows).toHaveAttribute('data-flow-mode', 'all');
  await expect(flows).toHaveAttribute('data-enabled-flow-count', String(allCount));
  const box = await geometry(page);
  const dispatch = box.at(8, 6);
  await page.mouse.click(dispatch.x, dispatch.y);
  await expect(page.locator('.span-detail-title')).toContainText('spawn_agent');
  await expect
    .poll(async () =>
      (await drawnFlows()).some((flow) => flow.color === '#d66a00' && flow.width === 3),
    )
    .toBe(true);
  await page.keyboard.press('<');
  await expect(flows).toHaveAttribute('data-show-selected-flows', 'true');
  await expect(flows).toHaveAttribute('data-flow-mode', 'all');
  await page.keyboard.press('>');
  await expect(flows).toHaveAttribute('data-flow-mode', 'selected');
  const connectedCount = Number(await flows.getAttribute('data-enabled-flow-count'));
  expect(connectedCount).toBeGreaterThan(0);
  expect(connectedCount).toBeLessThan(allCount);
  await expect
    .poll(async () => {
      const drawn = await drawnFlows();
      return (
        drawn.length > 0 && drawn.every((flow) => flow.color === '#d66a00' && flow.width === 3)
      );
    })
    .toBe(true);
  await page.keyboard.press('<');
  await expect(flows).toHaveAttribute('data-flow-mode', 'hidden');
  await expect.poll(drawnFlows).toEqual([]);
  await page.keyboard.press('>');
  await expect(flows).toHaveAttribute('data-flow-mode', 'all');
  await expect(flows).toHaveAttribute('data-show-selected-flows', 'false');
  await page.keyboard.press('>');
  await expect(flows).toHaveAttribute('data-flow-mode', 'hidden');
  await page.keyboard.press(']');
  await expect(page.locator('.span-detail')).toContainText('Parser');
  await expect(page.locator('.span-detail-title')).toContainText('Turn 1');
  await expect(flows).toHaveAttribute('data-flow-mode', 'selected');
  await expect(flows).toHaveAttribute('data-show-all-flows', 'false');
  await page.keyboard.press('[');
  await expect(page.locator('.span-detail-title')).toContainText('spawn_agent');
  await page.locator('.agent-scope-row').filter({ hasText: 'Parser' }).click();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-agent-count', '1');
  await expect(page.getByRole('button', { name: 'Back to main session' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to main session' }).click();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-agent-count', '4');
  await page.locator('.turn-row').filter({ hasText: 'Run a final smoke test' }).click();
  await expect(page.getByTestId('timeline-canvas')).toHaveAttribute('data-agent-count', '1');
  expect(await windowDuration(page)).toBe(8000);
  await page.getByRole('button', { name: 'Whole session', exact: false }).click();
  await page
    .locator('.details-tabs')
    .getByRole('button', { name: 'Critical path', exact: true })
    .click();
  await expect(page.locator('.critical-content')).toBeVisible();
  await expect(page.locator('.critical-content tbody tr').first()).toBeVisible();
  await page.screenshot({ path: 'output/playwright/timeline-critical-path.png' });
});

test('selected instant operations have a visible outline and retain their failure glyph', async ({
  page,
}) => {
  const original = await readFile(path.join(process.cwd(), 'public/demo/demo-root.jsonl'), 'utf8');
  const records = original
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const firstOutput = records.find(
    (record) => record.type === 'response_item' && record.payload.type === 'function_call_output',
  );
  const firstCall = records.find(
    (record) =>
      record.payload.call_id === firstOutput.payload.call_id &&
      record.payload.type === 'function_call',
  );
  firstOutput.timestamp = firstCall.timestamp;
  firstOutput.payload.output = JSON.stringify({ exit_code: 1, output: 'Fixture command failed' });
  await page.route('**/demo/demo-root.jsonl', (route) =>
    route.fulfill({
      contentType: 'application/jsonl',
      body: records.map((record) => JSON.stringify(record)).join('\n'),
    }),
  );
  await openExample(page);
  const box = await geometry(page);
  const shell = box.at(1.5, 3);
  await page.mouse.click(shell.x, shell.y);
  await expect(page.locator('.span-detail-title')).toContainText('error');
  const colors = await page.getByTestId('timeline-canvas').evaluate(
    (canvas, args) => {
      const element = canvas as HTMLCanvasElement;
      const scale = element.width / element.getBoundingClientRect().width;
      const ctx = element.getContext('2d')!;
      const data = ctx.getImageData(
        Math.floor((args.right - 10) * scale),
        Math.floor((args.y - 10) * scale),
        Math.ceil(20 * scale),
        Math.ceil(20 * scale),
      ).data;
      let red = 0;
      let white = 0;
      let selectionLeft = Infinity;
      let selectionRight = -Infinity;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 175 && data[i + 1] < 65 && data[i + 2] < 65) red++;
        if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) white++;
        if (data[i] < 40 && data[i + 1] < 45 && data[i + 2] < 55) {
          const x = (i / 4) % Math.ceil(20 * scale);
          selectionLeft = Math.min(selectionLeft, x);
          selectionRight = Math.max(selectionRight, x);
        }
      }
      return { red, white, selectionWidth: (selectionRight - selectionLeft + 1) / scale };
    },
    { right: box.label + (1.5 / 108) * box.plot + 1, y: box.group + 3 * box.lane + box.lane / 2 },
  );
  expect(colors.red).toBeGreaterThan(10);
  expect(colors.white).toBeGreaterThan(2);
  expect(colors.selectionWidth).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: 'output/playwright/timeline-failed-span.png' });
});

test('thousands of overlapping slices use a viewport-sized canvas and survive resize/scroll', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalClear = CanvasRenderingContext2D.prototype.clearRect;
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    const state = window as unknown as { timelineLabels: string[] };
    state.timelineLabels = [];
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.dataset.testid === 'timeline-canvas') state.timelineLabels = [];
      return originalClear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (
        this.canvas.dataset.testid === 'timeline-canvas' &&
        x < Number(this.canvas.dataset.labelWidth)
      )
        state.timelineLabels.push(text);
      return maxWidth === undefined
        ? originalText.call(this, text, x, y)
        : originalText.call(this, text, x, y, maxWidth);
    };
  });
  const original = await readFile(path.join(process.cwd(), 'public/demo/demo-root.jsonl'), 'utf8');
  const records = original
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const time = (ms: number) => new Date(Date.parse('2026-09-07T20:00:00Z') + ms).toISOString();
  for (let i = 0; i < 3000; i++) {
    records.push({
      timestamp: time(1000 + i),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'functions.exec_command',
        call_id: `overlap-${i}`,
        arguments: JSON.stringify({ cmd: `echo operation-${i}` }),
      },
    });
    records.push({
      timestamp: time(90000),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: `overlap-${i}`, output: 'done' },
    });
  }
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await page.route('**/demo/demo-root.jsonl', (route) =>
    route.fulfill({
      contentType: 'application/jsonl',
      body: records.map((record) => JSON.stringify(record)).join('\n'),
    }),
  );
  await openExample(page);
  const canvas = page.getByTestId('timeline-canvas');
  expect(Number(await canvas.getAttribute('data-span-count'))).toBeGreaterThan(3000);
  expect(Number(await canvas.getAttribute('data-logical-track-count'))).toBeLessThan(50);
  expect(Number(await canvas.getAttribute('data-visible-rows'))).toBeLessThan(40);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { timelineLabels: string[] }).timelineLabels.filter((label) =>
          label.startsWith('Shell / terminal'),
        ),
      ),
    )
    .toEqual(['Shell / terminal']);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const labels = (window as unknown as { timelineLabels: string[] }).timelineLabels;
        const turns = labels.indexOf('Agent turns');
        return labels.slice(turns, turns + 3);
      }),
    )
    .toEqual(['Agent turns', 'Messages', 'Inference']);
  const before = await canvas.boundingBox();
  await page.locator('.timeline-viewport').evaluate((element) => {
    element.scrollTop = 20000;
  });
  await expect
    .poll(() => page.locator('.timeline-viewport').evaluate((element) => element.scrollTop))
    .toBe(20000);
  expect(Number(await canvas.getAttribute('data-visible-rows'))).toBeLessThan(40);
  await page.setViewportSize({ width: 1080, height: 760 });
  await expect
    .poll(async () => (await canvas.boundingBox())?.width ?? 0)
    .toBeLessThan(before!.width);
  const dimensions = await canvas.evaluate((element) => ({
    cssHeight: element.getBoundingClientRect().height,
    bitmapHeight: (element as HTMLCanvasElement).height,
    dpr: devicePixelRatio,
  }));
  expect(dimensions.cssHeight).toBeLessThan(760);
  expect(dimensions.bitmapHeight).toBeLessThanOrEqual(
    Math.ceil(dimensions.cssHeight * dimensions.dpr),
  );
  expect(await page.locator('button').count()).toBeLessThan(500);
  await page.screenshot({ path: 'output/playwright/timeline-dense-scrolled.png' });
});

test('focused canvas supports keyboard selection without a duplicate span list', async ({
  page,
}) => {
  await openExample(page);
  await expect(page.getByText('Browse visible spans as a list')).toHaveCount(0);
  const canvas = page.getByTestId('timeline-canvas');
  await canvas.focus();
  await page.keyboard.press('Home');
  await expect(page.locator('.details-tabs')).toContainText('Selection (1)');
  const first = await page.locator('.timeline-sr-status').textContent();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.timeline-sr-status')).not.toHaveText(first ?? '');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('.details-tabs')).toContainText('Selection (2)');
  await page.keyboard.press('End');
  await expect(page.locator('.details-tabs')).toContainText('Selection (1)');
  await page.keyboard.press('Escape');
  await expect(page.locator('.details-tabs')).not.toContainText('Selection (');
  await expect(page.locator('.details-panel')).toHaveClass(/collapsed/);
  expect((await page.locator('.details-panel').boundingBox())!.height).toBeLessThan(40);
  await page.keyboard.press('Home');
  await expect(page.locator('.details-panel')).not.toHaveClass(/collapsed/);
  await expect(page.locator('.details-tabs')).toContainText('Selection (1)');
});
