import type { ParsedSession, SessionEntry, SessionMetadata } from '../types';
import {
  abortError,
  PARSER_VERSION,
  ParserPool,
  type DetailSelector,
  type ParseOptions,
  type ParserService,
  type SessionDetail,
} from './parser-pool';

export interface SessionIndex {
  sessions: SessionEntry[];
  source: 'directory' | 'files';
  cacheHits: number;
  fileCount: number;
  errors: string[];
}
export interface ScanProgress {
  phase: 'discovering' | 'scanning' | 'complete';
  completed: number;
  total: number;
  cacheHits: number;
  bytesProcessed: number;
  totalBytes: number;
  sessions: SessionEntry[];
  errors: string[];
}
export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  concurrency?: number;
}
export interface SessionGraph {
  rootId: string;
  sessions: Map<string, ParsedSession>;
  missing: string[];
  errors: Record<string, string>;
  loading: number;
  discovered: number;
  complete: boolean;
}
export interface GraphOptions {
  mode?: 'lazy' | 'eager';
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (graph: SessionGraph) => void;
}
interface FileRef {
  path: string;
  getFile(): Promise<File>;
  file?: File;
}
interface CacheEntry {
  size: number;
  modified: number;
  metadata: SessionMetadata;
  touched: number;
}
interface CacheFolder {
  entries: Record<string, CacheEntry>;
  touched: number;
}
interface CacheData {
  version: string;
  folders: Record<string, CacheFolder>;
}
interface SavedDirectory {
  id: string;
  handle: FileSystemDirectoryHandle;
}
type Directory = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};
const CACHE_KEY = 'codex-session-viewer:metadata';
const DATABASE = 'codex-session-viewer';
const MAX_CACHE_CHARS = 1024 * 1024; // About 2 MiB in localStorage's UTF-16 representation.

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sorted(entries: Iterable<SessionEntry>): SessionEntry[] {
  return [...entries].sort(
    (a, b) => b.endTime - a.endTime || b.startTime - a.startTime || a.id.localeCompare(b.id),
  );
}
function metadataValid(value: unknown): value is SessionMetadata {
  if (!value || typeof value !== 'object') return false;
  const x = value as SessionMetadata;
  return (
    typeof x.id === 'string' &&
    !!x.id &&
    typeof x.title === 'string' &&
    typeof x.model === 'string' &&
    typeof x.cwd === 'string' &&
    Number.isFinite(x.startTime) &&
    Number.isFinite(x.endTime) &&
    Number.isFinite(x.turnCount) &&
    Number.isFinite(x.recordCount) &&
    Number.isFinite(x.malformedLines) &&
    Array.isArray(x.childIds) &&
    x.childIds.every((id) => typeof id === 'string')
  );
}
function matchesRolloutIdentity(metadata: SessionMetadata, path: string): boolean {
  const expected = path.match(
    /(?:^|\/)rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  )?.[1];
  return !expected || metadata.id.toLowerCase() === expected.toLowerCase();
}

/** Runs at most `concurrency` jobs at a time; cancellation stops admission of new work. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
      while (cursor < values.length) {
        check(signal);
        const index = cursor++;
        output[index] = await work(values[index], index);
      }
    }),
  );
  check(signal);
  return output;
}

/** Newly discovered descendants can start as soon as any worker becomes available. */
async function drainConcurrent<T>(
  queue: T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error(message(error)));
    };
    const onAbort = () => fail(abortError());
    const pump = () => {
      if (settled) return;
      if (signal.aborted) {
        fail(abortError());
        return;
      }
      while (active < Math.max(1, concurrency) && queue.length) {
        const value = queue.shift()!;
        active++;
        void work(value).then(() => {
          active--;
          pump();
        }, fail);
      }
      if (!active && !queue.length) {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pump();
  });
}

export class SessionStore {
  private directory?: FileSystemDirectoryHandle;
  private folderId = '';
  private refs = new Map<string, FileRef>();
  private entries = new Map<string, SessionEntry>();
  private titles = new Map<string, string>();
  private source: SessionIndex['source'] = 'files';
  private cache: CacheData = { version: PARSER_VERSION, folders: {} };
  private uploadCache?: CacheFolder;
  private graph?: SessionGraph;
  private graphAbort?: AbortController;
  private scanAbort?: AbortController;
  private detailAbort?: AbortController;

