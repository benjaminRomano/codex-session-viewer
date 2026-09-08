import { expect, it } from 'vitest';
import { descendantCounts, topLevelSessions } from '../src/components/Sidebar';
import type { SessionEntry } from '../src/types';
const entry = (id: string, fields: Partial<SessionEntry> = {}): SessionEntry => ({
  id,
  title: id,
  model: 'gpt-6',
  cwd: '',
  startTime: 0,
  endTime: 1,
  turnCount: 1,
  childIds: [],
  recordCount: 1,
  malformedLines: 0,
  path: `${id}.jsonl`,
  size: 1,
  modified: 1,
  archived: false,
  ...fields,
});
it('lists only roots while preserving active and archived roots', () => {
  const sessions = [
    entry('root', { childIds: ['linked', 'root'], agentPath: '/root' }),
    entry('archive', { archived: true }),
    entry('child', { parentId: 'root' }),
    entry('linked'),
    entry('orphan', { agentPath: '/root/worker' }),
  ];
  expect(topLevelSessions(sessions).map((s) => s.id)).toEqual(['root', 'archive']);
});

it('counts the entire unique agent subtree across archives and cyclic duplicate links', () => {
  const sessions = [
    entry('root', { childIds: ['child', 'child', 'root'] }),
    entry('child', { parentId: 'root', childIds: ['grandchild'] }),
    entry('grandchild', { archived: true, childIds: ['root', 'missing'] }),
    entry('sibling', { parentId: 'root', childIds: ['grandchild'] }),
    entry('other'),
  ];
  const counts = descendantCounts(sessions);
  expect(counts.get('root')).toBe(4);
  expect(counts.get('other')).toBe(0);
});
