# Loading verification and browser benchmark

`npm run bench:browser` runs a repeatable external Google Chrome benchmark against the checked-in synthetic demonstration corpus. `npm run bench:browser -- --directory ~/.codex` explicitly opts into the real local corpus. Add `--active-only` for just active rollouts, `--limit 50` for the fifty smallest scoped files, or `--url http://127.0.0.1:5173` to reuse a running Vite development server. Without `--url`, the script starts and shuts down its own Vite server on port 5175 with HMR disabled, so concurrent source edits cannot invalidate a scan in progress. The benchmark requires generated WASM and Google Chrome; CI installs it with `npx playwright install --with-deps chrome`. `PLAYWRIGHT_CHANNEL` is an explicit override.

The harness recursively lists only `sessions/` and `archived_sessions/`, then includes `session_index.jsonl` when present. It does not upload the entire `.codex` directory or admit authentication files. Chromium receives scoped absolute paths through its file chooser protocol. Each browser `File` receives its original relative rollout path so the real `SessionStore.openFiles` path is exercised, with no JSONL body serialized through Node, copied into repository fixtures, fetched by a server, or written into the report.

Use `--archived-only` for a stable archive baseline when active agents are continually appending. Upload snapshots can become unreadable during concurrent changes; error categories and counts are retained in the report. The native directory-handle path retries once with a fresh disk snapshot when a read races an append. All standard rollout filenames are checked against their parsed session IDs so copied ancestor records cannot silently collapse distinct sessions in the benchmark.

The cold run removes this viewer's metadata cache in an isolated browser profile. The warm run rescans the same file selection to measure fingerprint cache reuse. Folder uploads do not expose stable directory identity, so their cache remains in memory; saved native directory handles retain localStorage persistence. The browser tests separately cover reconnecting a native handle and restoring its persistent cache. Earlier results below predate this distinction and used cross-upload cache reuse. Both runs use the production loader and production WASM workers. Reported throughput includes browser streaming, decoding, Rust parsing, structured cloning of metadata, and localStorage writes; it is not comparable to isolated native-parser throughput without accounting for that extra work. The operating system's disk cache is not flushed, so “cold” means cold viewer metadata cache, not cold physical storage.

After indexing, the script chooses a modest active root with many children, loads it lazily, then loads its entire discoverable graph eagerly. `--root SESSION_ID` chooses a specific known root. The report includes graph timings, counts of loaded/discovered/missing agents, warnings, errors, and total spans. It deliberately excludes session IDs, titles, model prompts, code, outputs, and personal paths.

A 10 ms main-thread timer and the browser Long Tasks API report responsiveness while WASM workers scan. The cold scan's delay statistics are listed separately from graph loading, because full trace structured cloning and analysis have different costs. These measurements expose regressions rather than enforcing hardware-dependent wall-time thresholds. Unit tests enforce concurrency, caching, deduplication, permission scoping, cancellation, and progressive graph invariants independently of machine speed.

Reports are saved under ignored `outputs/benchmarks/` by default. Use `--output` for an explicit aggregate report location. Source corpus counts can change while Codex is active; size/mtime snapshots and per-file errors make changes visible, and the UI refresh path revalidates them.

## Recorded local results, 2026-09-07

Chromium 152 on this macOS development machine, with four workers (three metadata workers and one reserved for interaction):

| Corpus                                                              | Files / bytes  | Cold metadata scan | First session | Warm metadata load      | Result                                              |
| ------------------------------------------------------------------- | -------------- | ------------------ | ------------- | ----------------------- | --------------------------------------------------- |
| Stable archived baseline after identity fix                         | 535 / 21.33 GB | 94.31 s, 226 MB/s  | 1.70 s        | 0.929 s, 535 cache hits | 535 distinct identities, no errors                  |
| Full active + archived corpus with final envelope-preserving parser | 706 / 21.69 GB | 98.20 s, 221 MB/s  | 2.78 s        | 1.195 s, 700 cache hits | 700 distinct identities; six changed file snapshots |

The stable archived graph benchmark expanded a 34.8 MB root into 76 agents and 16,201 spans: lazy root loading took 2.095 s; eager graph loading took 2.799 s with no missing agents or parse errors. The final full-corpus run expanded a different 41.5 MB active root into ten agents and 3,297 spans in 1.707 s; lazy root loading took 1.338 s.

The final full scan reported zero malformed or discarded oversized records. Its streaming lexer elided 31,808 large string payloads (18.17 GB) while retaining their event envelopes and metadata. Selected details remain accessible through the separately tested paged detail reader. A 10 ms timer observed a maximum 374 ms cold-scan delay, and the longest recorded cold main-thread task was 298 ms. Other builds and browser verification were running concurrently, so these values should be treated as a reproducible development baseline, not isolated hardware capacity.

The six failures in the full run were explicitly classified as browser file-access failures. Chromium returns `TypeError: network error` when a selected `File` changes on disk; this was independently reproduced using a synthetic temporary file. `tests/local-loading.spec.ts` verifies clear error reporting, successful recovery after a fresh selection using the same worker, and exact reconstruction of a Unicode prompt larger than 64 KiB across explicit detail pages. Native directory handles can obtain a new snapshot automatically and retry once; upload inputs require reselection. The benchmark returns a nonzero exit code when any file fails, even though successful sessions and cache measurements remain available in its aggregate report.

The cache tag at that benchmark checkpoint was `session-parser-v1-stream-6`. It invalidates metadata created before child descriptions were enriched from incoming agent prompts and actual parent dispatch operations. This metadata enrichment followed the recorded full-corpus benchmark; its targeted graph regression and type checks passed without repeating the 21 GB scan. Description fallback matches the parent and target identity and never replaces an existing child description. The current cache tag is `session-parser-v1-stream-8`; later changes corrected context source selection and suppressed encrypted task descriptions. Native corpus verification is rerun separately below as the active inventory grows.

## Later native inventory check

A later read-only native metadata pass covered 710 active/archive files and 21,771,759,409 bytes in 8.171 s (543,877 records, 3,664 turns). It preserved all 710 unique identities with zero malformed lines, skipped oversized records, identity collisions/mismatches, or invalid spans. The lexer elided 31,992 large strings while preserving their envelopes. This is a later, growing inventory and an OS-cache-dependent native measurement; it is not a replacement for the browser cache baseline above. Metadata mode does not construct spans. Use `--trace` for the full normalization benchmark.

## Quality-cleanup benchmark checkpoint

After the upload-cache identity correction, the synthetic benchmark passed in
external Google Chrome 152.0.7977.76. Four files / 17,704 bytes / 82 records took
1.391 s cold (including Vite module loading and worker/WASM initialization), then
14.4 ms to refresh the same selection with four cache hits. Eager expansion loaded
all four agents / 73 spans in 192 ms with no missing or unreadable sessions. This
tiny corpus is a smoke/performance baseline for the harness, not a bulk-throughput
measurement. The report marks the warm cache scope as `current-file-selection`.

All 20 Chrome scenarios passed after the cleanup, including actual IndexedDB
directory-handle persistence and one cached metadata hit after a page reload.
That scenario uses a real OPFS handle in the isolated origin; manual production
verification separately restored the user's granted native `.codex` directory and
loaded the real 11-agent session. The prior full-corpus measurements above remain
the bulk-loading baseline; no valid parser semantics changed in this cleanup.
