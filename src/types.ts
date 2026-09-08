export const TRACKS = [
  'turns',
  'messages',
  'inference',
  'shell',
  'files',
  'skills',
  'code',
  'agent_dispatch',
  'agent_wait',
  'agent_messages',
  'tools',
  'web',
  'approval',
  'context',
  'system',
] as const;
export type TrackKind = (typeof TRACKS)[number];
export const TRACK_LABELS: Record<TrackKind, string> = {
  turns: 'Agent turns',
  inference: 'Inference',
  shell: 'Shell / terminal',
  files: 'Files / patches',
  skills: 'Skill reads',
  code: 'Code mode',
  agent_dispatch: 'Agent dispatch',
  agent_wait: 'Agent wait',
  agent_messages: 'Agent communication',
  tools: 'Tools / MCP',
  web: 'Web / media',
  approval: 'Approvals / input',
  context: 'Context',
  messages: 'Messages',
  system: 'System',
};
export interface SessionMetadata {
  id: string;
  title: string;
  model: string;
  cwd: string;
  startTime: number;
  endTime: number;
  turnCount: number;
  childIds: string[];
  parentId?: string;
  agentName?: string;
  agentPath?: string;
  agentDescription?: string;
  recordCount: number;
  malformedLines: number;
  oversizedLines?: number;
  oversizedBytes?: number;
  elidedStrings?: number;
}
export interface SessionEntry extends SessionMetadata {
  path: string;
  size: number;
  modified: number;
  archived: boolean;
}
export interface Turn {
  id: string;
  index: number;
  title: string;
  startTime: number;
  endTime: number;
  model: string;
  status: string;
  prompt?: string;
  sourceLine?: number;
}
export interface Span {
  id: string;
  sessionId: string;
  turnId?: string;
  track: TrackKind;
  name: string;
  startTime: number;
  endTime: number;
  status: string;
  inferred: boolean;
  callId?: string;
  targetAgentId?: string;
  code?: string;
  output?: string;
  language?: string;
  args?: string;
  sourceLine?: number;
  outputLine?: number;
}
interface AgentOperation {
  spanId: string;
  kind: 'spawn' | 'send' | 'wait' | 'resume' | 'close';
  targetIds: string[];
  timestamp: number;
  description?: string;
}
export interface ParsedSession {
  metadata: SessionMetadata;
  turns: Turn[];
  spans: Span[];
  agentOperations: AgentOperation[];
  logEntries?: LogEntry[];
  warnings: string[];
}
export interface LogEntry {
  id: string;
  spanId: string;
  sessionId: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool' | 'agent' | 'system';
  title: string;
  timestamp: number;
  phase?: 'call' | 'result';
}
export interface Flow {
  id: string;
  sourceSpanId: string;
  targetSpanId: string;
  kind: string;
  inferred: boolean;
  sourceTime?: number;
  targetTime?: number;
}
export interface TimeRange {
  start: number;
  end: number;
}
