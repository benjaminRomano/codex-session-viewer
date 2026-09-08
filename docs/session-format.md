# Codex rollout format and trace model

The parser was designed against a local Codex checkout at commit `a51608398d53b6d23ed98b8287de415b35f1eea5` and read-only inspection of active and archived sessions on 2026-09-07. It accepts multiple historical formats instead of assuming that the current protocol describes every saved file. No real prompts, commands, outputs, IDs or session files are included in test fixtures.

## Source inventory

The authoritative source files inspected are:

- [`codex-rs/history/src/lib.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/history/src/lib.rs): `RolloutItem` variants.
- [`codex-rs/history/src/rollout_payload.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/history/src/rollout_payload.rs): serialized envelope, optional harness metadata.
- [`codex-rs/protocol/src/protocol.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/protocol/src/protocol.rs): session metadata, events, lifecycle timestamps, legacy collaboration, thread settings, usage.
- [`codex-rs/protocol/src/items.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/protocol/src/items.rs) and [`models.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/protocol/src/models.rs): rich turn items and raw response items.
- [`codex-rs/rollout/src/policy.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/rollout/src/policy.rs): persistence policy. Many protocol events are transient and never appear in ordinary rollouts.
- [`codex-rs/rollout/src/session_index.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/rollout/src/session_index.rs): append-only title index; last entry for an ID wins.
- [`codex-rs/rollout/src/recorder.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/rollout/src/recorder.rs), [`rollout_file_name.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/rollout/src/rollout_file_name.rs) and [`compression.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/rollout/src/compression.rs): physical file lifecycle, filenames and compressed history.
- [`codex-rs/state/src/sqlite.rs`](https://github.com/openai/codex/blob/a51608398d53b6d23ed98b8287de415b35f1eea5/codex-rs/state/src/sqlite.rs): Codex's separate state databases; these are outside this viewer's input contract.

## Files on disk and the title index

The selected directory is the Codex home, normally `~/.codex`. The viewer recursively discovers plain `.jsonl` files under both `sessions/` and `archived_sessions/`; their content uses the same rollout reader. Current new active files are created under `sessions/YYYY/MM/DD/`, using the machine's local creation date. Older active layouts can be flatter, so discovery does not require a fixed directory depth. An archived session can contain the child files needed by an active parent, and vice versa; graph resolution uses the complete selected inventory.

Ordinary basenames are `rollout-YYYY-MM-DDTHH-MM-SS-<thread_id>.jsonl`. The timestamp in the filename is a discovery aid, not the source of span timing. The first physical session metadata identifies the file's thread; record timestamps provide timing. An active file is append-only and may end with an incomplete JSON line while Codex writes it. Resuming can append more turns. A refresh validates file size and modification time before reusing cached metadata.

`session_index.jsonl` is a **title index**, not a complete thread catalog. Each name update appends a record like this synthetic example:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "thread_name": "Inspect a synthetic trace",
  "updated_at": "2026-09-07T20:00:00Z"
}
```

`id` is the individual thread ID, `thread_name` is the current candidate name, and `updated_at` is an RFC3339 UTC string written for that update. The most recently **appended** matching entry wins; consumers must not sort updates by timestamp to resolve names. The index can be absent or omit a thread. This viewer ignores malformed index lines, then falls back to readable message-derived titles or agent paths/nicknames. The index does not supply model, turn count, child count, rollout paths or archive status. Those values come from the scanned files. Codex's SQLite state files and the viewer's localStorage metadata cache are separate from this title index.

Current Codex also supports `rollout-<timestamp>-<thread_id>_<rollout_id>.jsonl` after `thread/revert`, where the stable thread has a new physical rollout ID. It can compress files as `.jsonl.zst` and reference immutable prefixes through `history_base`. This viewer currently models one plain physical file per thread. It does not choose among reverted rollout versions, decompress files, or reconstruct cross-file prefixes. Multiple physical versions therefore require explicit future version-resolution support; they must not be interpreted as multiple independent agents. The ordinary-filename identity checks used by the corpus validator do not establish correctness for that newer layout.

## Session metadata and turn context

Current `session_meta.payload` flattens `SessionMeta` with optional `git` information. These fields have different identities and purposes:

| Source fields                                                                                        | Meaning                                                                   | Viewer use                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                                 | Individual thread ID, stable across that thread's revert                  | Immutable normalized `metadata.id`, span ownership and graph lookup. A later copied ancestor metadata record cannot replace it.                      |
| `session_id`                                                                                         | Root thread's ID, shared by the broader multi-agent session               | Accepted; not substituted for the individual thread ID.                                                                                              |
| `parent_thread_id`                                                                                   | Spawn parent                                                              | `parentId`; older `source.subagent.thread_spawn.parent_thread_id` is a fallback.                                                                     |
| `forked_from_id`, `forked_from_ordinal_exclusive`                                                    | Logical fork source and exclusive inherited boundary                      | Accepted; a fork alone does not establish a spawned-child edge.                                                                                      |
| `timestamp`, `cwd`                                                                                   | Creation timestamp and initial working directory                          | Metadata time fallback and working-directory display.                                                                                                |
| `agent_path`, `agent_nickname`, `agent_role` (legacy alias `agent_type`)                             | Canonical path, display nickname and assigned role                        | Path/nickname identify and label agents. Role is accepted without creating another track group. Older nested thread-spawn metadata is also accepted. |
| `source`, `thread_source`, `originator`, `cli_version`                                               | Client/origin and analytics provenance                                    | Accepted; only nested subagent lineage is needed by the current normalized model.                                                                    |
| `model_provider`, `base_instructions`                                                                | Provider and initial instructions/provenance                              | Provider is not a model slug. `base_instructions.provenance.model` can supply a missing initial model. Instruction bodies are not task titles.       |
| `history_mode`, `history_base`, `subagent_history_start_ordinal`                                     | Persistence mode, physical inherited prefix and child projection boundary | The ordinal boundary suppresses inherited child context. `history_base` reconstruction is unsupported.                                               |
| `dynamic_tools`, `selected_capability_roots`, `memory_mode`, `multi_agent_version`, `context_window` | Tool declarations and execution/history configuration                     | Accepted without executing or expanding these into work spans.                                                                                       |
| `git.commit_hash`, `git.branch`, `git.repository_url`                                                | Optional repository context                                               | Accepted; not required for timeline loading.                                                                                                         |

`source` can be `cli`, `vscode`, `exec`, `mcp`, `custom`, `internal`, `subagent` or `unknown`, with structured payloads for applicable variants. A thread-spawn source carries parent ID and depth, with optional path/nickname/role. Older sessions may omit newer metadata fields; the parser uses optional lookups rather than rejecting the whole file.

`turn_context.payload` records per-turn configuration. Its `turn_id` and optional `root_turn_id` identify local/root turn context; `model` is the current model slug. Other fields include working directory/workspace roots, date/timezone, approval and permission configuration, network/filesystem restrictions, personality, collaboration settings, reasoning effort and legacy summary configuration. The viewer reads model updates without treating the surrounding configuration as user input or executing any instructions in it. Explicit lifecycle records establish the normalized turn boundaries.

`history_base` contains `thread_id`, `end_ordinal_exclusive` and `end_byte_offset`. Despite the historical field name, its `thread_id` means the **physical rollout ID**, which may differ from `SessionMeta.id` after revert. It describes an exclusive immutable prefix, not an agent dispatch relationship.

## Record envelope and persistence modes

The current wire envelope is `{timestamp, ordinal?, type, payload, metadata?}`. Known outer types are `session_meta`, `response_item`, `inter_agent_communication`, `inter_agent_communication_metadata`, `compacted`, `turn_context`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `event_msg`, and `realtime_item`. Unknown outer types are tolerated and counted, but do not create invented work spans.

`timestamp` is a persistence timestamp. Optional `ordinal` is the logical rollout ordering used for inherited-history boundaries; it is not a physical line number. `response_item.metadata` can contain harness metadata independent of the response payload. The viewer does not need that metadata to pair calls.

| Outer variant                                                                                                                         | Current projection                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `session_meta`, `turn_context`                                                                                                        | Identity/lineage/configuration fields described above.                                                                |
| `response_item`                                                                                                                       | Recognized calls, outputs, user/assistant messages, incoming agent messages and web/media observations.               |
| `event_msg`                                                                                                                           | Recognized turn lifecycle, rich item lifecycle, legacy tool/collaboration events, messages and supplied diagnostics.  |
| `inter_agent_communication`                                                                                                           | Incoming message span, sender/correlation information and eligible child prompt source.                               |
| `compacted`                                                                                                                           | Instant context-compaction marker. Replacement history, retained context and window IDs are not replayed as new work. |
| `inter_agent_communication_metadata`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `realtime_item` | Accepted/countable records without detailed span expansion.                                                           |
| Unknown variants/fields                                                                                                               | Valid envelopes remain countable; unrecognized semantics produce no fabricated operation.                             |

Codex's `history_mode` is `legacy` by default or `paginated`. Its persistence policy matters more than the full protocol enum: paginated rollouts retain rich `item_completed` turn items; legacy rollouts retain selected messages, reasoning, review and tool-end events plus a smaller subset of completed items. Both modes persist turn lifecycle and thread-settings events. Many begin events, streaming deltas, diagnostics and collaboration notifications are transient in the current implementation, though the viewer accepts supported historical/supplied representations. Missing records must not be interpreted as evidence that an operation never occurred.

Older archived files also contain a bare first metadata object, `record_type` markers, and bare Responses API objects. These objects lack operation timestamps. The parser preserves their messages, calls and title metadata, but gives operations zero duration and reports the timing limitation.

## Track taxonomy, before rendering

Every loaded agent session is a track group. Tracks are populated from recorded evidence and empty tracks can be hidden. Times are Unix milliseconds; zero-duration events remain selectable.

| Track ID         | Meaning and recorded evidence                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turns`          | `task_started` / `turn_started` to `task_complete` / `turn_complete` or `turn_aborted`; open turns end at the last recorded timestamp.                                                                    |
| `inference`      | Rich `Reasoning` item lifecycle where available. Otherwise gaps left after unioning recorded tool intervals within a turn. Gaps are internally marked uncertain and are not measured API request latency. |
| `shell`          | Function shell calls and outputs; rich `CommandExecution`; legacy exec begin/end.                                                                                                                         |
| `files`          | `apply_patch`, rich `FileChange`, legacy patch events.                                                                                                                                                    |
| `skills`         | Shell reads containing `SKILL.md`; this is a content-based classification of the command.                                                                                                                 |
| `code`           | Code-mode `exec` or `js` wrappers. Rich nested tool events form their own spans and can overlap the wrapper.                                                                                              |
| `agent_dispatch` | Spawn, resume, interrupt and close; child activity lifecycle markers.                                                                                                                                     |
| `agent_wait`     | Explicit wait calls and their outputs. A timeout is a wait, not a demonstrated child-completion dependency.                                                                                               |
| `agent_messages` | Outgoing send/followup operations and incoming inter-agent messages.                                                                                                                                      |
| `tools`          | MCP, connector, generic and tool-search calls.                                                                                                                                                            |
| `web`            | Web search, image generation/viewing, media extension items.                                                                                                                                              |
| `approval`       | User input and permission tools; explicit approval events when a supplied log contains them.                                                                                                              |
| `context`        | Compaction markers and rich context-compaction items.                                                                                                                                                     |
| `messages`       | User and assistant messages. These are presentation events, excluded from blocking-path duration.                                                                                                         |
| `system`         | Explicit diagnostics when supplied. Current standard rollouts discard many diagnostic events.                                                                                                             |

