/// <reference lib="webworker" />
import init, { analyze_sessions } from '../wasm/session_parser';
import wasmUrl from '../wasm/session_parser_bg.wasm?url';
import { createWasmInitializer } from '../lib/wasm-runtime';
import type { ParsedSession } from '../types';
const ready = createWasmInitializer(init, wasmUrl);
let latest = 0;
self.onmessage = async (
  event: MessageEvent<{
    id: number;
    sessions: ParsedSession[];
    rootId: string;
    start: number;
    end: number;
  }>,
) => {
  const request = event.data;
  latest = request.id;
  try {
    await ready();
    if (request.id !== latest) return;
    const result: unknown = JSON.parse(
      analyze_sessions(
        JSON.stringify(request.sessions),
        request.rootId,
        request.start,
        request.end,
      ),
    );
    self.postMessage({ id: request.id, result });
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
