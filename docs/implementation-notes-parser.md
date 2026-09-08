# Parser implementation notes and validation evidence

## Decisions established from evidence

The first inventory found 167 active files and 535 archived files: about 21.66 GB together, including four files between 4.45 and 4.80 GB. That ruled out `File.text()` plus a JavaScript JSON parser as the general loading strategy. Both metadata and trace parsing now accept incremental UTF-8 chunks in Rust, through the same engine in native tests and WASM workers. Browser detail reads stop after the selected physical record where possible.

Reading the protocol enum alone was insufficient. Codex's persistence policy excludes most transient lifecycle events from ordinary rollouts. Paginated histories retain rich `item_completed` records with exact start and completion timestamps; older histories retain calls/results and selected legacy events. Raw token counters do not establish precise request starts or TTFT. The track taxonomy and timing rules are recorded in `session-format.md`.

The first native scan classified 2,992 old records as malformed. A separate structural inventory showed that they were valid 2025-style bare metadata, `record_type` markers, and unwrapped response objects. Compatibility handling reduced malformed-record counts to zero on the complete corpus. Those old objects lack per-operation timestamps, so they remain instantaneous observations rather than receiving invented durations.

An independent browser/filename identity comparison found another problem that aggregate record counts missed: copied ancestor `session_meta` records could overwrite the physical file's identity. The parser now locks identity to the first metadata record. The native benchmark independently checks the filename UUID, unique parsed identities, span ownership and nonnegative finite durations. The final corpus has zero identity mismatches or collisions. `subagent_history_start_ordinal` separately excludes inherited context where that boundary exists.

Production-browser QA also found that context records could claim a turn's prompt location before the title filter rejected them, leaving a correct title paired with a plugin-list prompt. Known context rejection now precedes both prompt and source-line selection, with a regression that reopens the actual source record through `DetailParser`. Generic XML such as `<request>` is preserved; literal text beginning with a reserved context prefix is treated as context because the records do not provide reliable provenance to distinguish the two. This recognition boundary is explicit in the format notes. Brief child-agent labels unwrap only the recognized incoming message transport header, while full prompts retain it.

The initial bounded reader skipped entire records above 8 MiB. Explicit byte counters showed that this discarded 512 records containing about 17.8 GB. That was unacceptable for timing fidelity, even though the read throughput looked fast. The implementation now elides individual long JSON string bodies while retaining the surrounding record, IDs, timestamps, code mode envelopes and error fields. The final full-corpus scans skip zero whole records. Their throughput numbers still describe reading and normalizing the complete byte stream, not fully materializing 18 GB of string bodies.

That normalization is distinct from access to full contents. `DetailParser` locates the original physical source/output records, returns normal prompts and code without the trace excerpt cap, and exposes large strings through pages. Tests reconstruct raw Unicode text and escaped JSON strings across all pages exactly, including chunk boundaries within quotes, backslashes and surrogate pairs. Independent review caught a presentation error: concatenating returned fields across pages repeated structured JSON wrappers, and could also repeat a short source-code field while only its output advanced. The API remains unchanged; the UI presents each returned detail object as its own page. A native/WASM regression proves that every nested structured output page remains valid JSON, short source fields remain complete per page, and the paged nested string bodies reconstruct exactly.

Path-based agents introduced another compatibility edge: a spawn call can initially name `worker`, then return `/root/worker`, then later identify a UUID. A known UUID supersedes the task-name alias; activity records and metadata map canonical paths to physical sessions. Merely seeing a task name does not justify reporting a missing UUID session. A wait timeout also does not prove a child completion join. The engine follows child work on the critical path only when a completed child turn is recorded within that wait.

Later browser checks found two separate incoming-message issues. A readable first child task description prevented later follow-ups from claiming their own turn prompt/source, and send links selected the next arbitrary target span. Prompt capture now runs independently for each turn. Send matching uses actual receive events, sender identity, optional shared correlation IDs and single-use endpoints. A regression follows a root wait into a child's wait and then into grandchild work without overlapping or double-counting path time.

A bounded check of two historical child sessions also found that their typed encrypted task bodies appeared verbatim in the parent's untyped dispatch message. The parent's fallback description displayed ciphertext despite the child correctly exposing no plaintext goal. Brief operation labels now exclude the narrowly defined transport-token shape documented in `session-format.md`; normal text beginning with the same prefix remains eligible. Path/nickname display titles provide a fallback while leaving descriptions empty for a better plaintext parent source. No decryption is attempted, and original structured source content remains available through full details.

The first bounded real-graph critical-path check still stayed entirely in the parent. Its collaboration mailbox waits omitted target IDs, and unrelated code-cell resumes were also classified as agent waits. The engine now separates `cell_id` waits into code execution. For an untargeted mailbox wait, only the recorded successful `Wait completed` outcome can consider direct children that completed during the interval; timeouts and user-input interruptions cannot. The format notes state the remaining causality limit explicitly.

## Verified checks

Independent review found that legacy tool end records exposed clipped trace output without a physical output location for full details. Exec/MCP/patch/web begin/end normalization now retains both source references, and detail extraction reconstructs each legacy format, including paged command output and failure diagnostics. Another browser regression showed event-only assistant messages were missing from the conversation projection; they now produce assistant entries with full detail support and duplicate-response suppression.

The final bounded archived-graph validation loaded 31 related sessions with no missing files. Its reconstructed critical path entered 176 child segments across five child sessions, totaling 1,296,018 ms of child work. Every path segment had a nonnegative matching duration, segments were ordered without overlap, and their durations summed to the reported total. All 246 send flows ended on actual receive spans with no receive reused; the receive selected during browser QA was linked. All 37,127 session-log entries referenced existing spans on the final 47-test engine, including event-only assistant messages. A separate active follow-up check recovered the recorded turn source and original encrypted message structure without inventing plaintext. These checks used local data without persisting payload contents in the repository.