## Timing, pairing and errors

Raw `function_call`, `custom_tool_call` and corresponding outputs pair by `call_id`, independently of record adjacency. This supports parallel tool calls and out-of-order results. A call with no result remains incomplete, and is not fabricated as completed at file end. Rich `item_completed` contains `started_at_ms` and `completed_at_ms`; those times take precedence over persistence timestamps. Item IDs deduplicate raw and rich representations of the same tool. Missing starts are represented as instantaneous observations.

Legacy `event_msg` exec, MCP, patch and web begin/end pairs also retain their physical begin and end locations. Lazy details reconstruct the recorded command/invocation/changes/action and result or stdout/stderr, including pages of long output. End-only records keep their own output location. Legacy `event_msg.agent_message` records are assistant messages even without a duplicate response item; matching same-timestamp/body copies deduplicate in the session log.

Nonzero command exit codes, explicit failed/error item statuses and structured tool output errors are retained; a later generic call-output record does not erase an observed failure. Recorded stderr and error fields enrich command output when the aggregate output is empty or omits them. Code and output excerpts are capped at 16 KiB each with an explicit truncation marker. Images are not decoded or copied into trace details.

Turn model selection uses `turn_context.model`, `thread_settings_applied.thread_settings.model`, and available model-reroute fields. Metadata retains the most recently recorded model. The title index is authoritative over a first-user-message fallback. Known injected context records, including recommended plugins, environment context and AGENTS.md instructions, are rejected before choosing the turn prompt or its physical source line. Generic user XML remains a request, except text beginning with a reserved injected-context prefix. The JSONL input does not reliably distinguish an injected wrapper from identical literal user text, so the explicit prefix list in `is_context_input` treats both as context. A request that literally begins with `<environment_context>` or another reserved prefix is therefore excluded from the prompt fallback; its original message record remains available in the trace. Recognized incoming `Message Type` / `Task name` / `Sender` / `Payload` envelopes are stripped only for brief titles and agent descriptions; the full prompt and source detail remain unchanged.

