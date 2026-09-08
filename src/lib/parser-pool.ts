import type { ParsedSession, SessionMetadata } from '../types';

export const PARSER_VERSION = 'session-parser-v1-stream-8';
export interface ParseOptions {
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
}
export interface DetailSelector {
  sourceLine?: number;
  outputLine?: number;
  callId?: string;
  offset?: number;
  pageSize?: number;
}
export interface SessionDetail {
  code?: string;
  output?: string;
  args?: string;
  prompt?: string;
  language?: string;
  hasMore: boolean;
  nextOffset?: number;
  warnings: string[];
}
export interface ParserService {
  scanMetadata(file: File, options?: ParseOptions): Promise<SessionMetadata>;
  parseSession(file: File, options?: ParseOptions): Promise<ParsedSession>;
  loadDetails?(
    file: File,
    selector: DetailSelector,
    options?: ParseOptions,
  ): Promise<SessionDetail>;
  dispose?(): void;
}
type Result = SessionMetadata | ParsedSession | SessionDetail;
interface Job {
  id: number;
  operation: 'metadata' | 'session' | 'details';
  selector?: DetailSelector;
  file: File;
  options: ParseOptions;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  abort?: () => void;
  settled: boolean;
}
interface Slot {
  worker: Worker;
  job?: Job;
  interactiveOnly: boolean;
  retired: boolean;
}

export function abortError(): DOMException {
  return new DOMException('Loading cancelled', 'AbortError');
}

/** A bounded worker pool. Files are cloned as browser file references, never giant strings. */
export class ParserPool implements ParserService {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private sequence = 0;
  private disposed = false;

  constructor(
    count = Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1)),
    private readonly createWorker = () =>
      new Worker(new URL('../workers/parser.worker.ts', import.meta.url), { type: 'module' }),
  ) {
    for (let i = 0; i < Math.max(1, count); i++)
      this.slots.push(this.makeSlot(count > 2 && i === count - 1));
  }

  scanMetadata(file: File, options: ParseOptions = {}): Promise<SessionMetadata> {
    return this.submit('metadata', file, options) as Promise<SessionMetadata>;
  }

  parseSession(file: File, options: ParseOptions = {}): Promise<ParsedSession> {
    return this.submit('session', file, options) as Promise<ParsedSession>;
  }

  loadDetails(
    file: File,
    selector: DetailSelector,
    options: ParseOptions = {},
  ): Promise<SessionDetail> {
    return this.submit('details', file, options, selector) as Promise<SessionDetail>;
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.queue.splice(0)) this.finish(job, undefined, abortError());
    for (const slot of this.slots) {
      if (slot.job) this.finish(slot.job, undefined, abortError());
      slot.worker.terminate();
    }
  }

  private makeSlot(interactiveOnly = false): Slot {
    const slot: Slot = { worker: this.createWorker(), interactiveOnly, retired: false };
    slot.worker.onmessage = (
      event: MessageEvent<{
        id: number;
        result?: Result;
        error?: string;
        aborted?: boolean;
        bytes?: number;
      }>,
    ) => {
      const data = event.data;
      const job = slot.job;
      if (!job || job.id !== data.id) return;
      if (data.bytes !== undefined) {
        if (!job.settled) job.options.onBytes?.(data.bytes);
        return;
      }
      this.finish(
        job,
        data.result,
        data.aborted ? abortError() : data.error ? new Error(data.error) : undefined,
      );
      slot.job = undefined;
      this.pump();
    };
    slot.worker.onerror = (event: ErrorEvent) => {
      if (slot.retired) return;
      slot.retired = true;
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      if (slot.job)
        this.finish(slot.job, undefined, new Error(event.message || 'Parser worker failed'));
      slot.job = undefined;
      slot.worker.terminate();
      // A module-load failure can recur forever while idle. Restore capacity
      // only when an eligible queued job actually needs the worker.
      this.pump();
    };
    return slot;
  }

  private submit(
    operation: Job['operation'],
    file: File,
    options: ParseOptions,
    selector?: DetailSelector,
  ): Promise<Result> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence,
        operation,
        file,
        options,
        selector,
        resolve,
        reject,
        settled: false,
      };
      job.abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        else
          this.slots
            .find((slot) => slot.job === job)
            ?.worker.postMessage({ id: job.id, operation: 'cancel' });
        this.finish(job, undefined, abortError());
      };
      options.signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private finish(job: Job, result?: Result, error?: Error): void {
    if (job.settled) return;
    job.settled = true;
    if (job.abort) job.options.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error);
    else if (result) job.resolve(result);
    else job.reject(new Error('Parser returned no result'));
  }

  private pump(): void {
    if (this.disposed) return;
    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex++) {
      let slot = this.slots[slotIndex];
      if (slot.job) continue;
      let index = this.queue.findIndex((job) => job.operation !== 'metadata');
      if (index < 0 && !slot.interactiveOnly && this.queue.length) index = 0;
      if (index < 0) continue;
      const [job] = this.queue.splice(index, 1);
      if (slot.retired) {
        try {
          slot = this.makeSlot(slot.interactiveOnly);
          this.slots[slotIndex] = slot;
        } catch (error) {
          this.finish(job, undefined, error instanceof Error ? error : new Error(String(error)));
          // Constructor failures have no worker error event to advance the
          // remaining queue. Each retry consumes another actual queued job.
          queueMicrotask(() => this.pump());
          continue;
        }
      }
      slot.job = job;
      slot.worker.postMessage({
        id: job.id,
        operation: job.operation,
        file: job.file,
        selector: job.selector,
      });
    }
  }
}
