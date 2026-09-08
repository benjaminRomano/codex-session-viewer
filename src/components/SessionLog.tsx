import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import type { LogEntry, ParsedSession, Span } from '../types';
import { formatDuration } from '../lib/engine';
import { Bot, ChevronDown, ChevronRight, MessageSquare, Terminal, UserRound } from 'lucide-react';
import { SpanDetails, type LoadDetail } from './SpanDetails';
import './session-log.css';

interface SessionLogProps {
  sessions: ParsedSession[];
  load: LoadDetail;
  onHover: (id: string | null) => void;
  onFocus: (span: Span) => void;
  scopeKey?: string;
}
interface LogItem {
  entry: LogEntry;
  span: Span;
  session: ParsedSession;
}
const PREVIEW_LENGTH = 600;
const ROLE_ICONS = {
  user: UserRound,
  assistant: Bot,
  tool: Terminal,
  agent: MessageSquare,
  system: MessageSquare,
} as const;

function contentSpan(item: LogItem): Span {
  const { entry, span } = item;
  // The engine decides which event this entry represents. Physical record
  // selectors let call/result cards expand independently without duplicate text.
  if (entry.phase === 'call')
    return {
      ...span,
      outputLine: undefined,
      callId: span.sourceLine ? undefined : span.callId,
      output: undefined,
    };
  if (entry.phase === 'result')
    return {
      ...span,
      sourceLine: span.outputLine ? undefined : span.sourceLine,
      callId: span.outputLine || span.sourceLine ? undefined : span.callId,
      code: undefined,
      args: undefined,
    };
  return span;
}

