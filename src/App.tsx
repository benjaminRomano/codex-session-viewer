import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  X,
  Keyboard,
  LoaderCircle,
  Menu,
} from 'lucide-react';
import { Timeline } from './components/Timeline';
import { Sidebar } from './components/Sidebar';
import { SessionLog } from './components/SessionLog';
import { SpanDetails, type LoadDetail } from './components/SpanDetails';
import { ParserPool } from './lib/parser-pool';
import { SessionStore, type ScanProgress, type SessionGraph } from './lib/session-store';
import { useEngineAnalysis, formatDuration } from './lib/engine';
import {
  TRACK_LABELS,
  type ParsedSession,
  type SessionEntry,
  type Span,
  type TimeRange,
  type Turn,
} from './types';
const demoIds = ['demo-root', 'demo-parser', 'demo-timeline', 'demo-review'];
const bytes = (n: number) =>
  n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isEngineError = (message: string) => message.includes('parser engine could not be loaded');
const pool = new ParserPool();
const services = { pool, store: new SessionStore(pool) };
if (import.meta.hot) import.meta.hot.dispose(() => services.store.dispose());

function OpenDialog({
  onClose,
  onOpen,
  onFiles,
  onDemo,
  saved,
  onReconnect,
}: {
  onClose: () => void;
  onOpen: () => void;
  onFiles: (files: FileList) => void;
  onDemo: () => void;
  saved: boolean;
  onReconnect: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="open-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <button
        className="dialog-close icon-button"
        aria-label="Close directory instructions"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="dialog-icon">
        <FolderOpen size={28} />
      </div>
      <h1>Open your Codex sessions</h1>
      <p>
        Choose your <code>~/.codex</code> folder. Sessions and archived sessions are read directly
        from your disk.
      </p>
      <ol className="directory-steps">
        <li>
          <span>1</span>
          <div>Open the folder picker below.</div>
        </li>
        <li>
          <span>2</span>
          <div>
            On macOS, press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>G</kbd> and enter <code>~/.codex</code>.
            <small>
              Or press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>.</kbd> to show hidden folders in Finder.
            </small>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            Select the folder and allow read access.
            <small>
              Windows: <code>%USERPROFILE%\.codex</code> · Linux: <code>~/.codex</code>
            </small>
          </div>
        </li>
      </ol>
      <div className="local-note">
        Files stay local. The cached index includes session titles and agent descriptions.
      </div>
      <div className="dialog-actions">
        <button onClick={onDemo}>Explore example</button>
        {saved && <button onClick={onReconnect}>Reconnect folder</button>}
        <button
          className="primary"
          onClick={'showDirectoryPicker' in window ? onOpen : () => files.current?.click()}
        >
          <FolderOpen size={16} /> Choose .codex folder
        </button>
      </div>
      {'showDirectoryPicker' in window ? (
        <button className="text-button fallback-button" onClick={() => files.current?.click()}>
          Use folder upload instead
        </button>
      ) : (
        <p className="compatibility">
          This browser uses a folder import. Chrome or Edge can remember folder access for
          refreshes.
        </p>
      )}
      <input
        ref={files}
        type="file"
        multiple
        {...{ webkitdirectory: '', directory: '' }}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
        }}
      />
    </dialog>
  );
}

