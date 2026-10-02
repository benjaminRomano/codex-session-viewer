import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const id = '00000000-0000-4000-8000-000000000001';
const turn = `${id}-turn-1`;

test('a linked turn survives folder selection and reload, reading only its file', async ({
  page,
}) => {
  const lines = (await readFile('public/demo/demo-root.jsonl', 'utf8')).split('\n');
  lines.splice(
    2,
    0,
    JSON.stringify({
      timestamp: '2026-09-07T20:00:00.001Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
      },
    }),
  );
  const contents = lines.join('\n');
  await page.addInitScript(
    ({ id, contents }) => {
      const state = window as unknown as {
        selectedReads: number;
        unrelatedReads: number;
        showDirectoryPicker: () => Promise<unknown>;
      };
      state.selectedReads = 0;
      state.unrelatedReads = 0;
      const selected = {
        kind: 'file',
        name: `rollout-2026-09-07-${id}.jsonl`,
        getFile: async () => {
          state.selectedReads++;
          return new File([contents], `rollout-2026-09-07-${id}.jsonl`);
        },
      };
      const scope = {
        async *values() {
          yield {
            kind: 'file',
            name: 'rollout-2026-other.jsonl',
            getFile: () => {
              state.unrelatedReads++;
              throw new Error('Unrelated file read');
            },
          };
          yield selected;
        },
      };
      state.showDirectoryPicker = async () => ({
        isSameEntry: async () => false,
        getFileHandle: async (name: string) => {
          if (name !== 'session_index.jsonl') throw new Error('Unexpected file');
          return {
            getFile: async () =>
              new File(
                [JSON.stringify({ id, thread_name: 'Saved synthetic session title' })],
                name,
              ),
          };
        },
        getDirectoryHandle: async (name: string) => {
          if (name === 'sessions') return scope;
          throw new DOMException('Missing', 'NotFoundError');
        },
      });
    },
    { id, contents },
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/session/${id}/turn/${turn}`);
  await expect(page.getByRole('heading', { name: 'Open linked session' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose .codex folder' }).click();
  await expect(page.getByRole('button', { name: 'Copy turn link' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.locator('.header-title')).toHaveText('Saved synthetic session title');
  await expect(page.getByRole('button', { name: /1 Build a session trace viewer/ })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      selected: (window as unknown as { selectedReads: number }).selectedReads,
      other: (window as unknown as { unrelatedReads: number }).unrelatedReads,
    })),
  ).toEqual({ selected: 1, other: 0 });
  await page.reload();
  await page.getByRole('button', { name: 'Choose .codex folder' }).click();
  await expect(page.getByRole('button', { name: 'Copy turn link' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.header-title')).toHaveText('Saved synthetic session title');
  await page.screenshot({ path: 'output/session-title-deep-link.png' });
  expect(errors).toEqual([]);
});

test('individual file loading reports missing turns and rejects mismatched sessions', async ({
  page,
}) => {
  await page.goto(`/session/${id}/turn/missing-turn`);
  await page
    .getByLabel('Choose individual rollout file')
    .setInputFiles(path.resolve('public/demo/demo-root.jsonl'));
  await expect(page.getByRole('alert')).toContainText('Turn missing-turn was not found', {
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Copy session link' })).toBeVisible();
  await page.goto('/session/00000000-0000-4000-8000-000000000099');
  await page
    .getByLabel('Choose individual rollout file')
    .setInputFiles(path.resolve('public/demo/demo-root.jsonl'));
  await expect(page.getByRole('alert')).toContainText('not 00000000-0000-4000-8000-000000000099', {
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Copy session link' })).toHaveCount(0);
});

test('saved folder access automatically opens an archived linked turn on reload', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const contents = await readFile('public/demo/demo-root.jsonl', 'utf8');
  await page.evaluate(
    async ({ id, contents }) => {
      const root = await navigator.storage.getDirectory();
      const archive = await root.getDirectoryHandle('archived_sessions', { create: true });
      for (const [name, text] of [
        [`rollout-2026-09-07-${id}.jsonl`, contents],
        ['rollout-other.jsonl', 'unrelated invalid data'],
      ]) {
        const file = await archive.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        await writer.write(text);
        await writer.close();
      }
      const modulePath = '/src/lib/session-store.ts';
      const { SessionStore } = await import(/* @vite-ignore */ modulePath);
      const store = new SessionStore();
      try {
        await store.openSession(root, id);
      } finally {
        store.dispose();
      }
    },
    { id, contents },
  );
  await page.goto(`/session/${id}/turn/${turn}`);
  await expect(page.getByRole('button', { name: 'Copy turn link' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy turn link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    `/session/${id}/turn/${turn}`,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Copy turn link' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/session/00000000-0000-4000-8000-000000000099');
  await expect(page.getByRole('alert')).toContainText(
    'was not found in sessions or archived_sessions',
    { timeout: 30_000 },
  );
});
