import { expect, test } from 'vitest';
import { readSessionLink, sessionPath } from '../src/lib/session-link';
const id = '00000000-0000-4000-8000-000000000001';
test('session and turn links round trip without file paths or extra data', () => {
  expect(readSessionLink(sessionPath(id))).toEqual({ sessionId: id, turnId: undefined });
  expect(readSessionLink(sessionPath(id, 'turn-1'))).toEqual({ sessionId: id, turnId: 'turn-1' });
  expect(readSessionLink('/')).toBeUndefined();
});
test.each([
  '/session/not-an-id',
  `/session/${id}/turn/../auth.json`,
  `/session/${id}/turn/`,
  `/session/${id}/extra`,
])('rejects malformed deep route %s', (path) => {
  expect(() => readSessionLink(path)).toThrow('Invalid session link');
});
