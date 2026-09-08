import { useEffect, useRef, useState } from 'react';
import { Copy, X } from 'lucide-react';
import type { ParsedSession, SessionEntry } from '../types';
import { PARSER_VERSION } from '../lib/parser-pool';

export function SessionInfo({
  sessions,
  entries,
  rootId,
  onClose,
}: {
  sessions: ParsedSession[];
  entries: SessionEntry[];
  rootId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sessionId, setSessionId] = useState(rootId);
  const [copyStatus, setCopyStatus] = useState('');
  const session = sessions.find((s) => s.metadata.id === sessionId) ?? sessions[0];
  const metadata = session.metadata;
  const entry = entries.find((e) => e.id === metadata.id);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="open-dialog session-info"
      aria-labelledby="session-info-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <button
        className="dialog-close icon-button"
        aria-label="Close session info"
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <h1 id="session-info-title">Session info</h1>
      <label className="session-info-picker">
        Session
        <select
          value={metadata.id}
          onChange={(event) => {
            setSessionId(event.target.value);
            setCopyStatus('');
          }}
        >
          {sessions.map((s) => (
            <option key={s.metadata.id} value={s.metadata.id}>
              {s.metadata.id === rootId
                ? 'Main session'
                : s.metadata.agentName || s.metadata.agentPath || 'Agent'}{' '}
              · {s.metadata.id}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="session-info-id">Session ID</label>
      <div className="session-info-identity">
        <input
          id="session-info-id"
          readOnly
          value={metadata.id}
          onFocus={(event) => event.target.select()}
        />
        <button
          aria-label="Copy session ID"
          onClick={() => {
            void navigator.clipboard.writeText(metadata.id).then(
              () => setCopyStatus('Session ID copied'),
              () => setCopyStatus('Select the session ID and copy it manually'),
            );
          }}
        >
          <Copy size={14} />
        </button>
      </div>
      <div role="status" className="session-info-copy-status">
        {copyStatus}
      </div>
      <dl className="session-info-fields">
        <dt>Model</dt>
        <dd>{metadata.model}</dd>
        <dt>Parser</dt>
        <dd>{PARSER_VERSION}</dd>
        <dt>Source</dt>
        <dd>{entry?.path || 'Example trace'}</dd>
        {entry && (
          <>
            <dt>Storage</dt>
            <dd>
              {entry.archived ? 'Archived' : 'Active'} · {entry.size.toLocaleString()} bytes
            </dd>
          </>
        )}
        {metadata.parentId && (
          <>
            <dt>Parent ID</dt>
            <dd>{metadata.parentId}</dd>
          </>
        )}
        <dt>Started</dt>
        <dd>{new Date(metadata.startTime).toISOString()}</dd>
        <dt>Last record</dt>
        <dd>{new Date(metadata.endTime).toISOString()}</dd>
        <dt>Contents</dt>
        <dd>
          {session.turns.length} turns · {session.spans.length.toLocaleString()} spans ·{' '}
          {metadata.recordCount.toLocaleString()} records
        </dd>
        <dt>Malformed records</dt>
        <dd>{metadata.malformedLines}</dd>
        <dt>Skipped large records</dt>
        <dd>{metadata.oversizedLines ?? 0}</dd>
        <dt>Shortened strings</dt>
        <dd>{metadata.elidedStrings ?? 0}</dd>
      </dl>
      <h2>Parser diagnostics</h2>
      {session.warnings.length ? (
        <ul>
          {session.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p>No parser warnings.</p>
      )}
    </dialog>
  );
}