function LogCard({
  item,
  expanded,
  onExpand,
  load,
  onHover,
  onFocus,
}: {
  item: LogItem;
  expanded: boolean;
  onExpand: () => void;
  load: LoadDetail;
  onHover: SessionLogProps['onHover'];
  onFocus: SessionLogProps['onFocus'];
}) {
  const { entry, session, span } = item;
  const displayed = contentSpan(item);
  const prompt =
    entry.role === 'user' && span.track === 'turns'
      ? session.turns.find((turn) => turn.id === entry.turnId)?.prompt
      : undefined;
  const code = displayed.code || displayed.args;
  const output = displayed.output;
  const message = prompt || (!code ? output : undefined);
  const name =
    session.metadata.agentName ||
    session.metadata.agentPath?.split('/').filter(Boolean).at(-1) ||
    'Main agent';
  const failure = /error|failed|aborted/i.test(span.status);
  const isTool = entry.role === 'tool';
  const label = isTool
    ? span.name
    : entry.role === 'user'
      ? 'You'
      : name === 'Main agent' || name === 'root'
        ? 'Codex'
        : name;
  const Icon = ROLE_ICONS[entry.role];
  const preview = message
    ?.slice(0, PREVIEW_LENGTH)
    .trim()
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');
  const toolPreview = (code || output || '').slice(0, PREVIEW_LENGTH).replace(/\s+/g, ' ').trim();
  return (
    <article
      className={`session-log-entry role-${entry.role}${expanded ? ' expanded' : ''}`}
      data-log-id={entry.id}
      data-span-id={span.id}
      data-log-role={entry.role}
      data-log-phase={entry.phase}
      onClick={(event) => {
        if (
          (event.target as Element).closest(
            'button,a,input,textarea,select,summary,[role="button"],[contenteditable="true"]',
          )
        )
          return;
        if (window.getSelection()?.toString()) return;
        onFocus(span);
      }}
      onMouseEnter={() => onHover(span.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(span.id)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHover(null);
      }}
    >
      <div className="session-log-entry-heading">
        <button
          className="session-log-expand"
          aria-label={expanded ? 'Collapse contents' : 'Full contents'}
          title={expanded ? 'Collapse contents' : 'Full contents'}
          aria-expanded={expanded}
          onClick={onExpand}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          className="session-log-focus"
          onClick={() => onFocus(span)}
          aria-label={`Focus ${entry.title}`}
        >
          <Icon size={13} aria-hidden="true" />
          <strong title={label}>{label}</strong>
          {failure && (
            <span className="session-log-failure" aria-label="Failed">
              ×
            </span>
          )}
        </button>
        {isTool && (
          <span className="session-log-source" title={name}>
            {name}
          </span>
        )}
        {isTool && entry.phase && <span className="session-log-phase">{entry.phase}</span>}
        <time dateTime={new Date(entry.timestamp).toISOString()}>
          {new Date(entry.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </time>
        {isTool && (
          <span className="session-log-duration">
            {formatDuration(span.endTime - span.startTime)}
          </span>
        )}
        {isTool && !expanded && toolPreview && (
          <span className="session-log-tool-preview">{toolPreview}</span>
        )}
      </div>
      {expanded ? (
        <div className="session-log-contents">
          <SpanDetails
            key={entry.id}
            compact
            phase={entry.phase}
            span={displayed}
            session={session}
            load={load}
          />
        </div>
      ) : !isTool && preview ? (
        <pre className="session-log-message">
          {preview}
          {message!.length > PREVIEW_LENGTH ? '…' : ''}
        </pre>
      ) : null}
    </article>
  );
}

/** Present the engine's canonical entries; no record or operation classification. */
function LogFeed({
  items,
  load,
  onHover,
  onFocus,
}: Omit<SessionLogProps, 'sessions' | 'scopeKey'> & { items: LogItem[] }) {
  const [expansion, setExpansion] = useState<{ current: string | null; previous: string | null }>({
    current: null,
    previous: null,
  });
  const scroll = useRef<HTMLDivElement>(null);
  const hoverCallback = useRef(onHover);
  hoverCallback.current = onHover;
  const getItemKey = useCallback((index: number) => items[index].entry.id, [items]);
  const retainedIndexes = useMemo(
    () =>
      [expansion.current, expansion.previous]
        .flatMap((id) => (id === null ? [] : [items.findIndex((item) => item.entry.id === id)]))
        .filter((index) => index >= 0),
    [items, expansion],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      // Retain the expanded payload when it leaves the viewport. Its predecessor
      // stays mounted collapsed so ResizeObserver can remove its former height.
      return [...new Set([...defaultRangeExtractor(range), ...retainedIndexes])].sort(
        (a, b) => a - b,
      );
    },
    [retainedIndexes],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: (index) => (items[index].entry.role === 'tool' ? 24 : 88),
    overscan: 12,
    rangeExtractor,
    paddingEnd: 8,
    // Expansion/width changes can resize the scroll extent during observer
    // delivery. Apply those measurements on the next frame, outside the loop.
    useAnimationFrameWithResizeObserver: true,
  });
  useEffect(() => () => hoverCallback.current(null), []);
  return (
    <div className="session-log" data-entry-count={items.length}>
      <div className="session-log-navigation">
        {items.length ? `${items.length.toLocaleString()} entries` : 'No log entries in this scope'}
      </div>
      <div
        className="session-log-scroll"
        ref={scroll}
        role="region"
        aria-label="Session log entries"
        tabIndex={0}
        onScroll={() => onHover(null)}
      >
        <div className="session-log-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="session-log-virtual-row"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <LogCard
                  item={item}
                  expanded={expansion.current === item.entry.id}
                  onExpand={() =>
                    setExpansion((previous) => ({
                      current: previous.current === item.entry.id ? null : item.entry.id,
                      previous: previous.current,
                    }))
                  }
                  load={load}
                  onHover={onHover}
                  onFocus={onFocus}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Present the engine's canonical entries; no record or operation classification. */
export function SessionLog({ sessions, load, onHover, onFocus, scopeKey }: SessionLogProps) {
  const items = useMemo(
    () =>
      sessions
        .flatMap((session) => {
          const spans = new Map(session.spans.map((span) => [span.id, span]));
          return (session.logEntries ?? []).flatMap((entry) => {
            const span = spans.get(entry.spanId);
            return span ? [{ entry, span, session }] : [];
          });
        })
        .sort(
          (a, b) => a.entry.timestamp - b.entry.timestamp || a.entry.id.localeCompare(b.entry.id),
        ),
    [sessions],
  );
  const key =
    scopeKey ??
    sessions.map((session) => `${session.metadata.id}:${session.spans[0]?.id ?? ''}`).join('|');
  return <LogFeed key={key} items={items} load={load} onHover={onHover} onFocus={onFocus} />;
}
