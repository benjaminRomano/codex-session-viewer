import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('changed browser file snapshots fail clearly and a fresh selection recovers', async ({
  page,
}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-local-loading-'));
  const file = path.join(directory, 'fixture.jsonl');
  await writeFile(
    file,
    `${JSON.stringify({ timestamp: '2026-09-07T12:00:00Z', type: 'session_meta', payload: { id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-09-07T12:00:00Z' } })}\n`,
  );
  try {
    await page.goto('/');
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'snapshot-fixture';
      document.body.append(input);
    });
    await page.locator('#snapshot-fixture').setInputFiles(file);
    await page.evaluate(async () => {
      const modulePath = '/src/lib/parser-pool.ts';
      const { ParserPool } = await import(/* @vite-ignore */ modulePath);
      const state = window as unknown as {
        snapshotFile: File;
        snapshotPool: InstanceType<typeof ParserPool>;
      };
      state.snapshotFile = (
        document.querySelector('#snapshot-fixture') as HTMLInputElement
      ).files![0];
      void state.snapshotFile.size;
      state.snapshotPool = new ParserPool(1);
    });
    await appendFile(
      file,
      `${JSON.stringify({ timestamp: '2026-09-07T12:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } })}\n`,
    );
    const failed = await page.evaluate(async () => {
      const state = window as unknown as {
        snapshotFile: File;
        snapshotPool: { scanMetadata(file: File): Promise<unknown> };
      };
      try {
        await state.snapshotPool.scanMetadata(state.snapshotFile);
        return '';
      } catch (error) {
        return String(error);
      }
    });
    expect(failed).toContain('selected snapshot');
    await page.locator('#snapshot-fixture').setInputFiles(file);
    const restored = await page.evaluate(async () => {
      const state = window as unknown as {
        snapshotPool: {
          scanMetadata(file: File): Promise<{ id: string; turnCount: number }>;
          dispose(): void;
        };
      };
      try {
        return await state.snapshotPool.scanMetadata(
          (document.querySelector('#snapshot-fixture') as HTMLInputElement).files![0],
        );
      } finally {
        state.snapshotPool.dispose();
      }
    });
    expect(restored.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(restored.turnCount).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('selected prompt details preserve complete Unicode text across explicit pages', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/lib/parser-pool.ts';
    const { ParserPool } = await import(/* @vite-ignore */ modulePath);
    const prompt = 'A full prompt with λ, 🌐, an escaped "quote", and a newline.\n'.repeat(2_000);
    const records = [
      {
        timestamp: '2026-09-07T12:00:00Z',
        type: 'session_meta',
        payload: { id: '00000000-0000-4000-8000-000000000001' },
      },
      {
        timestamp: '2026-09-07T12:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        timestamp: '2026-09-07T12:00:02Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: prompt },
      },
      {
        timestamp: '2026-09-07T12:00:03Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1' },
      },
    ];
    const file = new File(
      [records.map((record) => JSON.stringify(record)).join('\n')],
      'prompt.jsonl',
    );
    const pool = new ParserPool(1);
    try {
      const parsed = await pool.parseSession(file);
      let reconstructed = '',
        offset = 0,
        pages = 0;
      while (pages < 20) {
        const details = await pool.loadDetails(file, {
          sourceLine: parsed.turns[0].sourceLine,
          pageSize: 32768,
          offset,
        });
        reconstructed += details.prompt ?? details.code ?? '';
        pages++;
        if (!details.hasMore) break;
        offset = details.nextOffset;
      }
      return {
        matches: reconstructed === prompt,
        length: reconstructed.length,
        expectedLength: prompt.length,
        pages,
        sourceLine: parsed.turns[0].sourceLine,
      };
    } finally {
      pool.dispose();
    }
  });
  expect(result.sourceLine).toBe(3);
  expect(result.expectedLength).toBeGreaterThan(65_536);
  expect(result.pages).toBeGreaterThan(1);
  expect(result.matches).toBe(true);
  expect(result.length).toBe(result.expectedLength);
});

test('restores a real directory handle and persistent metadata after reload', async ({ page }) => {
  await page.goto('/');
  const cold = await page.evaluate(async () => {
    const modulePath = '/src/lib/session-store.ts';
    const { SessionStore } = await import(/* @vite-ignore */ modulePath);
    // OPFS supplies an actual structured-cloneable directory handle in an isolated test origin.
    // This tests IndexedDB persistence without replacing the user's native folder permission.
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle('sessions', { create: true });
    const file = await sessions.getFileHandle('persistent.jsonl', { create: true });
    const writer = await file.createWritable();
    await writer.write(
      JSON.stringify({
        timestamp: '2026-09-07T12:00:00Z',
        type: 'session_meta',
        payload: { id: 'persistent-thread', title: 'Persistent directory' },
      }) + '\n',
    );
    await writer.close();
    const store = new SessionStore();
    try {
      const index = await store.openDirectory(root);
      return {
        hits: index.cacheHits,
        ids: index.sessions.map((session: { id: string }) => session.id),
      };
    } finally {
      store.dispose();
    }
  });
  expect(cold).toEqual({ hits: 0, ids: ['persistent-thread'] });
  await page.reload();
  await expect(page.locator('.session-row')).toHaveCount(1);
  const warm = await page.evaluate(async () => {
    const modulePath = '/src/lib/session-store.ts';
    const { SessionStore } = await import(/* @vite-ignore */ modulePath);
    const store = new SessionStore();
    try {
      const handle = await store.restoreDirectory();
      if (!handle) throw new Error('Saved directory handle was not restored.');
      const permitted = await store.hasDirectoryPermission(handle);
      const index = await store.openDirectory(handle);
      return {
        permitted,
        hits: index.cacheHits,
        ids: index.sessions.map((session: { id: string }) => session.id),
      };
    } finally {
      store.dispose();
    }
  });
  expect(warm).toEqual({ permitted: true, hits: 1, ids: ['persistent-thread'] });
});