The Rust suite contains 49 focused tests: 22 parsing tests, eleven graph/analysis tests, twelve lazy-detail tests and four session-log tests. They cover parallel and reordered tool completion, inherited ordinals and copied metadata, classic and path-based agents, malformed tails, unknown events, current model selection, rich nested command timing, skill classification, code extraction, error preservation, historical records, huge-string envelopes, split escapes, follow-up turn source locations, exact detail pagination, encrypted task labels, nested interval accounting, recursive child joins, send/receive correlation, bounded focus, missing children, cycles, timeout joins and invalid native API inputs.

`scripts/check-wasm.mjs` compares parsed JSON from the native binary against browser-target WASM for parsing, metadata, character-wise streaming, errors, agent aliases, analysis and paged details. `scripts/test-wasm.sh` builds both runtimes before running it. Rust formatting and Clippy with warnings denied are part of the validation workflow. The repository pins Rust 1.98.1 and wasm-bindgen 0.2.100; an ignored `target/local-toolchain.env` supports a local temporary toolchain without committing machine-specific paths.

## Real-corpus native measurements

The following measurements were taken on 2026-09-07 while active sessions could still grow. The OS page cache was not flushed, so these are warm/unspecified-cache measurements, not cold-storage guarantees. The benchmark reads active and archived session directories, produces aggregate counters only, and never writes session contents into the repository.

| Metric                                              |           Metadata scan | Full trace normalization |
| --------------------------------------------------- | ----------------------: | -----------------------: |
| Files / unique identities                           |               711 / 711 |                711 / 711 |
| Input bytes                                         |          21,797,677,775 |           21,797,687,356 |
| Elapsed                                             |                 8.946 s |                 10.444 s |
| Read + normalize throughput                         |            2,436.5 MB/s |             2,087.1 MB/s |
| File latency p50                                    |                 1.86 ms |                  2.05 ms |
| File latency p95                                    |                32.24 ms |                 39.78 ms |
| File latency maximum                                |                 1.261 s |                  1.493 s |
| Records                                             |                 544,862 |                  544,869 |
| Retained JSON bytes, excluding elided string bodies |           3,569,490,134 |            3,569,499,715 |
| Elided strings / original body bytes                | 32,039 / 18,228,187,641 |  32,039 / 18,228,187,641 |
| Whole records skipped / malformed records           |                   0 / 0 |                    0 / 0 |
| Identity mismatches / collisions / invalid spans    |               0 / 0 / 0 |                0 / 0 / 0 |
| Retained spans                                      |                       — |                  273,597 |
| Recorded turns                                      |                   3,684 |                    3,684 |
| Recorded child references                           |                     705 |                      705 |

These final corpus measurements include the session-log projection and the legacy detail/event-message corrections. The inventory grew from the earlier 706-file snapshot while active work continued, and trace counts changed as previously missing assistant events were retained.

The synthetic benchmark uses 10,000 unique tool calls with paired results, plus session/turn lifecycle records (20,003 records; 3.45 MB). It builds the fixture outside the timer, runs seven repetitions and reports the median, validating the completed-call count after each timed run. The final cleanup run measured metadata parsing at 22.26 ms (154.9 MB/s) and full trace parsing at 57.09 ms (60.4 MB/s), including the session-log projection. These CPU-oriented figures should not be compared directly with the much higher byte throughput of real files dominated by elided giant string bodies.

Run the read-only corpus benchmark with:

```sh
cargo run --locked --release -p session-parser --bin benchmark -- "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions"
cargo run --locked --release -p session-parser --bin benchmark -- "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions" --trace
cargo bench --locked -p session-parser --bench loading
bash scripts/test-wasm.sh
```

The benchmark also accepts the Codex home directory and then restricts discovery to its `sessions` and `archived_sessions` children. Browser loading/caching measurements are documented separately, because filesystem permission prompts, directory enumeration, structured cloning, WASM startup and rendering add costs that a native parser benchmark cannot measure.

## Code-quality audit

The cleanup retained all historical compatibility branches and all existing compatibility regression tests: each represents a distinct supported wire shape or a previously observed loading/detail/graph failure. Removing the legacy event adapters would lose ordinary archived messages and full tool output. Removing the older bare-record reader would again misclassify valid saved sessions. Paging tests separately exercise plain strings, serialized structured fields, escaping and physical-source selection; they are not interchangeable copies.

Small removals reduced duplicate logic: the native CLI now calls the shared analysis export instead of deserializing and validating the same input independently; legacy collaboration dispatch chooses its known normalized kind directly instead of calling an option-returning normalizer and unwrapping it; an unused span-index binding was removed. The benchmark's repeated single call ID was replaced by unique completed pairs so it exercises realistic call-state retention.

The audit also found a target-boundary bug: invalid detail selectors and analysis inputs constructed `wasm_bindgen::JsError` on native builds, which could invoke an unavailable JavaScript import and panic. A target-specific error alias preserves JavaScript exceptions in WASM while returning ordinary native errors. Two focused regressions cover malformed selector/analysis JSON, absent physical selectors and invalid/nonfinite analysis bounds. Valid normalized outputs are unchanged.

The workspace now forbids unsafe code, denies ignored must-use results and placeholder/debug macros, and enables standard Clippy and Rust idiom warnings. The latter caught one elided lifetime in the borrowed JSON envelope, now explicit. Formatting, 49 native tests, strict Clippy, wasm32 compilation and the paired-call benchmark were checked during this pass. Architecture and format documentation now distinguish the title-only `session_index.jsonl`, the viewer cache and Codex SQLite state, and record the current unsupported physical-history layouts without claiming broad format coverage from one successful corpus.
