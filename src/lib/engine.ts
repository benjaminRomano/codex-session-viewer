import { useEffect, useRef, useState } from 'react';
import type { Flow, ParsedSession, Span, TimeRange } from '../types';
interface OperationStatistic {
  name: string;
  track: string;
  count: number;
  total: number;
  max: number;
}
interface CriticalSegment {
  span: Span;
  start: number;
  end: number;
  duration: number;
}
export interface EngineAnalysis {
  flows: Flow[];
  path: {
    segments: CriticalSegment[];
    total: number;
    observed: number;
    inferred: number;
    suggestions: string[];
    statistics: OperationStatistic[];
  };
  statistics: OperationStatistic[];
}
const empty: EngineAnalysis = {
  flows: [],
  path: { segments: [], total: 0, observed: 0, inferred: 0, suggestions: [], statistics: [] },
  statistics: [],
};

/** Presentation hook only: all relationship, latency, and blocking-path logic lives in Rust. */
export function useEngineAnalysis(sessions: ParsedSession[], rootId: string, range: TimeRange) {
  const [result, setResult] = useState<EngineAnalysis>(empty);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const instance = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.current = instance;
    instance.onmessage = (
      event: MessageEvent<{ id: number; result?: EngineAnalysis; error?: string }>,
    ) => {
      if (event.data.id !== generation.current) return;
      if (event.data.error) {
        setError(event.data.error);
        setResult(empty);
      } else if (event.data.result) {
        setResult(event.data.result);
        setError('');
      }
    };
    instance.onerror = (event) => setError(event.message || 'Trace analysis failed.');
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, []);
  useEffect(() => {
    const id = ++generation.current;
    setResult(empty);
    setError('');
    if (!rootId || !sessions.length) return;
    // Operation payloads are for the details pane and do not enter graph analysis.
    const compact = sessions.map(({ logEntries: _logEntries, ...s }) => ({
      ...s,
      spans: s.spans.map(({ code: _code, output: _output, args: _args, ...span }) => span),
    }));
    worker.current?.postMessage({
      id,
      sessions: compact,
      rootId,
      start: range.start,
      end: range.end,
    });
  }, [sessions, rootId, range.start, range.end]);
  return { ...result, error, dismissError: () => setError('') };
}

export function formatDuration(ms: number): string {
  if (ms >= 3600000) return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
