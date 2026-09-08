import init, * as wasm from '../wasm/session_parser';
import wasmUrl from '../wasm/session_parser_bg.wasm?url';
import { createWasmInitializer } from '../lib/wasm-runtime';
import type { DetailSelector } from '../lib/parser-pool';

interface Request {
  id: number;
  operation: 'metadata' | 'session' | 'details' | 'cancel';
  file: File;
  selector?: DetailSelector;
}
interface StreamingParser {
  push(chunk: string): void;
  finish(): string;
  free(): void;
  is_done?(): boolean;
}
const context = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<Request>) => void) | null;
};
const cancelled = new Set<number>();
const ready = createWasmInitializer(init, wasmUrl);

context.onmessage = (event) => {
  const request = event.data;
  if (request.operation === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  void parse(request);
};

async function parse({ id, operation, file, selector }: Request): Promise<void> {
  let parser: StreamingParser | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await ready();
    if (cancelled.has(id)) throw new DOMException('Cancelled', 'AbortError');
    if (operation === 'details') {
      parser = new wasm.DetailParser(JSON.stringify(selector ?? {}));
    } else
      parser = operation === 'metadata' ? new wasm.MetadataScanner() : new wasm.SessionParser();
    reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let reported = 0;
    let finishedEarly = false;
    while (true) {
      if (cancelled.has(id)) throw new DOMException('Cancelled', 'AbortError');
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        const failure = new Error(
          'The local file could not be read from its selected snapshot. It may have changed; refresh the directory or select it again.',
        );
        if (error instanceof Error) failure.name = error.name;
        throw failure;
      }
      const { value, done } = next;
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      bytes += value.byteLength;
      if (operation === 'details' && parser.is_done?.()) {
        finishedEarly = true;
        break;
      }
      if (bytes - reported >= 4 * 1024 * 1024) {
        context.postMessage({ id, bytes });
        reported = bytes;
        // Give cancel messages a turn even when Blob streams are immediately ready.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (!finishedEarly) parser.push(decoder.decode());
    if (cancelled.has(id)) throw new DOMException('Cancelled', 'AbortError');
    const result: unknown = JSON.parse(parser.finish());
    context.postMessage({ id, bytes });
    context.postMessage({ id, result });
  } catch (error) {
    context.postMessage({
      id,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      aborted: cancelled.has(id),
    });
  } finally {
    cancelled.delete(id);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    parser?.free();
  }
}
