import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import rust from 'highlight.js/lib/languages/rust';
import diff from 'highlight.js/lib/languages/diff';
import 'highlight.js/styles/github.css';
import type { ParsedSession, Span } from '../types';
import type { DetailSelector, SessionDetail } from '../lib/parser-pool';
import { formatDuration } from '../lib/engine';
for (const [name, language] of Object.entries({ javascript, json, bash, rust, diff }))
  hljs.registerLanguage(name, language);

export type LoadDetail = (
  sessionId: string,
  selector: DetailSelector,
  signal: AbortSignal,
) => Promise<SessionDetail>;

function PlainTextBlock({ text, className }: { text: string; className: string }) {
  const chunks = useMemo(() => {
    if (text.length <= 32_768) return [text];
    const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
    const result: string[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16_384, text.length);
      if (end < text.length) {
        const boundary = graphemes.containing(end)!;
        end = boundary.index > start ? boundary.index : boundary.index + boundary.segment.length;
      }
      result.push(text.slice(start, end));
      start = end;
    }
    return result;
  }, [text]);
  return (
    <pre
      className={className}
      onCopy={(event) => {
        const selection = window.getSelection();
        if (selection?.rangeCount !== 1) return;
        const range = selection.getRangeAt(0);
        if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
        // Block boundaries bound Chrome's line-wrapping cost. Copy the original
        // text nodes, without the extra visual breaks introduced by those blocks.
        event.clipboardData.setData('text/plain', range.toString());
        event.preventDefault();
      }}
    >
      {chunks.length === 1
        ? text
        : chunks.map((chunk, index) => (
            <span className="text-chunk" key={index}>
              {chunk}
            </span>
          ))}
    </pre>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  // Large output stays complete; avoid synchronously highlighting megabytes on the UI thread.
  const html = useMemo(
    () =>
      code.length > 200_000
        ? undefined
        : hljs.highlight(code, {
            language: language && hljs.getLanguage(language) ? language : 'javascript',
            ignoreIllegals: true,
          }).value,
    [code, language],
  );
  if (html === undefined) return <PlainTextBlock text={code} className="code-block" />;
  return (
    <pre className="code-block">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export function SpanDetails({
  span,
  session,
  load,
  compact = false,
  phase,
}: {
  span: Span;
  session?: ParsedSession;
  load: LoadDetail;
  compact?: boolean;
  phase?: 'call' | 'result';
}) {
  const [pages, setPages] = useState<SessionDetail[]>([]);
  const data = pages.at(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const turn = session?.turns.find((t) => t.id === span.turnId);
  const sourceLine = span.sourceLine ?? (span.track === 'turns' ? turn?.sourceLine : undefined);
  const selector = useMemo<DetailSelector>(
    () => ({ sourceLine, outputLine: span.outputLine, callId: span.callId }),
    [sourceLine, span.outputLine, span.callId],
  );
  const fetchPage = useCallback(
    async (offset = 0) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError('');
      try {
        const result = await load(span.sessionId, { ...selector, offset }, controller.signal);
        if (controller.signal.aborted) return;
        setPages((previous) => (offset ? [...previous, result] : [result]));
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [load, span.sessionId, selector],
  );
  useEffect(() => {
    setPages([]);
    if (sourceLine || span.outputLine || span.callId) void fetchPage();
    return () => request.current?.abort();
  }, [span.id, sourceLine, span.outputLine, span.callId, fetchPage]);
  const fallback: SessionDetail = {
    code: span.code,
    args: span.args,
    output: span.output,
    language: span.language,
    prompt: span.track === 'turns' ? turn?.prompt : undefined,
    hasMore: false,
    warnings: [],
  };
  const displayedPages = pages.length ? pages : [fallback];
  return (
    <div className="span-detail">
      {!compact && (
        <>
          <div className="span-detail-title">
            <strong>{span.name}</strong>
            <span>{span.status}</span>
          </div>
          <dl>
            <dt>Agent</dt>
            <dd>
              {session?.metadata.agentName ||
                session?.metadata.agentPath?.split('/').at(-1) ||
                'Main agent'}
            </dd>
            <dt>Start</dt>
            <dd>{new Date(span.startTime).toISOString()}</dd>
            <dt>Duration</dt>
            <dd>{formatDuration(span.endTime - span.startTime)}</dd>
          </dl>
        </>
      )}
      {loading && (
        <div className="detail-loading" role="status">
          Loading contents…
        </div>
      )}
      {error && (
        <div className="detail-error" role="alert">
          {error}
          <button onClick={() => void fetchPage(data?.nextOffset)}>Retry</button>
        </div>
      )}
      {displayedPages.map((page, index) => {
        const prompt = page.prompt ?? (span.track === 'turns' ? page.output : undefined);
        const code = phase === 'result' ? undefined : page.code || page.args;
        return (
          <section className="detail-page" key={index}>
            {(displayedPages.length > 1 || data?.hasMore) && (
              <div className="detail-page-label">Page {index + 1}</div>
            )}
            {page.warnings.map((warning) => (
              <div className="detail-error" key={warning}>
                {warning}
              </div>
            ))}
            {prompt && <PlainTextBlock text={prompt} className="prompt-block" />}
            {code && (
              <CodeBlock
                code={code}
                language={page.language || span.language || (page.code ? 'javascript' : 'json')}
              />
            )}
            {page.output && span.track !== 'turns' && phase !== 'call' && (
              <details open>
                <summary>{span.status === 'error' ? 'Error output' : 'Output'}</summary>
                <PlainTextBlock text={page.output} className="output-block" />
              </details>
            )}
          </section>
        );
      })}
      {data?.hasMore && (
        <button
          className="load-more-content"
          disabled={loading}
          onClick={() => void fetchPage(data.nextOffset)}
        >
          Load more contents
        </button>
      )}
    </div>
  );
}
