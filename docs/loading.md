# Local loading and agent graphs

The page opens a browser directory picker for `~/.codex`. On macOS, **Command–Shift–G** opens “Go to Folder”; enter `~/.codex`. **Command–Shift–.** toggles hidden files. The browser requests read access. Chromium browsers expose this directory picker in a secure context, including `http://localhost`; the directory-upload input is the fallback in other browsers.

The application only requests the `sessions` and `archived_sessions` subdirectories and `session_index.jsonl`. It does not enumerate authentication, settings, database, or other files at the directory root. Uploaded directories are filtered to those same rollout scopes. Full session contents stay in browser memory; metadata for saved directory handles, including prompt-derived titles and agent descriptions, stays in this origin's localStorage. Upload metadata remains in memory for the current selection. No session content is sent to a server. The saved File System Access handle is kept in IndexedDB; browser permission remains authoritative and can require another user gesture after a restart. Directory upload handles cannot be restored. Browser storage is scoped to the whole origin, not a URL path; applications sharing a GitHub Pages origin can access the same saved cache/handles. Localhost or a dedicated hosting origin keeps that boundary explicit.

## Metadata index

The observed `session_index.jsonl` has `id`, `thread_name`, and `updated_at` string fields. It supplies titles, but does not supply turn counts, model, child references, or rollout paths. Later title rows win. Those remaining fields come from the Rust metadata scanner.

`SessionStore.openDirectory` and `openFiles` enumerate scoped files, retrieve stat snapshots with at most eight concurrent `getFile()` calls, and reuse metadata when folder identity, relative path, byte size, modification time, and parser version match. A changed parser version invalidates the cache. Directory identity is associated with the persisted handle using `isSameEntry`; upload fallback assigns a fresh identity to each selection and retains its cache only in memory. Separate same-named upload folders cannot reuse metadata, even if path/size/mtime match. Files duplicated during archival prefer the active copy. Removed paths are evicted.

The localStorage cache holds metadata only and is capped at approximately 2 MiB, retaining up to three folder identities. Least recently used entries are removed first. Quota, corrupt data, blocked storage, and unavailable IndexedDB degrade to uncached loading. No unrelated origin storage is cleared. `scan()` refreshes file stats and reloads renamed titles without re-parsing unchanged rollouts.

Cold scans start with the smallest files. Progress notifications expose completed/total files, cache hits, bytes processed, errors, and the currently available session list. This makes small sessions selectable while large archives continue to scan. Metadata scans count all supported records, rather than estimating counts from a header or tail sample. A selection can load in the worker pool while index discovery continues.

For standard `rollout-…-UUID.jsonl` names, the metadata ID must match the filename UUID. A conflict becomes a visible file error instead of silently replacing a different session. Native handle reads retry once with a fresh `getFile()` snapshot if Codex appends during parsing. Directory uploads cannot acquire a fresh disk snapshot without another selection; unreadable upload snapshots remain explicit errors.

## Rust workers and large files

`ParserPool` bounds active work to at most four module workers by default. In pools with at least three workers, one is reserved for selected sessions and details; this prevents several giant archive scans from blocking interactive requests. Interactive jobs also take priority in other available slots. A `File` reference is structured-cloned to a worker; the main thread never materializes the full JSONL text. Each worker initializes the bundled WASM module once and feeds decoded `File.stream()` chunks to `MetadataScanner` or `SessionParser`. UTF-8 sequences and JSONL records may cross chunk boundaries. The scanner keeps incomplete lines and parser state. The parser's bounded retained output and oversized-line warnings are described in the parser documentation.

This is necessary for the audited local corpus: 702 rollout files, approximately 21.66 GB in total, with the largest file approximately 4.80 GB. A whole-file `File.text()` operation cannot represent this corpus safely. Those figures describe the local inventory on 2026-09-07; no personal session contents are committed to the repository.

Workers report byte progress every 4 MiB and yield to cancellation messages. Queued work is removed immediately when cancelled. An active worker is reused only after its cancelled job acknowledges completion. Errors are surfaced per file rather than replacing valid sessions. Full traces are not cached in localStorage.

## Session graph

The UI always chooses eager loading. The lower-level `loadGraph(rootId, {mode: 'lazy'})` loads only the selected root and reports discovered children. `loadChildren(sessionId)` expands a branch. Eager mode recursively loads all descendants with bounded concurrency and a progress snapshot whenever agents start or finish. The graph includes its root, loaded session map, missing IDs, per-agent errors, number currently loading, discovered count, and completion state.

Child discovery combines persisted `childIds`, spawn operations, and index entries whose `parentId` matches the current session. This recovers children when a parent log lacks the spawn output. Communication targets alone are not assumed to be descendants. Visited and queued sets prevent repeated parsing of shared descendants and stop cycles. A new root selection aborts the prior graph, and stale completions cannot mutate the new selection. Missing or unreadable children remain explicit in graph results. The same session store supports progressively adding agents while a timeline is already visible.

Loaded child descriptions come from the child's own prompt or metadata. If absent or untitled, a matching parent spawn operation can supply its actual dispatch description. UUID and canonical agent paths identify the child; short names are accepted only within a known parent when unambiguous. Existing child descriptions are preserved, and ordinary inter-agent messages are not substituted for dispatch descriptions.

## Full selected details

Compact timeline spans keep the complete graph small. `SessionStore.loadDetails(sessionId, selector)` streams the selected file through the Rust `DetailParser` to retrieve the original selected prompt, arguments, code, or output. Physical `sourceLine`/`outputLine` references identify the records; a call ID is available as a fallback selector. A turn ID alone cannot identify a physical record. Lines are 1-based and count blank, malformed, and ignored records. Where the scanner reports completion, the worker stops reading immediately after the requested records instead of processing the remainder of a large archive.

Ordinary selections fit in one 1 MiB detail page and retain their full text. Very large selected strings use an explicit offset/pageSize with `hasMore` and `nextOffset`; this keeps multi-gigabyte outputs accessible without forcing one browser string allocation. Returned pages are displayed separately so repeated JSON wrappers and short fields remain valid; they are never concatenated into an output string. Detail requests use interactive worker capacity, remain cancellable, and are never persisted in localStorage. Selecting another detail or root aborts obsolete work. The native path reacquires a fresh file snapshot once if a read races an append.

## Validation

`tests/session-store.test.ts` covers cache reuse/invalidation, renamed index titles, scope filtering, corrupt/quota-limited storage, malformed file isolation, bounded concurrency, lineage discovery, cycles, shared descendants, missing agents, lazy expansion, and selection cancellation. `tests/parser-pool.test.ts` verifies bounded worker admission and safe reuse after cancellation. Browser and Rust benchmarks exercise the actual stream parser separately; cold scans and warm-cache loads should be recorded independently because they measure different work.
