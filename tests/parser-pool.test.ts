import { describe, expect, it } from 'vitest';
import { ParserPool } from '../src/lib/parser-pool';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{ id: number; operation: string; file?: File }> = [];
  terminated = false;
  postMessage(message: { id: number; operation: string; file?: File }) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  finish(id: number) {
    this.onmessage?.({ data: { id, result: { id: `result-${id}` } } } as MessageEvent);
  }
  fail(message = 'Worker module failed to load') {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe('parser worker pool', () => {
  it('retires a failed idle worker and creates a replacement only for new work', async () => {
    const workers: FakeWorker[] = [];
    const pool = new ParserPool(1, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const staleError = workers[0].onerror;
    workers[0].fail();
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].onmessage).toBeNull();
    expect(workers[0].onerror).toBeNull();
    staleError?.({ message: 'A second queued error event' } as ErrorEvent);
    await Promise.resolve();
    expect(workers).toHaveLength(1);
    const result = pool.parseSession(new File(['{}'], 'example.jsonl'));
    expect(workers).toHaveLength(2);
    expect(workers[1].messages.map((message) => message.operation)).toEqual(['session']);
    workers[1].finish(1);
    await expect(result).resolves.toMatchObject({ id: 'result-1' });
    workers[1].fail();
    expect(workers).toHaveLength(2);
    pool.dispose();
    await expect(pool.scanMetadata(new File(['{}'], 'example.jsonl'))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(workers).toHaveLength(2);
  });

  it('reports active failures, advances queued work and stops replacing after the queue drains', async () => {
    const workers: FakeWorker[] = [];
    const pool = new ParserPool(1, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const file = new File(['{}'], 'example.jsonl');
    const active = pool.scanMetadata(file).catch((error) => error as Error);
    const abort = new AbortController();
    const cancelled = pool
      .parseSession(file, { signal: abort.signal })
      .catch((error) => error as Error);
    const next = pool.scanMetadata(file).catch((error) => error as Error);
    abort.abort();
    workers[0].fail('Active parser failed');
    expect(await active).toMatchObject({ message: 'Active parser failed' });
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(workers).toHaveLength(2);
    expect(workers[1].messages.map((message) => message.id)).toEqual([3]);
    workers[1].fail('Replacement parser failed');
    expect(await next).toMatchObject({ message: 'Replacement parser failed' });
    expect(workers).toHaveLength(2);
    pool.dispose();
  });

  it('rejects queued jobs when demand-driven worker construction fails instead of hanging them', async () => {
    const worker = new FakeWorker();
    let attempts = 0;
    const pool = new ParserPool(1, () => {
      if (attempts++ > 0) throw new Error('Worker construction denied');
      return worker as unknown as Worker;
    });
    const file = new File(['{}'], 'example.jsonl');
    const jobs = [pool.scanMetadata(file), pool.scanMetadata(file), pool.parseSession(file)].map(
      (job) => job.catch((error) => error as Error),
    );
    worker.fail('Active parser failed');
    expect(await Promise.all(jobs)).toMatchObject([
      { message: 'Active parser failed' },
      { message: 'Worker construction denied' },
      { message: 'Worker construction denied' },
    ]);
    expect(attempts).toBe(3);
    await Promise.resolve();
    expect(attempts).toBe(3);
    pool.dispose();
  });

  it('keeps a worker available for a selected session during a large metadata scan', async () => {
    const workers: FakeWorker[] = [];
    const pool = new ParserPool(4, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const file = new File(['{}'], 'example.jsonl');
    const scans = [
      pool.scanMetadata(file),
      pool.scanMetadata(file),
      pool.scanMetadata(file),
      pool.scanMetadata(file),
    ];
    expect(workers.map((worker) => worker.messages.length)).toEqual([1, 1, 1, 0]);
    const selected = pool.parseSession(file);
    expect(workers[3].messages[0].operation).toBe('session');
    workers[3].finish(5);
    await selected;
    workers[0].finish(1);
    workers[1].finish(2);
    workers[2].finish(3);
    workers[0].finish(4);
    await Promise.all(scans);
    pool.dispose();
  });

  it('bounds active jobs and starts queued files as slots free', async () => {
    const workers: FakeWorker[] = [];
    const pool = new ParserPool(2, () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const file = new File(['{}'], 'example.jsonl');
    const first = pool.scanMetadata(file);
    const second = pool.scanMetadata(file);
    const third = pool.scanMetadata(file);
    expect(workers.map((worker) => worker.messages.length)).toEqual([1, 1]);
    workers[0].finish(1);
    expect(workers[0].messages.map((message) => message.id)).toEqual([1, 3]);
    workers[1].finish(2);
    workers[0].finish(3);
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    pool.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('cancels queued jobs and waits for running cancellation before reusing a worker', async () => {
    const worker = new FakeWorker();
    const pool = new ParserPool(1, () => worker as unknown as Worker);
    const file = new File(['{}'], 'example.jsonl');
    const activeAbort = new AbortController();
    const queueAbort = new AbortController();
    const active = pool
      .parseSession(file, { signal: activeAbort.signal })
      .catch((error) => error as Error);
    const queued = pool
      .parseSession(file, { signal: queueAbort.signal })
      .catch((error) => error as Error);
    queueAbort.abort();
    activeAbort.abort();
    const next = pool.scanMetadata(file);
    expect(worker.messages.map((message) => message.operation)).toEqual(['session', 'cancel']);
    worker.onmessage?.({ data: { id: 1, aborted: true } } as MessageEvent);
    expect(worker.messages.at(-1)?.id).toBe(3);
    worker.finish(3);
    expect(((await active) as Error).name).toBe('AbortError');
    expect(((await queued) as Error).name).toBe('AbortError');
    await next;
    pool.dispose();
  });
});
