# Evidence and timing

## Acquire only the relevant records

Use available session tools for identity and recent context. Summaries can omit timing and report zero command duration; they are not sufficient for precise accounting. With authorized local access, search filenames in both `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` (default `~/.codex`). Restrict discovery to rollout files and `session_index.jsonl`; do not inspect credentials or unrelated databases. Find descendants from recorded identities, not display names alone. If a filename has multiple physical versions, resolve the version or disclose the ambiguity.

Prefer metadata and a compact span inventory before full payloads. Read only selected raw lines, keeping physical line numbers. Encrypted, elided, or missing content is unavailable evidence; do not try to recover it or manufacture the missing intent. Check record diagnostics and whether the suspected bottleneck's records were lost. Keep raw content local.

## Time semantics

Prefer explicit lifecycle start/end and duration fields over when a buffered record was written. Record timestamp and operation time are different clocks. Pair tool calls/results by call ID, not adjacency. Deduplicate parallel representations of the same message or tool result. Explicit task-start/task-complete IDs are stronger than counting visible user messages, which can contain injected context and steering.

Resolve async command/session IDs and exec-cell IDs through completion. A tool returning a running ID has not finished the command. A wait timeout is not child completion. For an interrupted or missing completion, use the last supported observation and mark the scope incomplete; do not stretch inference to an unrelated later event. Compaction summaries and inherited child history must not create duplicate turns or work.

For intervals `[start,end)`, clip to the requested bounds and take their union before reporting wall coverage. Aggregate tool durations and token totals answer different questions. Token usage may be cumulative or repeated in multiple event formats: use valid deltas and deduplication, or omit totals. Large output volume can explain context pressure but is not proof of the cause or avoidable duration of a compaction.

## Optional Codex Session Viewer native engine

If a local `codex-session-viewer` checkout is available, its Rust CLI can normalize rollout records and analyze a graph. Inspect that checkout's CLI and architecture documentation for the installed contract. Do not install or build a large dependency stack just to use this route when adequate evidence is already available.

The known CLI accepts a rollout on stdin and emits a `ParsedSession`. Its `--analyze ROOT_ID START_MS END_MS` mode accepts a JSON array of normalized sessions and returns `flows`, `path`, and `statistics`. Times are Unix milliseconds. Parse the root and required descendants separately; pass their array to the analysis command. Preserve the full turn metadata even if filtering operations to the requested window: a long-lived process may belong to an earlier turn. Missing descendants matter only if the selected outcome depends on them, not merely because they appear somewhere in the session. Use the chosen turn's actual `startTime`/`endTime` and the selected agent's identity. Record the parser revision/version and diagnostics. Prefer subprocess argument arrays to shell interpolation for paths and IDs.

The engine's `path.segments` carries exclusive reconstructed intervals and source spans. Its global `statistics` can overlap across agents and wrapper categories; do not divide those totals by root wall time and call them a breakdown. A path that remains on the parent during a remote wait still needs a semantic explanation of the remote blocker. An encoded child prompt may also cause an unhelpful inferred title; use lineage and original available messages to identify its task.

The optional helper in this skill summarizes these normalized outputs without interpreting raw rollout formats:

```text
python3 scripts/summarize_trace.py --sessions /absolute/sessions.json --session SESSION_ID
python3 scripts/summarize_trace.py --sessions /absolute/sessions.json --session SESSION_ID --turn TURN_ID --analysis /absolute/analysis.json
```

Run from the skill directory or use the helper's absolute path. `--turn` also accepts a one-based ordinal, but use the printed stable ID in the report. Output is content-free JSON: turn bounds, union durations, descendant turn context, path categories, top segments and grouped operations with source pointers, and warnings. Grouped operations distinguish exposed path time from the normalized operation's full lifetime. Descendant bounds are join candidates, not proven dependencies. The helper reports overlaps and uncovered path time; it does not assess original task-content availability, infer dependencies, or generate recommendations. No trace engine is bundled or required for the rest of the skill.

## Counterfactual arithmetic

For parallel branches with required finish times `A` and `B`, the join is `max(A,B)`. If A finishes at 21 minutes and B at 43, reducing A by 6 minutes saves 6 minutes of work and zero parent latency. Reducing B by 25 minutes yields a join at 21, not 18: A becomes critical.

For overlapping opportunities, construct one revised schedule. If a 2-minute compaction occurs entirely during a 5-minute remote queue, fixing compaction alone may save no elapsed time. Removing the queue can expose the compaction; the combined gain is not necessarily 7 minutes.

For a recurring tool improvement, local savings per invocation are `(before-after)` on equivalent work. Parent savings depend on how many invocations are exposed on the chain. Approximate migration break-even is `migration effort / recurring exposed saving`, with consistent units and uncertainty. Never infer overall savings from a vendor's speedup ratio alone.
