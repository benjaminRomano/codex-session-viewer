import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedSession, SessionMetadata } from '../src/types';
import { mapConcurrent, SessionStore, type SessionGraph } from '../src/lib/session-store';
import { PARSER_VERSION, type ParseOptions, type ParserService } from '../src/lib/parser-pool';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function metadata(id: string, children: string[] = [], parentId?: string): SessionMetadata {
  return {
    id,
    title: `Title ${id}`,
    model: 'test-model',
    cwd: '/test',
    startTime: 10,
    endTime: 30,
    turnCount: 1,
    childIds: children,
    parentId,
    recordCount: 3,
    malformedLines: 0,
  };
}
function rollout(meta: SessionMetadata, modified = 123): File {
  return new File([JSON.stringify(meta)], `.codex/sessions/${meta.id}.jsonl`, {
    lastModified: modified,
  });
}
class TestParser implements ParserService {
  scans = 0;
  parsed: string[] = [];
  active = 0;
  peak = 0;
  latency = 2;
  delays: Record<string, number> = {};
  async scanMetadata(file: File): Promise<SessionMetadata> {
    this.scans++;
    return JSON.parse(await file.text()) as SessionMetadata;
  }
  async parseSession(file: File, options: ParseOptions = {}): Promise<ParsedSession> {
    this.active++;
    this.peak = Math.max(this.active, this.peak);
    try {
      const meta = JSON.parse(await file.text()) as SessionMetadata;
      await delay(this.delays[meta.id] ?? this.latency);
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.parsed.push(meta.id);
      return { metadata: meta, turns: [], spans: [], agentOperations: [], warnings: [] };
    } finally {
      this.active--;
    }
  }
}
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  });
  vi.stubGlobal('indexedDB', undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('metadata loading', () => {
  it('retries a native rollout with a fresh snapshot when Codex appends during reading', async () => {
    const old = rollout(metadata('a'), 1);
    const fresh = rollout({ ...metadata('a'), turnCount: 2 }, 2);
    let reads = 0;
    const scoped = {
      async *values() {
        yield { kind: 'file', name: 'a.jsonl', getFile: async () => (++reads === 1 ? old : fresh) };
      },
    };
    const handle = {
      isSameEntry: async () => false,
      getDirectoryHandle: async (name: string) => {
        if (name === 'sessions') return scoped;
        throw new DOMException('Missing', 'NotFoundError');
      },
      getFileHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;
    const parser = new TestParser();
    const scan = parser.scanMetadata.bind(parser);
    parser.scanMetadata = async (file) => {
      if (file.lastModified === 1) throw new DOMException('File changed', 'NotReadableError');
      return scan(file);
    };
    const result = await new SessionStore(parser).openDirectory(handle);
    expect(result.errors).toEqual([]);
    expect(result.sessions[0].turnCount).toBe(2);
    expect(result.sessions[0].modified).toBe(2);
    expect(reads).toBe(2);
  });

  it('rejects a parsed identity that conflicts with a standard rollout filename', async () => {
    const store = new SessionStore(new TestParser());
    const result = await store.openFiles([
      new File(
        [JSON.stringify(metadata('other'))],
        '.codex/sessions/rollout-2026-09-07T14-00-00-00000000-0000-4000-8000-000000000001.jsonl',
      ),
    ]);
    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('identity differs');
  });

  it('opens only the two rollout directories and session index through native handles', async () => {
    const calls: string[] = [];
    let file = rollout(metadata('a'));
    const fileHandle = { kind: 'file', name: 'a.jsonl', getFile: async () => file };
    const sessionsHandle = {
      kind: 'directory',
      name: 'sessions',
      async *values() {
        yield fileHandle;
      },
    };
    const handle = {
      kind: 'directory',
      name: '.codex',
      isSameEntry: async () => false,
      getDirectoryHandle: async (name: string) => {
        calls.push(`directory:${name}`);
        if (name === 'sessions') return sessionsHandle;
        throw new DOMException('Missing', 'NotFoundError');
      },
      getFileHandle: async (name: string) => {
        calls.push(`file:${name}`);
        throw new DOMException('Missing', 'NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;
    const parser = new TestParser();
    const store = new SessionStore(parser);
    const result = await store.openDirectory(handle);
    expect(calls).toEqual([
      'directory:sessions',
      'directory:archived_sessions',
      'file:session_index.jsonl',
    ]);
    expect(result.sessions[0].id).toBe('a');
    expect((await store.scan()).cacheHits).toBe(1);
    expect(parser.scans).toBe(1);
    file = rollout({ ...metadata('a'), turnCount: 2 }, 456);
    const changed = await store.scan();
    expect(changed.cacheHits).toBe(0);
    expect(changed.sessions[0].turnCount).toBe(2);
    expect(parser.scans).toBe(2);
  });

  it('reuses uploaded metadata only while refreshing the same selection', async () => {
    const parser = new TestParser();
    const store = new SessionStore(parser);
    const files = [rollout(metadata('a')), rollout(metadata('b'))];
    await store.openFiles(files);
    expect(parser.scans).toBe(2);
    const warm = await store.scan();
    expect(warm.cacheHits).toBe(2);
    expect(parser.scans).toBe(2);
    const reselected = await store.openFiles(files);
    expect(reselected.cacheHits).toBe(0);
    expect(parser.scans).toBe(4);
    expect(storage.has('codex-session-viewer:metadata')).toBe(false);
  });

  it('does not share metadata between same-named uploaded directories with identical file stats', async () => {
    const parser = new TestParser();
    const store = new SessionStore(parser);
    const first = new File([JSON.stringify(metadata('a'))], '.codex/sessions/shared.jsonl', {
      lastModified: 123,
    });
    const second = new File([JSON.stringify(metadata('b'))], first.name, {
      lastModified: first.lastModified,
    });
    expect(first.size).toBe(second.size);
    await store.openFiles([first]);
    const changed = await store.openFiles([second]);
    expect(changed.cacheHits).toBe(0);
    expect(changed.sessions[0].id).toBe('b');
    expect(changed.sessions[0].title).toBe('Title b');
    const reopened = await new SessionStore(parser).openFiles([first]);
    expect(reopened.cacheHits).toBe(0);
    expect(reopened.sessions[0].id).toBe('a');
    expect(parser.scans).toBe(3);
  });

  it('persists native metadata without saving current or legacy upload cache entries', async () => {
    const key = 'codex-session-viewer:metadata';
    storage.set(
      key,
      JSON.stringify({
        version: PARSER_VERSION,
        folders: {
          'upload:.codex': {
            touched: 1,
            entries: {
              'sessions/a.jsonl': {
                size: rollout(metadata('a')).size,
                modified: 123,
                metadata: metadata('a'),
                touched: 1,
              },
            },
          },
        },
      }),
    );
    const parser = new TestParser();
    const store = new SessionStore(parser);
    expect((await store.openFiles([rollout(metadata('a'))])).cacheHits).toBe(0);
    const scoped = {
      async *values() {
        yield {
          kind: 'file',
          name: 'native.jsonl',
          getFile: async () => rollout(metadata('native')),
        };
      },
    };
    const handle = {
      isSameEntry: async () => false,
      getDirectoryHandle: async (name: string) => {
        if (name === 'sessions') return scoped;
        throw new DOMException('Missing', 'NotFoundError');
      },
      getFileHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;
    await store.openDirectory(handle);
    const saved = JSON.parse(storage.get(key)!) as {
      folders: Record<string, { entries: Record<string, unknown> }>;
    };
    expect(Object.keys(saved.folders)).toHaveLength(1);
    expect(Object.keys(saved.folders)[0]).not.toContain('upload:');
    expect(Object.keys(Object.values(saved.folders)[0].entries)).toEqual(['sessions/native.jsonl']);
    expect((await store.scan()).cacheHits).toBe(1);
  });

  it('only reads rollout scopes and keeps index titles on warm selection refreshes', async () => {
    const parser = new TestParser();
    const files = [
      rollout(metadata('a')),
      new File(['private'], '.codex/auth.json'),
      new File(['ignored'], '.codex/other/private.jsonl'),
      new File(
        ['{"id":"a","thread_name":"Renamed"}\n{"id":"a","thread_name":"Latest"}'],
        '.codex/session_index.jsonl',
      ),
    ];
    const store = new SessionStore(parser);
    const first = await store.openFiles(files);
    expect(first.fileCount).toBe(1);
    expect(first.sessions[0].title).toBe('Latest');
    const warm = await store.scan();
    expect(warm.cacheHits).toBe(1);
    expect(warm.sessions[0].title).toBe('Latest');
    const reselected = await store.openFiles([
      rollout(metadata('a')),
      new File(['{"id":"a","thread_name":"New name"}'], '.codex/session_index.jsonl'),
    ]);
    expect(reselected.sessions[0].title).toBe('New name');
  });

  it('keeps loading when storage is corrupt or quota is unavailable', async () => {
    storage.set(
      'codex-session-viewer:metadata',
      JSON.stringify({ version: PARSER_VERSION, folders: { broken: null } }),
    );
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key),
      setItem: () => {
        throw new DOMException('Quota', 'QuotaExceededError');
      },
    });
    const result = await new SessionStore(new TestParser()).openFiles([rollout(metadata('a'))]);
    expect(result.sessions).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('reports malformed files without hiding valid sessions', async () => {
    const progress: number[] = [];
    const result = await new SessionStore(new TestParser()).openFiles(
      [rollout(metadata('a')), new File(['broken'], '.codex/archived_sessions/broken.jsonl')],
      { onProgress: (value) => progress.push(value.completed) },
    );
    expect(result.sessions.map((session) => session.id)).toEqual(['a']);
    expect(result.errors).toHaveLength(1);
    expect(progress.at(-1)).toBe(2);
  });
});

describe('agent graph loading', () => {
  it('retries a changed native snapshot once while loading the selected graph', async () => {
    const original = rollout(metadata('root'), 1);
    const fresh = rollout({ ...metadata('root'), turnCount: 2 }, 2);
    let reads = 0;
    const scoped = {
      async *values() {
        yield {
          kind: 'file',
          name: 'root.jsonl',
          getFile: async () => (++reads <= 2 ? original : fresh),
        };
      },
    };
    const handle = {
      isSameEntry: async () => false,
      getDirectoryHandle: async (name: string) => {
        if (name === 'sessions') return scoped;
        throw new DOMException('Missing', 'NotFoundError');
      },
      getFileHandle: async () => {
        throw new DOMException('Missing', 'NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;
    const parser = new TestParser();
    const parse = parser.parseSession.bind(parser);
    let attempts = 0;
    parser.parseSession = async (file, options) => {
      attempts++;
      if (file.lastModified === 1) throw new DOMException('Snapshot changed', 'NotReadableError');
      return parse(file, options);
    };
    const store = new SessionStore(parser);
    await store.openDirectory(handle);
    const graph = await store.loadGraph('root');
    expect(graph.errors).toEqual({});
    expect(graph.sessions.get('root')?.metadata.turnCount).toBe(2);
    expect(attempts).toBe(2);
    expect(reads).toBe(3);
    parser.parseSession = async () => {
      attempts++;
      throw new DOMException('Still unavailable', 'NotReadableError');
    };
    const failed = await store.loadGraph('root');
    expect(failed.errors.root).toBe('Still unavailable');
    expect(attempts).toBe(4); // one retry, never a loop
  });

  it('reports an unreadable upload snapshot without retrying the same immutable File', async () => {
    const parser = new TestParser();
    const parse = vi.fn(async () => {
      throw new DOMException('Snapshot changed', 'NotReadableError');
    });
    parser.parseSession = parse;
    const store = new SessionStore(parser);
    await store.openFiles([rollout(metadata('root'))]);
    const graph = await store.loadGraph('root');
    expect(graph.sessions.size).toBe(0);
    expect(graph.errors.root).toBe('Snapshot changed');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('fills only missing child descriptions from the matching parent dispatch', async () => {
    const parser = new TestParser();
    const parse = parser.parseSession.bind(parser);
    parser.parseSession = async (file, options) => {
      const session = await parse(file, options);
      if (session.metadata.id === 'root')
        session.agentOperations = [
          {
            spanId: 'spawn-one',
            kind: 'spawn',
            targetIds: ['child'],
            timestamp: 10,
            description: 'Build the Rust parser',
          },
          {
            spanId: 'spawn-two',
            kind: 'spawn',
            targetIds: ['/root/review'],
            timestamp: 10,
            description: 'Verify the parser',
          },
          {
            spanId: 'spawn-three',
            kind: 'spawn',
            targetIds: ['described'],
            timestamp: 10,
            description: 'Dispatch fallback',
          },
          {
            spanId: 'message',
            kind: 'send',
            targetIds: ['unmatched'],
            timestamp: 11,
            description: 'An unrelated message',
          },
        ];
      return session;
    };
    const store = new SessionStore(parser);
    await store.openFiles([
      rollout(metadata('root', ['child', 'review', 'described', 'unmatched'])),
      rollout({ ...metadata('child', [], 'root'), agentDescription: 'Untitled session' }),
      rollout({ ...metadata('review', [], 'root'), agentPath: '/root/review' }),
      rollout({
        ...metadata('described', [], 'root'),
        agentDescription: 'The child’s own description',
      }),
      rollout(metadata('unmatched', [], 'root')),
    ]);
    await store.loadGraph('root', { mode: 'lazy' });
    const graph = await store.loadChildren('root');
    expect(graph.sessions.get('child')?.metadata.agentDescription).toBe('Build the Rust parser');
    expect(graph.sessions.get('review')?.metadata.agentDescription).toBe('Verify the parser');
    expect(graph.sessions.get('described')?.metadata.agentDescription).toBe(
      'The child’s own description',
    );
    expect(graph.sessions.get('unmatched')?.metadata.agentDescription).toBeUndefined();
  });

  it('does not mistake an unresolved spawn task name for a missing session file', async () => {
    const parser = new TestParser();
    const originalParse = parser.parseSession.bind(parser);
    parser.parseSession = async (file, options) => {
      const result = await originalParse(file, options);
      if (result.metadata.id === 'root')
        result.agentOperations = [
          {
            spanId: 'spawn',
            kind: 'spawn',
            targetIds: ['parser', '/root/parser', 'child', '00000000-0000-4000-8000-000000000009'],
            timestamp: 10,
          },
        ];
      return result;
    };
    const store = new SessionStore(parser);
    await store.openFiles([rollout(metadata('root')), rollout(metadata('child', [], 'root'))]);
    const graph = await store.loadGraph('root');
    expect(graph.sessions.size).toBe(2);
    expect(graph.missing).toEqual(['00000000-0000-4000-8000-000000000009']);
    expect(graph.discovered).toBe(3);
  });

  it('starts newly discovered descendants while a slower sibling is still loading', async () => {
    const parser = new TestParser();
    parser.delays.slow = 40;
    const store = new SessionStore(parser);
    await store.openFiles([
      rollout(metadata('root', ['slow', 'fast'])),
      rollout(metadata('slow')),
      rollout(metadata('fast', ['grandchild'])),
      rollout(metadata('grandchild')),
    ]);
    await store.loadGraph('root', { concurrency: 2 });
    expect(parser.parsed.indexOf('grandchild')).toBeLessThan(parser.parsed.indexOf('slow'));
    expect(parser.peak).toBe(2);
  });

  it('deduplicates diamonds and cycles, joins parent lineage, and reports missing agents', async () => {
    const parser = new TestParser();
    const store = new SessionStore(parser);
    await store.openFiles([
      rollout(metadata('root', ['a', 'b', 'missing'])),
      rollout(metadata('a', ['shared'])),
      rollout(metadata('b', ['shared'])),
      rollout(metadata('shared', ['root'])),
      rollout(metadata('lineage-only', [], 'root')),
    ]);
    const snapshots: SessionGraph[] = [];
    const graph = await store.loadGraph('root', {
      mode: 'eager',
      concurrency: 2,
      onProgress: (value) => snapshots.push(value),
    });
    expect([...graph.sessions.keys()].sort()).toEqual(['a', 'b', 'lineage-only', 'root', 'shared']);
    expect(parser.parsed.filter((id) => id === 'shared')).toHaveLength(1);
    expect(graph.missing).toEqual(['missing']);
    expect(graph.discovered).toBe(6);
    expect(graph.complete).toBe(true);
    expect(parser.peak).toBeLessThanOrEqual(2);
    expect(parser.peak).toBeGreaterThan(1);
    expect(
      snapshots.some((snapshot) => snapshot.sessions.size === 1 && snapshot.discovered > 1),
    ).toBe(true);
    expect(snapshots[0].sessions.size).toBe(0); // snapshots do not mutate after notification
  });

  it('loads a root lazily, then expands selected children without re-parsing the root', async () => {
    const parser = new TestParser();
    const store = new SessionStore(parser);
    await store.openFiles([
      rollout(metadata('root', ['a', 'b'])),
      rollout(metadata('a')),
      rollout(metadata('b')),
    ]);
    const root = await store.loadGraph('root', { mode: 'lazy' });
    expect([...root.sessions.keys()]).toEqual(['root']);
    expect(root.discovered).toBe(3);
    expect(root.complete).toBe(false);
    const one = await store.loadChildren('a', { mode: 'lazy' });
    expect(one.complete).toBe(false);
    expect(one.discovered).toBe(3);
    const all = await store.loadChildren('root');
    expect(all.sessions.size).toBe(3);
    expect(all.complete).toBe(true);
    expect(parser.parsed.filter((id) => id === 'root')).toHaveLength(1);
  });

  it('cancels old selection work without stale results changing the new graph', async () => {
    const parser = new TestParser();
    parser.latency = 10;
    const store = new SessionStore(parser);
    await store.openFiles([
      rollout(metadata('a', ['child'])),
      rollout(metadata('child')),
      rollout(metadata('b')),
    ]);
    const old = store.loadGraph('a').catch((error) => error as Error);
    await delay(1);
    const current = await store.loadGraph('b');
    expect(((await old) as Error).name).toBe('AbortError');
    expect([...current.sessions.keys()]).toEqual(['b']);
    expect(current.loading).toBe(0);
    expect(parser.parsed).not.toContain('child');
  });
});

describe('selected details', () => {
  it('passes exact source references to the worker and preserves the full selected prompt', async () => {
    const parser: TestParser & ParserService = new TestParser();
    const prompt = 'selected prompt '.repeat(10_000);
    const loadDetails = vi.fn<NonNullable<ParserService['loadDetails']>>(async () => ({
      prompt,
      hasMore: false,
      warnings: [],
    }));
    parser.loadDetails = loadDetails;
    const store = new SessionStore(parser);
    await store.openFiles([rollout(metadata('root'))]);
    const selector = { sourceLine: 15, offset: 0, pageSize: 1024 * 1024 };
    const result = await store.loadDetails('root', selector);
    expect(result.prompt).toBe(prompt);
    expect(result.prompt!.length).toBeGreaterThan(65_536);
    expect(loadDetails.mock.calls[0][1]).toEqual(selector);
  });

  it('cancels outdated detail selections before exposing their results', async () => {
    const parser: TestParser & ParserService = new TestParser();
    parser.loadDetails = async (_file, selector) => {
      await delay(5);
      return { code: String(selector.sourceLine), hasMore: false, warnings: [] };
    };
    const store = new SessionStore(parser);
    await store.openFiles([rollout(metadata('root'))]);
    const old = store.loadDetails('root', { sourceLine: 1 }).catch((error) => error as Error);
    const selected = await store.loadDetails('root', { sourceLine: 2 });
    expect(((await old) as Error).name).toBe('AbortError');
    expect(selected.code).toBe('2');
  });
});

it('bounded mapping stops admitting queued work after cancellation', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const task = mapConcurrent(
    [0, 1, 2, 3, 4, 5],
    2,
    async (value) => {
      started.push(value);
      if (value === 0) controller.abort();
      await delay(1);
    },
    controller.signal,
  );
  await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  expect(started).toEqual([0]);
});