Token records contain reported usage, not request-start timestamps. The parser does not translate token-count updates into precise inference duration or TTFT. Realtime packets, retained context, security scores, and world-state payloads are accepted but are not expanded into detailed tracks in this version.

Explicit `Reasoning` items and reconstructed gaps both use the timeline label `Inference`. Their timing evidence remains distinct: rich reasoning items retain recorded start/end times, while gaps keep an internal inferred flag. Selecting a rich item retrieves its original summary and raw reasoning fields. A generated review prompt beginning with the exact known history-assessment prefix is labeled `Review tool request` only when the recorded model is `codex-auto-review`; its complete prompt remains unchanged.

## Agent graph and history

Child lineage is read from `session_meta.parent_thread_id` or `source.subagent.thread_spawn.parent_thread_id`. Canonical `agent_path` is retained separately from the nickname. A `forked_from_id` alone is not a spawned-child relationship.

Classic collaboration returns UUIDs. Path-based collaboration can return only `{task_name: '/root/worker'}`; `sub_agent_activity` and child metadata connect canonical paths to UUIDs. A spawn result with an actual UUID supersedes its earlier task-name alias. Wait/send receiver lists, legacy receiver fields and rich collaboration items are accepted.

Send flows terminate on `Agent message received` spans, never on the next inference span. Matching prefers an explicit shared call/correlation ID when present, otherwise uses the recorded sender identity and receive timestamp after dispatch start. A received message is not reused for another send. Older root metadata without `agent_path` is mapped to `/root` only when the loaded graph has exactly one top-level session. Without a recorded receive endpoint, no send flow is fabricated. Incoming task messages capture each turn's prompt/source line independently of the first task description.

