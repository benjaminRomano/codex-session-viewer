import {
  ArrowLeft,
  ChevronRight,
  Download,
  Bot,
  MessageSquare,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  Info,
} from 'lucide-react';
import type { ParsedSession, SessionEntry, Turn } from '../types';
import { formatDuration } from '../lib/engine';
import { useMemo, useState } from 'react';
import { SessionInfo } from './SessionInfo';
export interface SidebarProps {
  entries: SessionEntry[];
  sessions: ParsedSession[];
  rootId: string;
  focusId: string;
  turnId: string;
  query: string;
  onQuery: (value: string) => void;
  archive: string;
  onArchive: (value: string) => void;
  limit: number;
  onMore: () => void;
  onSelect: (id: string) => void;
  onBack: () => void;
  onFocus: (id: string) => void;
  onTurn: (turn: Turn | undefined) => void;
  busy: boolean;
  scanning: boolean;
  demo: boolean;
  onRefresh: () => void;
  onExport: () => void;
}
function agentName(session: ParsedSession, rootId: string) {
  return (
    session.metadata.agentName ||
    session.metadata.agentPath?.split('/').filter(Boolean).at(-1) ||
    (session.metadata.id === rootId ? 'Main agent' : 'Agent')
  );
}
export function topLevelSessions(entries: SessionEntry[]) {
  const children = new Set(entries.flatMap((s) => s.childIds.filter((id) => id !== s.id)));
  return entries.filter(
    (s) =>
      !s.parentId &&
      !children.has(s.id) &&
      (s.agentPath?.split('/').filter(Boolean).length ?? 0) <= 1,
  );
}
/** Count unique descendants in the engine-provided index relationships. */
export function descendantCounts(entries: SessionEntry[]) {
  const children = new Map(entries.map((s) => [s.id, new Set(s.childIds)]));
  for (const s of entries) if (s.parentId) children.get(s.parentId)?.add(s.id);
  return new Map(
    entries.map((s) => {
      const seen = new Set([s.id]);
      const pending = [...(children.get(s.id) ?? [])];
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...(children.get(id) ?? []));
      }
      return [s.id, seen.size - 1];
    }),
  );
}
export function Sidebar(p: SidebarProps) {
  const [infoId, setInfoId] = useState('');
  const root = p.sessions.find((s) => s.metadata.id === p.rootId);
  const focused = p.sessions.find((s) => s.metadata.id === p.focusId) ?? root;
  const roots = topLevelSessions(p.entries);
  const filtered = roots.filter(
    (s) =>
      (p.archive === 'all' || s.archived === (p.archive === 'archived')) &&
      `${s.title} ${s.model} ${s.id}`.toLowerCase().includes(p.query.toLowerCase()),
  );
  const childCounts = useMemo(() => descendantCounts(p.entries), [p.entries]);
  const ordered: { session: ParsedSession; depth: number }[] = [];
  const seen = new Set<string>();
  function visit(id: string, depth: number) {
    const session = p.sessions.find((s) => s.metadata.id === id);
    if (!session || seen.has(id)) return;
    seen.add(id);
    ordered.push({ session, depth });
    for (const child of p.sessions)
      if (child.metadata.parentId === id || session.metadata.childIds.includes(child.metadata.id))
        visit(child.metadata.id, depth + 1);
  }
  visit(p.rootId, 0);
  for (const session of p.sessions)
    if (!seen.has(session.metadata.id)) visit(session.metadata.id, 1);
  return (
    <aside className="sidebar">
      {!p.rootId ? (
        <>
          <div className="sidebar-heading">
            <span>
              SESSIONS <b>{roots.length}</b>
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="Export session index"
                disabled={!p.entries.length}
                onClick={p.onExport}
              >
                <Download size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Refresh sessions"
                disabled={p.demo || !p.entries.length || p.scanning}
                onClick={p.onRefresh}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>
          <label className="search">
            <Search size={14} />
            <input
              aria-label="Search sessions"
              placeholder="Search sessions…"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
            />
          </label>
          <div className="sidebar-filters">
            <select
              aria-label="Archive filter"
              value={p.archive}
              onChange={(e) => p.onArchive(e.target.value)}
            >
              <option value="all">All sessions</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
            <span>{filtered.length} results</span>
          </div>
          <div className="session-list">
            {filtered.slice(0, p.limit).map((s) => (
              <button
                key={s.id}
                className="session-row"
                onClick={() => p.onSelect(s.id)}
                title={`${s.title}\n${s.id}`}
              >
                <span className="session-title">
                  <Layers size={12} />
                  {s.title || s.id}
                </span>
                <span className="session-meta">
                  {s.model || 'Unknown model'}
                  <i>·</i>
                  {s.turnCount} turn{s.turnCount !== 1 && 's'}
                  <i>·</i>
                  {childCounts.get(s.id) ?? 0} agent{childCounts.get(s.id) !== 1 && 's'}
                </span>
                <span className="session-date">
                  {s.endTime
                    ? new Date(s.endTime).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })
                    : ''}
                  {s.archived && ' · archived'}
                </span>
              </button>
            ))}
            {filtered.length > p.limit && (
              <button className="more-sessions" onClick={p.onMore}>
                Show 100 more
              </button>
            )}
            {!p.entries.length && (
              <div className="sidebar-empty">
                {p.scanning ? 'Indexing your sessions…' : 'Open a folder to browse your sessions.'}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <button className="back-to-sessions" onClick={p.onBack}>
            <ArrowLeft size={14} /> All sessions
          </button>
          <div className="scope-title">
            {p.entries.find((s) => s.id === p.rootId)?.title ||
              root?.metadata.title ||
              'Loading session…'}
          </div>
          <div className="scope-toolbar">
            <span>
              {p.sessions.length} agent{p.sessions.length !== 1 && 's'}
            </span>
            {root && (
              <button
                className="icon-button"
                aria-label="Session info"
                onClick={() => setInfoId(p.rootId)}
              >
                <Info size={14} />
              </button>
            )}
            {p.busy && (
              <span>
                <LoaderCircle size={12} className="spin" />
                Loading agents…
              </span>
            )}
          </div>
          <div className="scope-panel">
            <button
              className={`tree-row whole-session ${p.focusId === p.rootId && !p.turnId ? 'active' : ''}`}
              onClick={() => p.onFocus(p.rootId)}
            >
              <Layers size={14} />
              <span>Whole session</span>
            </button>
            <div className={`agent-tree ${ordered.length < 2 ? 'empty' : ''}`}>
              {ordered
                .filter(({ session }) => session.metadata.id !== p.rootId)
                .map(({ session: s, depth }) => (
                  <button
                    key={s.metadata.id}
                    style={{ paddingLeft: 12 + Math.min(depth, 6) * 10 }}
                    className={`agent-scope-row ${s.metadata.id === p.focusId ? 'active' : ''}`}
                    onClick={() => p.onFocus(s.metadata.id)}
                    title={s.metadata.agentDescription || s.metadata.title}
                  >
                    <Bot size={14} className="agent-icon" />
                    <span>
                      <strong>
                        {s.metadata.agentDescription || s.metadata.title || agentName(s, p.rootId)}
                      </strong>
                      <small>
                        {agentName(s, p.rootId)} · {s.turns.length} turn
                        {s.turns.length !== 1 && 's'}
                      </small>
                    </span>
                    <ChevronRight size={12} />
                  </button>
                ))}
            </div>
            {focused && (
              <>
                <div className="turn-heading">{agentName(focused, p.rootId)}</div>
                <div className="scope-switch" role="group" aria-label="Focus mode">
                  <button aria-pressed={!p.turnId} onClick={() => p.onTurn(undefined)}>
                    Session
                  </button>
                  <button
                    aria-pressed={!!p.turnId}
                    disabled={!focused.turns.length}
                    onClick={() =>
                      p.onTurn(focused.turns.find((t) => t.id === p.turnId) ?? focused.turns[0])
                    }
                  >
                    Turn
                  </button>
                </div>
                <div className="turn-list">
                  {focused.turns.map((t, i) => (
                    <button
                      className={`tree-row turn-row ${p.turnId === t.id ? 'active' : ''}`}
                      key={t.id}
                      onClick={() => p.onTurn(t)}
                      title={t.title}
                    >
                      <MessageSquare size={12} className="turn-icon" />
                      <span className="turn-number">{i + 1}</span>
                      <span>{t.title || `Turn ${i + 1}`}</span>
                      <small>{formatDuration(t.endTime - t.startTime)}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {root && infoId === p.rootId && (
        <SessionInfo
          sessions={p.sessions}
          entries={p.entries}
          rootId={p.rootId}
          onClose={() => setInfoId('')}
        />
      )}
    </aside>
  );
}
