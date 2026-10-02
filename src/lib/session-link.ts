export interface SessionLink {
  sessionId: string;
  turnId?: string;
}
const uuid = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
const route = new RegExp(`^/session/(${uuid})(?:/turn/([A-Za-z0-9_-]{1,128}))?/?$`);

export function readSessionLink(path: string): SessionLink | undefined {
  if (!path.startsWith('/session/')) return undefined;
  const match = route.exec(path);
  if (!match)
    throw new Error(
      'Invalid session link. Use /session/<session ID> or /session/<session ID>/turn/<turn ID>.',
    );
  return { sessionId: match[1], turnId: match[2] };
}

export function sessionPath(sessionId: string, turnId?: string): string {
  const path = `/session/${sessionId}${turnId ? `/turn/${turnId}` : ''}`;
  readSessionLink(path);
  return path;
}