Untargeted `collaboration.wait_agent` calls can join recorded direct-child turn completions within the wait only when their structured output has `timed_out: false` and the recognized `Wait completed` message. Reported target identities, when present, narrow the candidate set. Timeout, user interruption and unknown outcomes do not establish that join. The selected latest completion is still a reconstructed dependency, not proof of the scheduler's exact wake-up cause. `functions.wait` calls carrying `cell_id` belong to code execution and do not become agent operations.

Some historical task bodies are encrypted. A child records an explicit `encrypted_content` block beside a plaintext transport header with an empty payload, while the parent dispatch may store identical opaque bytes in `arguments.message`. Typed encrypted blocks are not treated as plaintext. For brief operation descriptions only, `is_encoded_agent_payload` also rejects an entire canonically padded URL-safe Base64 token with version byte `0x80`, a timestamp between 2000 and 2100, and decoded size `57 + 16 × n` bytes for positive `n`. This is a narrow label heuristic, not authentication or decryption; ordinary prose beginning with `gAAAA` is retained. Other historical encodings may need additional format support, and a literal standalone token matching this shape also receives no brief description. Original arguments and source details remain available. Encrypted incoming details include the complete structured source and an explicit warning explaining that no plaintext task body is available. A child without a readable title uses its last agent-path component (underscores changed to spaces), then nickname. `agentDescription` remains absent so a readable parent dispatch can take precedence.

`subagent_history_start_ordinal` excludes inherited parent context from the child's own turns and spans. Older files without this marker may contain copied context that cannot be perfectly separated; parent linkage is still preserved. Physical paginated history inherited through `history_base`, compressed rollout files and segments absent from the selected directory are not reconstructed automatically. Graph loading must report missing sessions rather than silently synthesizing them.

## Streaming and resource bounds

Logical conversation messages come only from actual assistant/user roles and agent communications. Injected developer/system instructions are not normalized as assistant messages, and known user-context wrappers are excluded from the session log. Legitimate user/assistant XML remains content unless it begins with a reserved user-context prefix described above.

