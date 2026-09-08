// Cross-runtime contract test: identical synthetic inputs in the native and WASM engines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  initSync,
  parse_session,
  scan_metadata,
  SessionParser,
  MetadataScanner,
  DetailParser,
  analyze_sessions,
  aggregate_spans,
} from '../src/wasm/session_parser.js';

initSync({ module: readFileSync(new URL('../src/wasm/session_parser_bg.wasm', import.meta.url)) });
// Invalid inputs must throw ordinary JS errors, not WebAssembly traps; the same
// native adapter must fail cleanly without attempting to call a JavaScript import.
for (const invoke of [
  () => new DetailParser('{'),
  () => new DetailParser('{}'),
  () => new DetailParser('{"sourceLine":0}'),
  () => analyze_sessions('{', 'root', 0, 1),
  () => analyze_sessions('[]', 'root', 1, 0),
  () => analyze_sessions('[]', 'root', NaN, 1),
  () => aggregate_spans('{'),
]) {
  assert.throws(
    invoke,
    (error) => error instanceof Error && !(error instanceof WebAssembly.RuntimeError),
  );
}
for (const args of [
  ['--details', '{}'],
  ['--analyze', 'root', '1', '0'],
]) {
  const result = spawnSync(
    new URL('../target/release/session-parser', import.meta.url).pathname,
    args,
    {
      input: '[]',
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /^Error:/);
  assert.doesNotMatch(result.stderr, /panicked|backtrace/);
}
const native = (input, args = []) => {
  const result = spawnSync(
    new URL('../target/release/session-parser', import.meta.url).pathname,
    args,
    { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const fixture = (id) => {
  const event = (second, type, payload) =>
    JSON.stringify({
      timestamp: `2026-09-07T00:00:${String(second).padStart(2, '0')}Z`,
      type,
      payload,
    });
  return [
    event(0, 'session_meta', { id, agent_path: `/root/${id}` }),
    event(1, 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    event(2, 'turn_context', { model: 'synthetic-model' }),
    event(3, 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'outer',
      input: 'await tools.exec_command({cmd:"echo café"})',
    }),
    event(5, 'event_msg', {
      type: 'item_completed',
      turn_id: 'turn-1',
      started_at_ms: 1788739203100,
      completed_at_ms: 1788739204200,
      item: {
        type: 'CommandExecution',
        id: 'inner',
        command: ['echo', 'café'],
        exit_code: 1,
        status: 'failed',
        aggregated_output: 'synthetic failure',
      },
    }),
    event(5, 'response_item', {
      type: 'custom_tool_call_output',
      call_id: 'outer',
      output: 'complete',
    }),
    event(6, 'response_item', {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: 'spawn',
      arguments: JSON.stringify({ task_name: 'child' }),
    }),
    event(7, 'response_item', {
      type: 'function_call_output',
      call_id: 'spawn',
      output: JSON.stringify({ agent_id: '11111111-1111-4111-8111-111111111111' }),
    }),
    event(9, 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
    '{"unfinished":',
  ].join('\n');
};
const input = fixture('root');
const wasm = JSON.parse(parse_session(input));
assert.deepEqual(wasm, native(input));
assert.deepEqual(JSON.parse(scan_metadata(input)), native(input, ['--metadata']));
for (const [Constructor, expected] of [
  [SessionParser, wasm],
  [MetadataScanner, wasm.metadata],
]) {
  const parser = new Constructor();
  for (const character of input) parser.push(character);
  assert.deepEqual(JSON.parse(parser.finish()), expected);
  parser.free();
}
const child = JSON.parse(parse_session(fixture('11111111-1111-4111-8111-111111111111')));
const sessions = JSON.stringify([wasm, child]);
const start = wasm.metadata.startTime,
  end = wasm.metadata.endTime;
assert.deepEqual(
  JSON.parse(analyze_sessions(sessions, 'root', start, end)),
  native(sessions, ['--analyze', 'root', String(start), String(end)]),
);
const aggregate = JSON.parse(aggregate_spans(JSON.stringify(wasm.spans)));
assert.ok(aggregate.length > 0);
assert.equal(wasm.metadata.malformedLines, 1);
assert.equal(wasm.spans.find((span) => span.callId === 'inner').status, 'error');
assert.deepEqual(wasm.agentOperations.find((op) => op.kind === 'spawn').targetIds, [
  '11111111-1111-4111-8111-111111111111',
]);
assert.ok(wasm.logEntries.length > 0);
assert.ok(wasm.logEntries.every((entry) => wasm.spans.some((span) => span.id === entry.spanId)));
assert.ok(
  wasm.logEntries.every(
    (entry, index, entries) => index === 0 || entries[index - 1].timestamp <= entry.timestamp,
  ),
);
assert.ok(wasm.logEntries.some((entry) => entry.phase === 'call'));
assert.ok(wasm.logEntries.some((entry) => entry.phase === 'result'));
const detailInput = `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'details', output: 'café🦀\n'.repeat(25000) } })}\n`;
for (const offset of [0, 65536, 131072]) {
  const selector = JSON.stringify({ sourceLine: 1, offset, pageSize: 65536 });
  const parser = new DetailParser(selector);
  for (const part of detailInput.match(/.{1,1024}/gsu)) parser.push(part);
  assert.deepEqual(JSON.parse(parser.finish()), native(detailInput, ['--details', selector]));
  parser.free();
}
const shortCode = 'const result = await tools.run();';
const firstStructuredText = 'café🦀\n'.repeat(20000);
const secondStructuredText = 'A quoted value: "example" and a backslash \\\n'.repeat(6000);
const structuredInput = `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'structured', arguments: JSON.stringify({ code: shortCode }) } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'structured', output: { isError: false, result: { summary: 'Stable header', content: firstStructuredText }, related: [{ text: secondStructuredText }] } } })}\n`;
let firstStructuredResult = '',
  secondStructuredResult = '',
  structuredOffset = 0,
  structuredPages = 0;
for (;;) {
  const selector = JSON.stringify({
    sourceLine: 1,
    outputLine: 2,
    offset: structuredOffset,
    pageSize: 65536,
  });
  const parser = new DetailParser(selector);
  for (const part of structuredInput.match(/.{1,1024}/gsu)) parser.push(part);
  const page = JSON.parse(parser.finish());
  assert.deepEqual(page, native(structuredInput, ['--details', selector]));
  assert.equal(page.code, shortCode);
  assert.deepEqual(JSON.parse(page.args), { code: shortCode });
  const output = JSON.parse(page.output);
  assert.equal(output.isError, false);
  assert.equal(output.result.summary, 'Stable header');
  firstStructuredResult += output.result.content;
  secondStructuredResult += output.related[0].text;
  structuredPages++;
  parser.free();
  if (!page.hasMore) break;
  structuredOffset = page.nextOffset;
}
assert.ok(structuredPages >= 3);
assert.equal(firstStructuredResult, firstStructuredText);
assert.equal(secondStructuredResult, secondStructuredText);
const actualRequest = 'I want you to review this code deeply.\nKeep the entire actual request.';
const requestInput =
  [
    { type: 'session_meta', payload: { id: 'prompt-root' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'prompt-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<recommended_plugins>Context only</recommended_plugins>' },
        ],
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '<environment_context>Context only</environment_context>',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: actualRequest }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n';
const requestSession = JSON.parse(parse_session(requestInput));
assert.deepEqual(requestSession, native(requestInput));
assert.equal(requestSession.turns[0].prompt, actualRequest);
assert.equal(requestSession.turns[0].sourceLine, 5);
const requestSelector = JSON.stringify({ sourceLine: requestSession.turns[0].sourceLine });
const requestDetails = new DetailParser(requestSelector);
requestDetails.push(requestInput);
const requestPage = JSON.parse(requestDetails.finish());
assert.deepEqual(requestPage, native(requestInput, ['--details', requestSelector]));
assert.equal(requestPage.prompt, actualRequest);
requestDetails.free();
const taskBody = 'Validate the streaming parser and its nested agent joins.';
const taskEnvelope = `Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n${taskBody}`;
const taskInput =
  [
    {
      type: 'session_meta',
      payload: { id: 'prompt-child', parent_thread_id: 'prompt-root', agent_path: '/root/worker' },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/worker',
        content: [{ type: 'input_text', text: taskEnvelope }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n';
const taskSession = JSON.parse(parse_session(taskInput));
assert.deepEqual(taskSession, native(taskInput));
assert.equal(taskSession.metadata.agentDescription, taskBody);
assert.equal(taskSession.turns[0].title, taskBody);
assert.equal(taskSession.turns[0].prompt, taskEnvelope);
// Synthetic bytes with the historical transport shape, never a user token.
const encodedTask =
  'gAAAAABqnf6AAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw==';
for (const [message, opaque] of [
  [encodedTask, true],
  ['gAAAA is ordinary prose describing a token prefix.', false],
  [`Please inspect this token: ${encodedTask}`, false],
  [`gAAAA${'A'.repeat(95)}`, false],
]) {
  const args = { task_name: 'worker', message };
  const spawnInput = `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'encoded-spawn', arguments: JSON.stringify(args) } })}\n`;
  const session = JSON.parse(parse_session(spawnInput));
  assert.deepEqual(session, native(spawnInput));
  assert.equal(session.agentOperations[0].description, opaque ? undefined : message);
  assert.deepEqual(JSON.parse(session.spans[0].args), args);
  const selector = JSON.stringify({ sourceLine: 1 });
  const detail = new DetailParser(selector);
  detail.push(spawnInput);
  const page = JSON.parse(detail.finish());
  assert.deepEqual(page, native(spawnInput, ['--details', selector]));
  assert.deepEqual(JSON.parse(page.args), args);
  detail.free();
}
const emptyTaskEnvelope =
  'Message Type: NEW_TASK\nTask name: /root/verification_review\nSender: /root\nPayload:\n';
for (const [agent_path, agent_nickname, title] of [
  ['/root/verification_review', 'Carver', 'verification review'],
  [undefined, 'Carver', 'Carver'],
]) {
  const encryptedChildInput =
    [
      {
        type: 'session_meta',
        payload: { id: 'encrypted-child', parent_thread_id: 'root', agent_path, agent_nickname },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'encrypted-turn' } },
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [
            { type: 'input_text', text: emptyTaskEnvelope },
            { type: 'encrypted_content', encrypted_content: 'opaque-body-with-no-guessable-shape' },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  const session = JSON.parse(parse_session(encryptedChildInput));
  assert.deepEqual(session, native(encryptedChildInput));
  assert.deepEqual(
    JSON.parse(scan_metadata(encryptedChildInput)),
    native(encryptedChildInput, ['--metadata']),
  );
  assert.equal(session.metadata.title, title);
  assert.equal(session.metadata.agentDescription, undefined);
  assert.equal(session.turns[0].prompt, emptyTaskEnvelope);
  const selector = JSON.stringify({ sourceLine: 3 });
  const detail = new DetailParser(selector);
  detail.push(encryptedChildInput);
  const page = JSON.parse(detail.finish());
  assert.deepEqual(page, native(encryptedChildInput, ['--details', selector]));
  assert.equal(
    JSON.parse(page.args).content[1].encrypted_content,
    'opaque-body-with-no-guessable-shape',
  );
  assert.match(page.warnings[0], /encrypted/);
  detail.free();
}
const followupPrompt =
  'Message Type: NEW_TASK\nSender: /root\nPayload:\nCheck every follow-up source.';
const followupInput =
  taskInput +
  [
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'followup-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root',
        content: [{ type: 'input_text', text: followupPrompt }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') +
  '\n';
const followupSession = JSON.parse(parse_session(followupInput));
assert.deepEqual(followupSession, native(followupInput));
assert.equal(followupSession.turns[1].sourceLine, 6);
assert.equal(followupSession.turns[1].prompt, followupPrompt);
const richItems = [
  {
    type: 'Reasoning',
    id: 'reasoning',
    summary_text: ['Recorded summary'],
    raw_content: ['Recorded detailed reasoning'],
  },
  {
    type: 'CommandExecution',
    id: 'failed-command',
    command: ['synthetic-command'],
    status: 'failed',
    exit_code: 1,
    aggregated_output: '',
    stderr: 'Recorded stderr diagnostic',
    error: { message: 'Recorded structured error' },
  },
];
const richInput =
  richItems
    .map((item) =>
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', started_at_ms: 1000, completed_at_ms: 2000, item },
      }),
    )
    .join('\n') + '\n';
const richSession = JSON.parse(parse_session(richInput));
assert.deepEqual(richSession, native(richInput));
assert.equal(richSession.spans.find((span) => span.callId === 'reasoning').name, 'Inference');
assert.match(
  richSession.spans.find((span) => span.callId === 'failed-command').output,
  /Recorded structured error/,
);
for (const sourceLine of [1, 2]) {
  const selector = JSON.stringify({ sourceLine });
  const detail = new DetailParser(selector);
  detail.push(richInput);
  assert.deepEqual(JSON.parse(detail.finish()), native(richInput, ['--details', selector]));
  detail.free();
}
const graphSpan = (id, sessionId, track, startTime, endTime) => ({
  id,
  sessionId,
  track,
  name: track,
  startTime,
  endTime,
  status: 'complete',
  inferred: false,
});
const graphSession = (id, parentId, spans, agentOperations, endTime) => ({
  metadata: {
    ...wasm.metadata,
    id,
    parentId,
    agentPath: id === 'graph-root' ? '/root' : `/root/${id}`,
    startTime: 0,
    endTime: 100,
  },
  spans,
  agentOperations,
  warnings: [],
  turns: [{ ...wasm.turns[0], id: `${id}-turn`, startTime: 0, endTime, status: 'complete' }],
});
const graphRoot = graphSession(
  'graph-root',
  undefined,
  [
    graphSpan('root-wait', 'graph-root', 'agent_wait', 0, 100),
    graphSpan('send-message', 'graph-root', 'agent_messages', 1, 2),
  ],
  [
    { spanId: 'root-wait', kind: 'wait', targetIds: ['graph-child'], timestamp: 0 },
    { spanId: 'send-message', kind: 'send', targetIds: ['graph-grandchild'], timestamp: 1 },
  ],
  100,
);
const graphChild = graphSession(
  'graph-child',
  'graph-root',
  [graphSpan('child-wait', 'graph-child', 'agent_wait', 10, 90)],
  [{ spanId: 'child-wait', kind: 'wait', targetIds: ['graph-grandchild'], timestamp: 10 }],
  95,
);
const graphReceive = {
  ...graphSpan('receive-message', 'graph-grandchild', 'agent_messages', 3, 3),
  name: 'Agent message received',
  targetAgentId: '/root',
};
const graphGrandchild = graphSession(
  'graph-grandchild',
  'graph-child',
  [graphSpan('grandchild-work', 'graph-grandchild', 'shell', 20, 60), graphReceive],
  [],
  70,
);
const graphJson = JSON.stringify([graphRoot, graphChild, graphGrandchild]);
const graphAnalysis = JSON.parse(analyze_sessions(graphJson, 'graph-root', 0, 100));
assert.deepEqual(graphAnalysis, native(graphJson, ['--analyze', 'graph-root', '0', '100']));
assert.equal(graphAnalysis.path.total, 100);
assert.ok(
  graphAnalysis.path.segments.some((segment) => segment.span.sessionId === 'graph-grandchild'),
);
assert.equal(
  graphAnalysis.flows.find((flow) => flow.kind === 'send').targetSpanId,
  'receive-message',
);
// Exercise raw relative tool targets through parsing and both analysis adapters.
const flowRecord = (second, type, payload) =>
  JSON.stringify({
    timestamp: `2026-09-07T00:00:${String(second).padStart(2, '0')}Z`,
    type,
    payload,
  });
const relativeRootInput = [
  flowRecord(0, 'session_meta', { id: 'relative-root' }),
  flowRecord(1, 'response_item', {
    type: 'function_call',
    name: 'spawn_agent',
    call_id: 'spawn-call',
    arguments: JSON.stringify({ task_name: 'timeline', message: 'Synthetic task' }),
  }),
  flowRecord(2, 'response_item', {
    type: 'function_call_output',
    call_id: 'spawn-call',
    output: '{}',
  }),
  flowRecord(3, 'response_item', {
    type: 'function_call',
    name: 'send_message',
    call_id: 'send-call',
    arguments: JSON.stringify({ target: 'timeline', message: 'Synthetic follow-up' }),
  }),
  flowRecord(4, 'response_item', {
    type: 'function_call_output',
    call_id: 'send-call',
    output: '{}',
  }),
].join('\n');
const relativeChildInput = [
  flowRecord(1, 'session_meta', {
    id: 'relative-child',
    parent_thread_id: 'relative-root',
    agent_path: '/root/timeline',
  }),
  flowRecord(2, 'event_msg', { type: 'task_started', turn_id: 'relative-turn' }),
  flowRecord(4, 'response_item', {
    type: 'agent_message',
    author: '/root',
    recipient: '/root/timeline',
    content: [
      {
        type: 'input_text',
        text: 'Message Type: MESSAGE\nTask name: /root/timeline\nSender: /root\nPayload:\nSynthetic follow-up',
      },
    ],
  }),
  flowRecord(5, 'event_msg', { type: 'task_complete', turn_id: 'relative-turn' }),
].join('\n');
const relativeSessions = [relativeRootInput, relativeChildInput].map((input) => {
  const parsed = JSON.parse(parse_session(input));
  assert.deepEqual(parsed, native(input));
  return parsed;
});
const relativeJson = JSON.stringify(relativeSessions);
const relativeStart = Date.parse('2026-09-07T00:00:00Z');
const relativeAnalysis = JSON.parse(
  analyze_sessions(relativeJson, 'relative-root', relativeStart, relativeStart + 6000),
);
assert.deepEqual(
  relativeAnalysis,
  native(relativeJson, [
    '--analyze',
    'relative-root',
    String(relativeStart),
    String(relativeStart + 6000),
  ]),
);
assert.equal(relativeAnalysis.flows.length, 2);
for (const [kind, track] of [
  ['spawn', 'turns'],
  ['send', 'agent_messages'],
]) {
  const flow = relativeAnalysis.flows.find((flow) => flow.kind === kind);
  const endpoint = relativeSessions[1].spans.find((span) => span.id === flow.targetSpanId);
  assert.equal(endpoint.track, track);
  if (kind === 'send') assert.equal(endpoint.name, 'Agent message received');
}
for (const [message, timed_out, joins] of [
  ['Wait completed.', false, true],
  ['Wait timed out.', true, false],
  ['Wait interrupted by new input.', false, false],
]) {
  const mailboxRoot = {
    ...graphRoot,
    spans: [
      { ...graphRoot.spans[0], name: 'wait_agent', output: JSON.stringify({ message, timed_out }) },
    ],
    agentOperations: [{ ...graphRoot.agentOperations[0], targetIds: [] }],
  };
  const mailboxJson = JSON.stringify([mailboxRoot, graphChild, graphGrandchild]);
  const result = JSON.parse(analyze_sessions(mailboxJson, 'graph-root', 0, 100));
  assert.deepEqual(result, native(mailboxJson, ['--analyze', 'graph-root', '0', '100']));
  assert.equal(result.path.total, 100);
  assert.equal(
    result.path.segments.some((segment) => segment.span.sessionId === 'graph-grandchild'),
    joins,
  );
}
const cellWaitInput =
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'wait',
      call_id: 'cell-resume',
      arguments: JSON.stringify({ cell_id: 'cell-1', yield_time_ms: 1000 }),
    },
  }) + '\n';
const cellWaitSession = JSON.parse(parse_session(cellWaitInput));
assert.deepEqual(cellWaitSession, native(cellWaitInput));
assert.equal(cellWaitSession.spans[0].track, 'code');
assert.equal(cellWaitSession.agentOperations.length, 0);
const conversationInput =
  [
    { type: 'session_meta', payload: { id: 'conversation' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'conversation-turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<app-context>Injected instructions</app-context>' }],
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '<environment_context>Injected</environment_context>',
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: '<request>Actual user XML</request>' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '<result>Actual assistant XML</result>' }],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n';
const conversationSession = JSON.parse(parse_session(conversationInput));
assert.deepEqual(conversationSession, native(conversationInput));
assert.deepEqual(
  conversationSession.logEntries.map((entry) => entry.role),
  ['user', 'assistant'],
);
const legacyText = 'Complete legacy output 🦀\n'.repeat(10000);
const legacyInput =
  [
    {
      type: 'event_msg',
      payload: { type: 'exec_command_begin', call_id: 'legacy', command: ['printf', 'synthetic'] },
    },
    {
      type: 'event_msg',
      payload: { type: 'exec_command_end', call_id: 'legacy', exit_code: 1, stdout: legacyText },
    },
    {
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Implementation and verification complete.' },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n';
const legacySession = JSON.parse(parse_session(legacyInput));
assert.deepEqual(legacySession, native(legacyInput));
assert.equal(legacySession.spans.find((span) => span.callId === 'legacy').outputLine, 2);
assert.ok(legacySession.logEntries.some((entry) => entry.role === 'assistant'));
let legacyOffset = 0,
  legacyReconstructed = '';
for (;;) {
  const selector = JSON.stringify({
    sourceLine: 1,
    outputLine: 2,
    offset: legacyOffset,
    pageSize: 65536,
  });
  const detail = new DetailParser(selector);
  detail.push(legacyInput);
  const page = JSON.parse(detail.finish());
  assert.deepEqual(page, native(legacyInput, ['--details', selector]));
  assert.equal(page.code, 'printf synthetic');
  legacyReconstructed += page.output;
  detail.free();
  if (!page.hasMore) break;
  legacyOffset = page.nextOffset;
}
assert.equal(legacyReconstructed, legacyText);
const reviewPrompt =
  'The following is the Codex agent history whose request action you are assessing.\nSynthetic original history.';
for (const model of ['codex-auto-review', 'ordinary-model']) {
  const reviewInput =
    [
      { type: 'session_meta', payload: { id: 'review' } },
      { type: 'turn_context', payload: { model } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'review-turn' } },
      { type: 'event_msg', payload: { type: 'user_message', message: reviewPrompt } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  const session = JSON.parse(parse_session(reviewInput));
  assert.deepEqual(session, native(reviewInput));
  assert.equal(session.turns[0].prompt, reviewPrompt);
  assert.equal(
    session.metadata.title,
    model === 'codex-auto-review' ? 'Review tool request' : reviewPrompt.replace('\n', ' '),
  );
}
console.log(
  'Native/WASM parity passed: parsing, streaming, nested critical paths, send/receive endpoints, full details, follow-up sources, diagnostics, opaque labels and task envelopes.',
);

// Synthetic reproduction of a missing completion followed by a later session
// visit. The original report is identified locally by Session info, never copied.
const interruptedInput = [
  [0, 'session_meta', { id: 'interrupted-root' }],
  [1000, 'event_msg', { type: 'task_started', turn_id: 'interrupted' }],
  [5000, 'event_msg', { type: 'agent_message', message: 'Last recorded work' }],
  [60_000, 'event_msg', { type: 'thread_settings_applied' }],
  [86_400_000, 'event_msg', { type: 'task_started', turn_id: 'later' }],
  [86_401_000, 'event_msg', { type: 'task_complete', turn_id: 'later' }],
]
  .map(([ms, type, payload]) =>
    JSON.stringify({ timestamp: new Date(1788739200000 + ms).toISOString(), type, payload }),
  )
  .join('\n');
const interrupted = JSON.parse(parse_session(interruptedInput));
assert.deepEqual(interrupted, native(interruptedInput));
assert.equal(interrupted.turns[0].endTime - interrupted.turns[0].startTime, 4000);
assert.equal(interrupted.turns[0].status, 'incomplete');
assert.ok(
  interrupted.spans
    .filter((span) => span.turnId === 'interrupted')
    .every((span) => span.endTime <= interrupted.turns[0].endTime),
);
const compactedInput = JSON.stringify({
  type: 'compacted',
  timestamp: '2026-09-07T00:00:00Z',
  payload: { replacement_history: [{ type: 'message', content: 'x'.repeat(150_000) }] },
});
const compactionSelector = JSON.stringify({ sourceLine: 1, pageSize: 65536 });
const compactionDetail = new DetailParser(compactionSelector);
compactionDetail.push(compactedInput);
const compacted = JSON.parse(compactionDetail.finish());
compactionDetail.free();
assert.deepEqual(compacted, native(compactedInput, ['--details', compactionSelector]));
assert.equal(compacted.hasMore, false);
console.log('Missing-completion and opaque-compaction native/WASM regressions passed.');

for (const payload of [
  {
    type: 'web_search_end',
    query: 'synthetic',
    action: { type: 'search' },
    results: ['done'],
    ignored: 'x'.repeat(150_000),
  },
  {
    type: 'function_call',
    name: 'exec_command',
    arguments: '{"cmd":"true"}',
    ignored: 'x'.repeat(150_000),
  },
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'done', ignored: 'x'.repeat(150_000) }],
  },
]) {
  const input = JSON.stringify({ type: 'response_item', payload });
  const parser = new DetailParser(compactionSelector);
  parser.push(input);
  const result = JSON.parse(parser.finish());
  parser.free();
  assert.deepEqual(result, native(input, ['--details', compactionSelector]));
  assert.equal(result.hasMore, false);
}
console.log('Ignored-field detail paging native/WASM regressions passed.');

const searchQuery = 'search 🦀 '.repeat(15000);
const searchInput = JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'web_search_end',
    query: searchQuery,
    action: { type: 'search' },
    results: ['done'],
  },
});
let searchOffset = 0;
let reconstructedQuery = '';
for (;;) {
  const selector = JSON.stringify({ sourceLine: 1, pageSize: 65536, offset: searchOffset });
  const parser = new DetailParser(selector);
  parser.push(searchInput);
  const page = JSON.parse(parser.finish());
  parser.free();
  assert.deepEqual(page, native(searchInput, ['--details', selector]));
  reconstructedQuery += JSON.parse(page.args).query;
  if (!page.hasMore) break;
  searchOffset = page.nextOffset;
  assert.ok(searchOffset < 300000);
}
assert.ok(searchOffset > 0);
assert.equal(reconstructedQuery, searchQuery);
console.log('Displayed web-search projection reconstructs across native/WASM pages.');