  constructor(private readonly parser: ParserService = new ParserPool()) {
    try {
      const raw = globalThis.localStorage?.getItem(CACHE_KEY);
      const cached = raw && (JSON.parse(raw) as CacheData);
      if (
        cached &&
        cached.version === PARSER_VERSION &&
        cached.folders &&
        typeof cached.folders === 'object'
      ) {
        this.cache.folders = Object.fromEntries(
          Object.entries(cached.folders).filter(
            ([id, folder]) =>
              !id.startsWith('upload:') &&
              folder &&
              typeof folder === 'object' &&
              folder.entries &&
              typeof folder.entries === 'object' &&
              Number.isFinite(folder.touched),
          ),
        );
      }
    } catch {
      /* Storage may be blocked, unavailable, corrupt, or full. Loading still works. */
    }
  }

  get sessions(): SessionEntry[] {
    return sorted(this.entries.values());
  }

  /** Restore the handle without prompting. Call requestDirectoryPermission from a user click. */
  async restoreDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
    return (await this.readSavedDirectory())?.handle;
  }

  async hasDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    return (await (handle as Directory).queryPermission({ mode: 'read' })) === 'granted';
  }

  async requestDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
    const directory = handle as Directory;
    return (
      (await directory.queryPermission({ mode: 'read' })) === 'granted' ||
      (await directory.requestPermission({ mode: 'read' })) === 'granted'
    );
  }

  async openDirectory(
    handle: FileSystemDirectoryHandle,
    options: ScanOptions = {},
  ): Promise<SessionIndex> {
    check(options.signal);
    this.cancel();
    this.directory = handle;
    this.source = 'directory';
    this.uploadCache = undefined;
    this.refs.clear();
    this.entries.clear();
    this.titles.clear();
    const saved = await this.readSavedDirectory();
    let same = false;
    try {
      same = !!saved && (await handle.isSameEntry(saved.handle));
    } catch {
      /* stale handle */
    }
    this.folderId = same && saved ? saved.id : crypto.randomUUID();
    await this.saveDirectory({ id: this.folderId, handle });
    return this.scan(options);
  }

  async openFiles(
    files: Iterable<File> | ArrayLike<File>,
    options: ScanOptions = {},
  ): Promise<SessionIndex> {
    check(options.signal);
    this.cancel();
    this.directory = undefined;
    this.source = 'files';
    this.folderId = `upload:${crypto.randomUUID()}`;
    this.uploadCache = { entries: {}, touched: Date.now() };
    this.refs.clear();
    this.entries.clear();
    this.titles.clear();
    let indexFile: File | undefined;
    for (const file of Array.from(files as ArrayLike<File>)) {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split('/');
      if (!['sessions', 'archived_sessions', 'session_index.jsonl'].includes(parts[0])) {
        parts.shift();
      }
      const path = parts.join('/');
      if (path === 'session_index.jsonl') indexFile = file;
      if (
        (path.startsWith('sessions/') || path.startsWith('archived_sessions/')) &&
        path.endsWith('.jsonl')
      ) {
        this.refs.set(path, { path, file, getFile: () => Promise.resolve(file) });
      }
    }
    if (!this.refs.size && !indexFile)
      throw new Error('Select the .codex directory containing sessions or archived_sessions.');
    // FileList exposes no directory identity. Keep metadata only for this immutable
    // selection's refreshes; another upload can have identical paths and file stats.
    if (indexFile) await this.readTitles(indexFile);
    return this.scan(options);
  }

  async scan(options: ScanOptions = {}): Promise<SessionIndex> {
    this.scanAbort?.abort();
    const controller = new AbortController();
    this.scanAbort = controller;
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const signal = controller.signal;
    const errors: string[] = [];
    let completed = 0,
      cacheHits = 0,
      bytesProcessed = 0,
      totalBytes = 0,
      lastProgress = 0;
    const emit = (phase: ScanProgress['phase']) =>
      options.onProgress?.({
        phase,
        completed,
        total: this.refs.size,
        cacheHits,
        bytesProcessed,
        totalBytes,
        sessions: this.sessions,
        errors: [...errors],
      });
    try {
      if (this.directory) {
        this.refs.clear();
        this.titles.clear();
        emit('discovering');
        let found = false;
        for (const name of ['sessions', 'archived_sessions']) {
          check(signal);
          try {
            const scoped = await this.directory.getDirectoryHandle(name);
            found = true;
            await this.enumerate(scoped, name, signal);
          } catch (error) {
            if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
          }
        }
        try {
          const indexHandle = await this.directory.getFileHandle('session_index.jsonl');
          await this.readTitles(await indexHandle.getFile());
          found = true;
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'NotFoundError'))
            errors.push(`Session index: ${message(error)}`);
        }
        if (!found)
          throw new Error('Select the .codex directory containing sessions or archived_sessions.');
      }
      this.entries.clear();
      const folder = this.directory
        ? (this.cache.folders[this.folderId] ??= { entries: {}, touched: Date.now() })
        : (this.uploadCache ??= { entries: {}, touched: Date.now() });
      folder.touched = Date.now();
      const pending: Array<{ ref: FileRef; file: File }> = [];
      // getFile retrieves stat information and an immutable snapshot; contents are read only in workers.
      await mapConcurrent(
        [...this.refs.values()],
        8,
        async (ref) => {
          try {
            check(signal);
            const file = await ref.getFile();
            ref.file = file;
            totalBytes += file.size;
            const hit = folder.entries[ref.path];
            if (
              hit &&
              hit.size === file.size &&
              hit.modified === file.lastModified &&
              metadataValid(hit.metadata) &&
              matchesRolloutIdentity(hit.metadata, ref.path)
            ) {
              this.setEntry(hit.metadata, ref.path, file);
              hit.touched = Date.now();
              completed++;
              cacheHits++;
            } else pending.push({ ref, file });
          } catch (error) {
            if (isAbort(error)) throw error;
            errors.push(`${ref.path}: ${message(error)}`);
            completed++;
          }
        },
        signal,
      );
      for (const path of Object.keys(folder.entries))
        if (!this.refs.has(path)) delete folder.entries[path];
      emit('scanning');
      // Small files become selectable first, including while multi-gigabyte archives continue to scan.
      pending.sort((a, b) => a.file.size - b.file.size);
      await mapConcurrent(
        pending,
        options.concurrency ?? 4,
        async ({ ref, file: initialFile }) => {
          let file = initialFile;
          let reported = 0;
          try {
            const onBytes = (bytes: number) => {
              bytesProcessed += Math.max(0, bytes - reported);
              reported = bytes;
              if (!signal.aborted && Date.now() - lastProgress > 200) {
                lastProgress = Date.now();
                emit('scanning');
              }
            };
            let metadata: SessionMetadata;
            try {
              metadata = await this.parser.scanMetadata(file, { signal, onBytes });
            } catch (error) {
              if (isAbort(error) || !this.directory) throw error;
              // Codex can append between getFile() and the worker read. Obtain one fresh
              // native snapshot before reporting the file unavailable. Uploads require reselection.
              const fresh = await ref.getFile();
              check(signal);
              if (
                fresh.size === file.size &&
                fresh.lastModified === file.lastModified &&
                !/NotReadableError|NotFoundError|file.*(?:read|found)/i.test(message(error))
              )
                throw error;
              totalBytes += fresh.size - file.size;
              bytesProcessed -= reported;
              reported = 0;
              file = fresh;
              ref.file = fresh;
              metadata = await this.parser.scanMetadata(fresh, { signal, onBytes });
            }
            check(signal);
            if (!metadataValid(metadata))
              throw new Error('The rollout has no valid session metadata.');
            if (!matchesRolloutIdentity(metadata, ref.path))
              throw new Error('Parsed session identity differs from the rollout filename.');
            this.setEntry(metadata, ref.path, file);
            folder.entries[ref.path] = {
              size: file.size,
              modified: file.lastModified,
              metadata,
              touched: Date.now(),
            };
          } catch (error) {
            if (isAbort(error)) throw error;
            errors.push(`${ref.path}: ${message(error)}`);
          } finally {
            bytesProcessed += Math.max(0, file.size - reported);
            completed++;
            if (completed % 16 === 0) this.persistCache();
            if (!signal.aborted) emit('scanning');
          }
        },
        signal,
      );
      check(signal);
      emit('complete');
      return {
        sessions: this.sessions,
        source: this.source,
        cacheHits,
        fileCount: this.refs.size,
        errors,
      };
    } finally {
      options.signal?.removeEventListener('abort', externalAbort);
      this.persistCache();
      if (this.scanAbort === controller) this.scanAbort = undefined;
    }
  }

  async loadGraph(rootId: string, options: GraphOptions = {}): Promise<SessionGraph> {
    this.detailAbort?.abort();
    this.graphAbort?.abort();
    this.graph = {
      rootId,
      sessions: new Map(),
      missing: [],
      errors: {},
      loading: 0,
      discovered: 1,
      complete: false,
    };
    return this.expandGraph([rootId], options);
  }

  async loadChildren(sessionId: string, options: GraphOptions = {}): Promise<SessionGraph> {
    if (!this.graph) return this.loadGraph(sessionId, options);
    this.graphAbort?.abort();
    const session = this.graph.sessions.get(sessionId);
    const ids = session ? this.children(session) : [sessionId];
    return this.expandGraph(ids, options);
  }

  async loadDetails(
    sessionId: string,
    selector: DetailSelector,
    options: ParseOptions = {},
  ): Promise<SessionDetail> {
    this.detailAbort?.abort();
    if (!this.parser.loadDetails)
      throw new Error('Full selected details are unavailable in this parser.');
    const entry = this.entries.get(sessionId);
    const ref = entry && this.refs.get(entry.path);
    if (!ref) throw new Error('The selected session is not available in this directory.');
    const controller = new AbortController();
    this.detailAbort = controller;
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      check(controller.signal);
      let file = await ref.getFile();
      check(controller.signal);
      try {
        const detail = await this.parser.loadDetails(file, selector, {
          ...options,
          signal: controller.signal,
        });
        check(controller.signal);
        return detail;
      } catch (error) {
        if (isAbort(error) || !this.directory) throw error;
        const fresh = await ref.getFile();
        check(controller.signal);
        if (
          fresh.size === file.size &&
          fresh.lastModified === file.lastModified &&
          !/NotReadableError|NotFoundError|file.*(?:read|found)/i.test(message(error))
        )
          throw error;
        file = fresh;
        const detail = await this.parser.loadDetails(file, selector, {
          ...options,
          signal: controller.signal,
        });
        check(controller.signal);
        return detail;
      }
    } finally {
      options.signal?.removeEventListener('abort', externalAbort);
      if (this.detailAbort === controller) this.detailAbort = undefined;
    }
  }

  cancel(): void {
    this.scanAbort?.abort();
    this.graphAbort?.abort();
    this.detailAbort?.abort();
  }

  dispose(): void {
    this.cancel();
    this.parser.dispose?.();
  }

  private async expandGraph(initial: string[], options: GraphOptions): Promise<SessionGraph> {
    const graph = this.graph!;
    const controller = new AbortController();
    this.graphAbort = controller;
    const externalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const signal = controller.signal;
    const discovered = new Set([
      ...graph.sessions.keys(),
      ...graph.missing,
      ...initial,
      ...[...graph.sessions.values()].flatMap((session) => this.children(session)),
    ]);
    const visited = new Set([...graph.sessions.keys(), ...graph.missing]);
    const queued = new Set(initial);
    const queue = [...queued].filter((id) => !visited.has(id));
    const emit = () => {
      graph.discovered = discovered.size;
      if (!signal.aborted) options.onProgress?.(this.snapshot(graph));
    };
    graph.complete = false;
    graph.loading = 0;
    emit();
    try {
      await drainConcurrent(
        queue,
        options.concurrency ?? 4,
        async (id) => {
          if (visited.has(id)) return;
          visited.add(id);
          const entry = this.entries.get(id);
          const ref = entry && this.refs.get(entry.path);
          if (!entry || !ref) {
            if (!graph.missing.includes(id)) graph.missing.push(id);
            emit();
            return;
          }
          graph.loading++;
          emit();
          try {
            const file = await ref.getFile();
            check(signal);
            let parsed: ParsedSession;
            try {
              parsed = await this.parser.parseSession(file, { signal });
            } catch (error) {
              const failure = `${error instanceof Error ? error.name : ''}: ${message(error)}`;
              if (
                isAbort(error) ||
                !this.directory ||
                !/NotReadableError|NotFoundError|file.*(?:read|found)|network error/i.test(failure)
              )
                throw error;
              check(signal);
              // An active rollout can change during streaming. Native handles can refresh
              // the snapshot once; uploaded File objects require another user selection.
              const fresh = await ref.getFile();
              check(signal);
              parsed = await this.parser.parseSession(fresh, { signal });
            }
            check(signal);
            if (parsed.metadata.id !== id)
              throw new Error('Session identity changed; refresh the session index.');
            if (this.titles.has(id)) parsed.metadata.title = this.titles.get(id)!;
            this.fillAgentDescription(parsed, graph);
            graph.sessions.set(id, parsed);
            delete graph.errors[id];
            for (const childId of this.children(parsed)) {
              discovered.add(childId);
              if (options.mode !== 'lazy' && !queued.has(childId) && !visited.has(childId)) {
                queued.add(childId);
                queue.push(childId);
              }
            }
          } catch (error) {
            if (isAbort(error)) throw error;
            graph.errors[id] = message(error);
          } finally {
            if (this.graphAbort === controller) {
              graph.loading--;
              emit();
            }
          }
        },
        signal,
      );
      graph.complete = [...discovered].every(
        (id) => graph.sessions.has(id) || graph.missing.includes(id) || id in graph.errors,
      );
      emit();
      return this.snapshot(graph);
    } finally {
      options.signal?.removeEventListener('abort', externalAbort);
      if (this.graphAbort === controller) this.graphAbort = undefined;
    }
  }

  private children(session: ParsedSession): string[] {
    const children = new Set(session.metadata.childIds);
    for (const operation of session.agentOperations) {
      if (operation.kind === 'spawn')
        for (const id of operation.targetIds) {
          // A spawn's task_name is a display alias until Codex returns a thread UUID.
          // Keep known fixture IDs and unresolved UUIDs, but do not invent missing files for aliases.
          if (
            this.entries.has(id) ||
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
          )
            children.add(id);
        }
    }
    // Some logs omit spawn outputs. Persisted child lineage provides an independent lookup.
    for (const entry of this.entries.values())
      if (entry.parentId === session.metadata.id) children.add(entry.id);
    children.delete(session.metadata.id);
    return [...children];
  }

  private fillAgentDescription(session: ParsedSession, graph: SessionGraph): void {
    const existing = session.metadata.agentDescription?.trim();
    if (existing && existing.toLowerCase() !== 'untitled session') return;
    const child = session.metadata;
    const parentId = child.parentId ?? this.entries.get(child.id)?.parentId;
    for (const parent of graph.sessions.values()) {
      if (parent.metadata.id === child.id || (parentId && parent.metadata.id !== parentId))
        continue;
      for (const operation of parent.agentOperations) {
        const description = operation.description?.trim();
        if (operation.kind !== 'spawn' || !description) continue;
        const matches = operation.targetIds.some((target) => {
          if (target === child.id) return true;
          if (child.agentPath) {
            const canonical = target.startsWith('/')
              ? target
              : `${parent.metadata.agentPath || '/root'}/${target}`;
            if (canonical === child.agentPath) return true;
          }
          // A short display name is safe only within its known parent and when unambiguous.
          if (parentId !== parent.metadata.id || target !== child.agentName) return false;
          return (
            [...this.entries.values()].filter(
              (entry) => entry.parentId === parentId && entry.agentName === target,
            ).length === 1
          );
        });
        if (matches) {
          session.metadata.agentDescription = description;
          return;
        }
      }
    }
  }

  private snapshot(graph: SessionGraph): SessionGraph {
    return {
      ...graph,
      sessions: new Map(graph.sessions),
      missing: [...graph.missing],
      errors: { ...graph.errors },
    };
  }

  private setEntry(metadata: SessionMetadata, path: string, file: File): void {
    const entry: SessionEntry = {
      ...metadata,
      title: this.titles.get(metadata.id) || metadata.title,
      path,
      size: file.size,
      modified: file.lastModified,
      archived: path.startsWith('archived_sessions/'),
    };
    const existing = this.entries.get(entry.id);
    // Prefer the active copy if a rollout exists in both places during archival.
    if (
      !existing ||
      (existing.archived && !entry.archived) ||
      (existing.archived === entry.archived && entry.modified > existing.modified)
    )
      this.entries.set(entry.id, entry);
  }

  private async enumerate(
    handle: FileSystemDirectoryHandle,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const child of (handle as Directory).values()) {
      check(signal);
      const childPath = `${path}/${child.name}`;
      if (child.kind === 'directory') await this.enumerate(child, childPath, signal);
      else if (child.name.endsWith('.jsonl')) {
        const fileHandle = child;
        this.refs.set(childPath, { path: childPath, getFile: () => fileHandle.getFile() });
      }
    }
  }

  private async readTitles(file: File): Promise<void> {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const consume = (line: string) => {
      try {
        const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof record.id === 'string' && typeof record.thread_name === 'string')
          this.titles.set(record.id, record.thread_name);
      } catch {
        /* A final partial row may be in flight while Codex appends. */
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
    } finally {
      reader.releaseLock();
    }
  }

  private persistCache(): void {
    if (!this.directory) return;
    try {
      const folders = Object.entries(this.cache.folders).sort(
        (a, b) => b[1].touched - a[1].touched,
      );
      this.cache.folders = Object.fromEntries(folders.slice(0, 3));
      const oldest = Object.values(this.cache.folders)
        .flatMap((folder) =>
          Object.entries(folder.entries).map(([path, entry]) => ({
            folder,
            path,
            touched: entry.touched,
          })),
        )
        .sort((a, b) => a.touched - b.touched);
      let encoded = JSON.stringify(this.cache);
      while (encoded.length > MAX_CACHE_CHARS && oldest.length) {
        const entry = oldest.shift()!;
        delete entry.folder.entries[entry.path];
        encoded = JSON.stringify(this.cache);
      }
      // Quota is shared with other apps on this origin. Evict only this viewer's entries.
      while (true) {
        try {
          globalThis.localStorage?.setItem(CACHE_KEY, encoded);
          break;
        } catch {
          if (!oldest.length) break;
          for (let i = 0, count = Math.max(1, Math.ceil(oldest.length / 2)); i < count; i++) {
            const entry = oldest.shift()!;
            delete entry.folder.entries[entry.path];
          }
          encoded = JSON.stringify(this.cache);
        }
      }
    } catch {
      /* Private browsing and denied storage do not prevent local loading. */
    }
  }

  private async database(): Promise<IDBDatabase | undefined> {
    if (!globalThis.indexedDB) return undefined;
    return new Promise((resolve) => {
      try {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('permissions');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  private async readSavedDirectory(): Promise<SavedDirectory | undefined> {
    const database = await this.database();
    if (!database) return undefined;
    return new Promise((resolve) => {
      const transaction = database.transaction('permissions', 'readonly');
      const request = transaction.objectStore('permissions').get('directory');
      request.onsuccess = () => resolve(request.result as SavedDirectory | undefined);
      request.onerror = () => resolve(undefined);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => database.close();
    });
  }

  private async saveDirectory(value: SavedDirectory): Promise<void> {
    const database = await this.database();
    if (!database) return;
    await new Promise<void>((resolve) => {
      try {
        const transaction = database.transaction('permissions', 'readwrite');
        transaction.objectStore('permissions').put(value, 'directory');
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          resolve();
        };
        transaction.onabort = () => {
          database.close();
          resolve();
        };
      } catch {
        database.close();
        resolve();
      }
    });
  }
}