export default function App() {
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [sessions, setSessions] = useState<ParsedSession[]>([]);
  const [rootId, setRootId] = useState('');
  const [focusId, setFocusId] = useState('');
  const [turnId, setTurnId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tab, setTab] = useState<'selection' | 'critical' | 'statistics' | 'log'>('selection');
  const [highlightedId, setHighlightedId] = useState<string>();
  const [spanFocus, setSpanFocus] = useState<{ spanId: string; nonce: number }>();
  const [critical, setCritical] = useState(false);
  const [modal, setModal] = useState(false);
  const [saved, setSaved] = useState<FileSystemDirectoryHandle>();
  const [query, setQuery] = useState('');
  const [archive, setArchive] = useState('all');
  const [limit, setLimit] = useState(100);
  const [progress, setProgress] = useState<ScanProgress>();
  const [graph, setGraph] = useState<SessionGraph>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [measure, setMeasure] = useState<TimeRange | null>(null);
  const [sidebar, setSidebar] = useState(() => {
    try {
      return localStorage.getItem('codex-viewer:sidebar') !== 'hidden';
    } catch {
      return true;
    }
  });
  const [dockHeight, setDockHeight] = useState(240);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const demoCache = useRef<ParsedSession[]>([]);
  const demoFiles = useRef(new Map<string, File>());
  const loadDetail = useCallback<LoadDetail>(
    (id, selector, signal) => {
      const file = demo ? demoFiles.current.get(id) : undefined;
      return file
        ? services.pool.loadDetails(file, selector, { signal })
        : services.store.loadDetails(id, selector, { signal });
    },
    [demo],
  );
  const [help, setHelp] = useState(false);
  const [detailId, setDetailId] = useState('');
  const scanAbort = useRef<AbortController | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const scan = useCallback(
    async (handle?: FileSystemDirectoryHandle, files?: FileList, refresh = false) => {
      scanAbort.current?.abort();
      loadAbort.current?.abort();
      generation.current++;
      const controller = new AbortController();
      scanAbort.current = controller;
      setModal(false);
      setDemo(false);
      setError('');
      setEntries([]);
      setSessions([]);
      setRootId('');
      setFocusId('');
      setGraph(undefined);
      setBusy(false);
      const options = {
        signal: controller.signal,
        onProgress: (p: ScanProgress) => {
          if (!controller.signal.aborted) {
            setProgress(p);
            setEntries(p.sessions);
          }
        },
      };
      try {
        const index = refresh
          ? await services.store.scan(options)
          : handle
            ? await services.store.openDirectory(handle, options)
            : await services.store.openFiles(Array.from(files!), options);
        if (!controller.signal.aborted) {
          setEntries(index.sessions);
          if (handle) setSaved(handle);
          if (index.errors.length)
            setError(
              isEngineError(index.errors[0])
                ? index.errors[0]
                : `${index.errors.length} session files could not be read. ${index.errors[0]}`,
            );
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void services.store
      .restoreDirectory()
      .then(async (handle) => {
        if (cancelled) return;
        setSaved(handle);
        if (handle && (await services.store.hasDirectoryPermission(handle))) {
          if (!cancelled) void scan(handle);
        } else if (!cancelled) setModal(true);
      })
      .catch(() => {
        if (!cancelled) setModal(true);
      });
    return () => {
      cancelled = true;
    };
  }, [scan]);
  useEffect(() => {
    try {
      localStorage.setItem('codex-viewer:sidebar', sidebar ? 'visible' : 'hidden');
    } catch {
      /* Folder access remains usable when browser preference storage is unavailable. */
    }
  }, [sidebar]);
  useEffect(() => {
    setHighlightedId(undefined);
    setSpanFocus(undefined);
  }, [rootId, focusId, turnId]);
  useEffect(() => {
    if (tab !== 'log') {
      setHighlightedId(undefined);
      setSpanFocus(undefined);
    }
  }, [tab]);
  const selected = useMemo(() => {
    const ids = new Set(selectedIds);
    return sessions.flatMap((s) => s.spans).filter((s) => ids.has(s.id));
  }, [sessions, selectedIds]);
  const focused =
    sessions.find((s) => s.metadata.id === focusId) ??
    sessions.find((s) => s.metadata.id === rootId);
  const root = sessions.find((s) => s.metadata.id === rootId);
  const turn = focused?.turns.find((t) => t.id === turnId);
  const range = useMemo<TimeRange>(
    () =>
      turn
        ? { start: turn.startTime, end: turn.endTime }
        : { start: focused?.metadata.startTime ?? 0, end: focused?.metadata.endTime ?? 1 },
    [turn, focused],
  );
  const visibleSessions = useMemo(() => {
    const descendants = new Set([focusId || rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of sessions)
        if (
          !descendants.has(s.metadata.id) &&
          (descendants.has(s.metadata.parentId ?? '') ||
            sessions.some(
              (p) => descendants.has(p.metadata.id) && p.metadata.childIds.includes(s.metadata.id),
            ))
        ) {
          descendants.add(s.metadata.id);
          changed = true;
        }
    }
    return sessions
      .filter(
        (s) =>
          descendants.has(s.metadata.id) &&
          s.metadata.endTime >= range.start &&
          s.metadata.startTime <= range.end,
      )
      .map((s) => ({
        ...s,
        spans: s.spans.filter((span) => span.endTime >= range.start && span.startTime <= range.end),
        logEntries: s.logEntries?.filter(
          (entry) => entry.timestamp >= range.start && entry.timestamp <= range.end,
        ),
      }));
  }, [sessions, focusId, rootId, range]);
  const {
    flows,
    path,
    statistics,
    error: analysisError,
    dismissError: dismissAnalysisError,
  } = useEngineAnalysis(visibleSessions, focusId || rootId, range);
  const detail = selected.find((s) => s.id === detailId) ?? selected[0];

  function focusSession(id: string) {
    setFocusId(id);
    setTurnId('');
    setSelectedIds([]);
    setMeasure(null);
    setHighlightedId(undefined);
    setSpanFocus(undefined);
  }
  function backToSessions() {
    loadAbort.current?.abort();
    generation.current++;
    setRootId('');
    setFocusId('');
    setSessions([]);
    setSelectedIds([]);
    setTurnId('');
    setGraph(undefined);
    setBusy(false);
    setError('');
    setMeasure(null);
  }
  function selectTurn(turn: Turn | undefined) {
    setTurnId(turn?.id || '');
    setMeasure(null);
    setTab('selection');
    setDockCollapsed(false);
    const span = focused?.spans.find((s) => s.track === 'turns' && s.turnId === turn?.id);
    setSelectedIds(span ? [span.id] : []);
  }
  function boundedDockHeight(height: number) {
    return Math.max(100, Math.min(window.innerHeight - 180, height));
  }
  function resizeDock(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const y = event.clientY;
    const height = dockCollapsed ? 240 : dockHeight;
    setDockCollapsed(false);
    const move = (e: PointerEvent) => setDockHeight(boundedDockHeight(height + y - e.clientY));
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  }
  function updateGraph(next: SessionGraph) {
    setGraph(next);
    setSessions([...next.sessions.values()]);
    if (next.complete && Object.keys(next.errors).length) {
      const message = Object.values(next.errors)[0];
      setError(
        isEngineError(message)
          ? message
          : `${Object.keys(next.errors).length} agent session files could not be read. ${message}`,
      );
    }
  }
  async function selectSession(id: string) {
    if (demo) {
      const ids = new Set([id]);
      for (let previous = 0; previous !== ids.size;) {
        previous = ids.size;
        for (const s of demoCache.current)
          if (ids.has(s.metadata.id)) {
            for (const child of demoCache.current)
              if (
                child.metadata.parentId === s.metadata.id ||
                s.metadata.childIds.includes(child.metadata.id)
              )
                ids.add(child.metadata.id);
          }
      }
      setSessions(demoCache.current.filter((s) => ids.has(s.metadata.id)));
      setRootId(id);
      focusSession(id);
      return;
    }
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setRootId(id);
    focusSession(id);
    setSessions([]);
    setGraph(undefined);
    try {
      const next = await services.store.loadGraph(id, {
        mode: 'eager',
        signal: controller.signal,
        onProgress: (next) => {
          if (generation.current === current) updateGraph(next);
        },
      });
      if (generation.current === current && next.errors[id]) setError(next.errors[id]);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function loadDemo() {
    scanAbort.current?.abort();
    loadAbort.current?.abort();
    const current = ++generation.current;
    const controller = new AbortController();
    loadAbort.current = controller;
    setModal(false);
    setBusy(true);
    setError('');
    setProgress(undefined);
    setGraph(undefined);
    try {
      const parsed = await Promise.all(
        demoIds.map(async (id) => {
          const response = await fetch(`${import.meta.env.BASE_URL}demo/${id}.jsonl`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Could not load the example trace.');
          const file = new File([await response.blob()], `${id}.jsonl`);
          const session = await services.pool.parseSession(file, { signal: controller.signal });
          demoFiles.current.set(session.metadata.id, file);
          return session;
        }),
      );
      if (generation.current !== current) return;
      demoCache.current = parsed;
      setSessions(parsed);
      setEntries(
        parsed.map((s) => ({
          ...s.metadata,
          path: `demo/${s.metadata.id}.jsonl`,
          size: 0,
          modified: 0,
          archived: false,
        })),
      );
      setDemo(true);
      setRootId(parsed[0].metadata.id);
      focusSession(parsed[0].metadata.id);
    } catch (e) {
      if (generation.current === current && !controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function openDirectory() {
    try {
      const handle = await (
        window as unknown as {
          showDirectoryPicker: (options: {
            mode: string;
            id: string;
          }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker({ mode: 'read', id: 'codex-sessions' });
      await scan(handle);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
    }
  }
  async function reconnect() {
    if (!saved) return;
    try {
      if (await services.store.requestDirectoryPermission(saved)) await scan(saved);
      else setError('Folder access was not granted. Choose the folder again to continue.');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function exportIndex() {
    const blob = new Blob([JSON.stringify({ version: 1, sessions: entries }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'codex-session-index.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const scanning = progress && progress.phase !== 'complete' && !scanAbort.current?.signal.aborted;
  const focusSpan = (span: Span) => {
    setSelectedIds([span.id]);
    setDetailId(span.id);
    setSpanFocus((previous) => ({ spanId: span.id, nonce: (previous?.nonce ?? 0) + 1 }));
    setDockCollapsed(false);
  };
  const criticalDetail =
    detail && path.segments.some((segment) => segment.span.id === detail.id) ? detail : undefined;
  const rootTitle =
    entries.find((s) => s.id === rootId)?.title || root?.metadata.title || 'Session viewer';
  return (
    <div className="application">
      <header className="app-header">
        <button
          className="brand"
          onClick={() => setSidebar(!sidebar)}
          title="Toggle sidebar"
          aria-label={sidebar ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          <Activity size={23} />
          <strong>Codex</strong>
          <span>Session viewer</span>
          <Menu size={17} style={{ marginLeft: 8 }} />
        </button>
        <div className="header-title">
          {rootId && (
            <>
              <span className="header-divider" />
              {rootTitle}
            </>
          )}
        </div>
        <div className="header-actions">
          {demo && <span className="demo-label">Example trace</span>}
          <button
            className="icon-button"
            aria-label="Keyboard shortcuts"
            onClick={() => setHelp(!help)}
          >
            <Keyboard size={18} />
          </button>
          <button onClick={() => setModal(true)}>
            <FolderOpen size={16} /> Open folder
          </button>
        </div>
      </header>
      <div className="workspace">
        {sidebar && (
          <Sidebar
            entries={entries}
            sessions={sessions}
            rootId={rootId}
            focusId={focusId}
            turnId={turnId}
            query={query}
            onQuery={(value) => {
              setQuery(value);
              setLimit(100);
            }}
            archive={archive}
            onArchive={setArchive}
            limit={limit}
            onMore={() => setLimit(limit + 100)}
            onSelect={(id) => void selectSession(id)}
            onBack={backToSessions}
            onFocus={focusSession}
            onTurn={selectTurn}
            busy={busy}
            scanning={!!scanning}
            demo={demo}
            onRefresh={() => void scan(undefined, undefined, true)}
            onExport={exportIndex}
          />
        )}
        <main className="main-panel">
          {(error || analysisError) && (
            <div className="error-banner" role="alert">
              {error || analysisError}
              {isEngineError(error || analysisError) && (
                <button onClick={() => window.location.reload()}>Reload viewer</button>
              )}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => {
                  setError('');
                  dismissAnalysisError();
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {!!scanning && (
            <div className="scan-progress">
              <LoaderCircle size={14} className="spin" />
              <span>
                {progress.phase === 'discovering'
                  ? 'Finding session files'
                  : `Indexing ${progress.completed} / ${progress.total} sessions`}
              </span>
              <progress value={progress.completed} max={Math.max(progress.total, 1)} />
              <small>
                {bytes(progress.bytesProcessed)} / {bytes(progress.totalBytes)} ·{' '}
                {progress.cacheHits} cached
              </small>
              <button
                onClick={() => {
                  scanAbort.current?.abort();
                  setProgress((p) => (p ? { ...p, phase: 'complete' } : p));
                }}
              >
                Stop
              </button>
            </div>
          )}
          {focused ? (
            <>
              <div className="trace-heading">
                <div className="breadcrumbs">
                  {focusId !== rootId && (
                    <button
                      className="icon-button"
                      aria-label="Back to main session"
                      onClick={() => focusSession(rootId)}
                    >
                      <ArrowLeft size={15} />
                    </button>
                  )}
                  <span>
                    {focusId === rootId ? 'Session' : focused.metadata.agentName || 'Agent'}
                  </span>
                  <ChevronRight size={13} />
                  <strong>{turn ? `Turn ${focused.turns.indexOf(turn) + 1}` : 'All turns'}</strong>
                  <span className="trace-time">{formatDuration(range.end - range.start)}</span>
                </div>
                <div className="trace-info">
                  {busy && <LoaderCircle size={13} className="spin" />}
                  {graph?.loading ? `${graph.loading} agents loading · ` : ''}
                  {visibleSessions.length} agent{visibleSessions.length !== 1 ? 's' : ''}
                  {graph?.missing.length ? (
                    <span className="missing"> · {graph.missing.length} missing</span>
                  ) : (
                    ''
                  )}
                  <button
                    className={critical ? 'active' : ''}
                    onClick={() => {
                      setCritical(!critical);
                      if (!critical) setTab('critical');
                    }}
                  >
                    <span className="critical-line" />
                    Critical path
                  </button>
                </div>
              </div>
              <Timeline
                highlightedId={highlightedId}
                focusRequest={spanFocus}
                sessions={visibleSessions}
                range={range}
                selectedIds={selectedIds}
                onSelectionChange={(ids) => {
                  setSelectedIds(ids);
                  setTab('selection');
                  setDockCollapsed(false);
                }}
                flows={flows}
                onInspectSession={focusSession}
                onMeasureChange={setMeasure}
                measurement={measure}
                criticalSegments={
                  critical
                    ? path.segments.map((s) => ({ spanId: s.span.id, start: s.start, end: s.end }))
                    : []
                }
              />
              <section
                className={`details-panel ${dockCollapsed ? 'collapsed' : ''}`}
                style={{ height: dockCollapsed ? 31 : dockHeight }}
              >
                <div
                  className="dock-resize"
                  role="separator"
                  aria-label="Resize details panel"
                  aria-orientation="horizontal"
                  tabIndex={0}
                  onPointerDown={resizeDock}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      setDockCollapsed(false);
                      setDockHeight((h) =>
                        boundedDockHeight(
                          (dockCollapsed ? 240 : h) + (e.key === 'ArrowUp' ? 20 : -20),
                        ),
                      );
                    }
                  }}
                />
                <div className="details-tabs">
                  <button
                    className={tab === 'selection' ? 'active' : ''}
                    onClick={() => setTab('selection')}
                  >
                    Selection{selected.length ? ` (${selected.length})` : ''}
                  </button>
                  <button
                    className={tab === 'critical' ? 'active' : ''}
                    onClick={() => setTab('critical')}
                  >
                    Critical path
                  </button>
                  <button
                    className={tab === 'statistics' ? 'active' : ''}
                    onClick={() => setTab('statistics')}
                  >
                    Statistics
                  </button>
                  <button
                    className={tab === 'log' ? 'active' : ''}
                    onClick={() => {
                      setTab('log');
                      setDockCollapsed(false);
                    }}
                  >
                    Session Log
                  </button>
                  <button
                    className="dock-toggle"
                    aria-label={dockCollapsed ? 'Expand details panel' : 'Collapse details panel'}
                    onClick={() => setDockCollapsed(!dockCollapsed)}
                  >
                    {dockCollapsed ? '▴' : '▾'}
                  </button>
                  {measure && (
                    <span className="measurement">
                      Measurement {formatDuration(measure.end - measure.start)}
                      <button
                        className="icon-button"
                        aria-label="Clear measurement"
                        onClick={() => setMeasure(null)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  )}
                </div>
                <div className="details-content">
                  {tab === 'log' && (
                    <SessionLog
                      scopeKey={`${focusId || rootId}:${turnId}`}
                      sessions={visibleSessions}
                      load={loadDetail}
                      onHover={(id) => setHighlightedId(id ?? undefined)}
                      onFocus={focusSpan}
                    />
                  )}
                  {tab === 'selection' &&
                    (!selected.length ? (
                      <div className="selection-empty">
                        <span>Select a slice to inspect its timing and contents.</span>
                        <small>
                          Shift + click to select multiple · Drag across tracks to select an area ·
                          M to measure
                        </small>
                      </div>
                    ) : (
                      <div className="selection-layout">
                        <div className="table-scroll">
                          <div className="selection-summary">
                            {selected.length} slices
                            <span>
                              {formatDuration(
                                selected.reduce((n, s) => n + s.endTime - s.startTime, 0),
                              )}{' '}
                              summed duration
                            </span>
                          </div>
                          <table>
                            <thead>
                              <tr>
                                <th>Slice</th>
                                <th>Track</th>
                                <th>Duration</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selected.map((s) => (
                                <tr
                                  key={s.id}
                                  className={detail?.id === s.id ? 'selected' : ''}
                                  onClick={() => setDetailId(s.id)}
                                >
                                  <td>{s.name}</td>
                                  <td>{TRACK_LABELS[s.track]}</td>
                                  <td>{formatDuration(s.endTime - s.startTime)}</td>
                                  <td>{s.status}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {detail && (
                          <SpanDetails
                            key={detail.id}
                            span={detail}
                            session={sessions.find((s) => s.metadata.id === detail.sessionId)}
                            load={loadDetail}
                          />
                        )}
                      </div>
                    ))}
                  {tab === 'critical' && (
                    <div className="critical-panel">
                      <div className="analysis-note">
                        Blocking path · {formatDuration(path.total)} · {path.segments.length}{' '}
                        operations
                      </div>
                      <div className="critical-content">
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Operation</th>
                                <th>Agent</th>
                                <th>Path duration</th>
                              </tr>
                            </thead>
                            <tbody>
                              {path.segments.map((s, i) => (
                                <tr
                                  key={`${s.span.id}-${i}`}
                                  className={criticalDetail?.id === s.span.id ? 'selected' : ''}
                                  aria-selected={criticalDetail?.id === s.span.id}
                                  tabIndex={0}
                                  onClick={() => focusSpan(s.span)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      focusSpan(s.span);
                                    }
                                  }}
                                >
                                  <td>{i + 1}</td>
                                  <td>
                                    <span className="critical-dot" />
                                    {s.span.name}
                                  </td>
                                  <td>
                                    {sessions.find((x) => x.metadata.id === s.span.sessionId)
                                      ?.metadata.agentName || s.span.sessionId.slice(0, 8)}
                                  </td>
                                  <td>{formatDuration(s.duration)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {criticalDetail ? (
                          <SpanDetails
                            key={criticalDetail.id}
                            span={criticalDetail}
                            session={sessions.find(
                              (session) => session.metadata.id === criticalDetail.sessionId,
                            )}
                            load={loadDetail}
                          />
                        ) : (
                          <div className="critical-empty">
                            Select an operation to inspect its details.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {tab === 'statistics' && (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Operation</th>
                            <th>Track</th>
                            <th>Count</th>
                            <th>Total</th>
                            <th>Average</th>
                            <th>Longest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statistics.map((s) => (
                            <tr key={`${s.track}:${s.name}`}>
                              <td>{s.name}</td>
                              <td>
                                {TRACK_LABELS[s.track as keyof typeof TRACK_LABELS] || s.track}
                              </td>
                              <td>{s.count}</td>
                              <td>{formatDuration(s.total)}</td>
                              <td>{formatDuration(s.total / s.count)}</td>
                              <td>{formatDuration(s.max)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : !rootId && entries.length > 0 ? (
            <div className="empty-trace" />
          ) : (
            <div className="empty-workspace">
              <div className="trace-placeholder">
                <div />
                <div />
                <div />
                <div />
              </div>
              <h1>
                {busy
                  ? 'Loading session…'
                  : scanning
                    ? 'Your sessions are appearing in the sidebar'
                    : 'Explore your agent’s execution'}
              </h1>
              <p>
                {scanning
                  ? 'You can open a session while the remaining files are indexed.'
                  : 'Follow turns, tools, and sub-agents on one timeline.'}
              </p>
              {!busy && !scanning && (
                <div>
                  <button className="primary" onClick={() => setModal(true)}>
                    <FolderOpen size={16} /> Open .codex folder
                  </button>
                  <button onClick={() => void loadDemo()}>Explore example</button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      {help && (
        <div className="shortcut-popover">
          <button
            className="icon-button"
            aria-label="Close shortcuts"
            onClick={() => setHelp(false)}
          >
            <X size={14} />
          </button>
          <strong>Timeline shortcuts</strong>
          <dl>
            <dt>W / S</dt>
            <dd>Zoom in / out</dd>
            <dt>A / D</dt>
            <dd>Pan left / right</dd>
            <dt>Ctrl + wheel</dt>
            <dd>Zoom at cursor</dd>
            <dt>Shift + drag</dt>
            <dd>Pan timeline</dd>
            <dt>Shift + click</dt>
            <dd>Add / remove selection</dd>
            <dt>M</dt>
            <dd>Measure selection</dd>
            <dt>&gt;</dt>
            <dd>Show / hide all links</dd>
            <dt>&lt;</dt>
            <dd>Show / hide links for selected spans</dd>
            <dt>[ / ]</dt>
            <dd>Follow previous / next link</dd>
            <dt>F</dt>
            <dd>Center and zoom to selection</dd>
          </dl>
        </div>
      )}
      {modal && (
        <OpenDialog
          onClose={() => setModal(false)}
          onOpen={() => void openDirectory()}
          onFiles={(files) => void scan(undefined, files)}
          onDemo={() => void loadDemo()}
          saved={!!saved}
          onReconnect={() => void reconnect()}
        />
      )}
    </div>
  );
}