`ParsedSession.logEntries` is a compact Rust projection ordered by timestamp. Each entry contains `id`, `spanId`, `sessionId`, optional `turnId`, `role`, `title`, `timestamp`, and optional `phase: call | result`. Tool calls/results share an existing span and use its start/end timestamps. Bodies are not copied into the projection. Message duplicates with identical role, turn, timestamp and body are collapsed; identical text recorded later remains a separate entry. A turn prompt without a corresponding user/incoming message span receives a user entry referencing its turn span at turn start. Synthetic inference gaps and turn envelopes do not otherwise create log entries. Explicit reasoning is included only when recorded content is present. Older parsed JSON without `logEntries` deserializes with an empty projection.

WASM exports `parse_session(text)` and `scan_metadata(text)` for small inputs; `SessionParser` and `MetadataScanner` expose `push(chunk)` and `finish()` for streaming browser files. The browser owns UTF-8 decoding. The native benchmark uses the same engine with a bounded incremental decoder.

The parser lexically elides JSON string bodies after 64 KiB, retaining quotes, escapes and the surrounding record. Large base64/tool-output strings therefore keep their event IDs, timestamps, call pairing and error envelope. Quote, backslash and Unicode-surrogate state survives arbitrary chunk boundaries. `elidedStrings` and `elidedBytes` expose payload elision. Small records take a direct JSON parsing path; large unescaped runs use a byte search instead of processing every character individually.

Retained structured JSON is capped at 8 MiB per record. A record with too many structured values can still exceed that cap and is skipped through its next newline; `oversizedLines` and `oversizedBytes` report that separate condition. At most 100,000 spans are retained per session, after which metadata scanning continues. All text-size limits are UTF-8 safe. Malformed final partial records are counted rather than failing the entire session.

Trace excerpts are not the full-detail store. Every recorded span carries 1-based physical `sourceLine` / `outputLine` references, including ignored, blank and malformed lines in the numbering. Turns separately carry their prompt and source line, and turn span labels are only `Turn N`. `DetailParser` re-streams the selected source file and retains only the requested records. `is_done()` lets the worker stop after the last selected physical line. Normal details are returned in full. Large strings are available in pages, defaulting to 1 MiB, through `{hasMore,nextOffset}`; pages contain no truncation marker. The selector accepts source/output lines, or a call ID fallback, plus an encoded-string byte offset and page size. UTF-8 scalars, escapes and surrogate pairs are assigned to one page so the fragments of an individual paged string reconstruct its original text exactly.

**Each returned detail object is a complete presentation page. Render successive pages separately; never concatenate the returned `code`, `args`, `output` or `prompt` fields.** Structured fields retain their JSON wrappers on every page, while short source fields can repeat unchanged when a different field's large output is advancing. Concatenating whole returned fields would therefore produce invalid JSON documents or duplicate otherwise complete code. A normal detail that fits one page needs no page label; additional pages can be numbered without interpreting their contents in the UI. This contract keeps representation and paging in Rust and presentation in React.

## Critical path model

Rust builds communication flows, span aggregates and the reconstructed blocking chain. A sweep across operation boundaries partitions time without double-counting nested wrappers: concrete tools take precedence over code wrappers, which take precedence over inference gaps. A wait can enter a child's path only when a completed child turn is recorded inside the wait. Running children, unknown targets and cycles leave the wait in place. The latest observed completion among wait targets is selected; unknown scheduling dependencies are not asserted as exact causal facts. Adjacent segments from the same operation are coalesced and repetition statistics count an operation once even when nesting splits its contribution.

The analysis API is `analyze_sessions(json, rootId, startMs, endMs)` and returns `{flows, path, statistics}`. `path` contains ordered clipped segments, total time, internal observed/uncertain totals, aggregated path operations and suggestions. `aggregate_spans(json)` supports selection summaries. Browser components display these normalized results rather than deriving a second engine model.

### Missing turn completions and compaction details

An open turn retains the time of its own last activity record. Session settings
and unrelated later turns do not extend it. At EOF an unfinished superseded turn
is `incomplete`; the currently active unfinished turn remains `running`. Neither
is extended to the file's last timestamp. An explicit late completion belongs to
its named turn and does not clear a different active turn. Explicit overlapping
turns and operation intervals remain intact. Diagnostics report missing terminal
records.

`ContextCompaction` item timestamps define its recorded elapsed duration. A
`compacted` record instead marks the instantaneous history replacement. Its opaque
replacement history is not rendered as prompt/output. Detail paging requires
displayable content, so large ignored fields cannot offer empty pages.
