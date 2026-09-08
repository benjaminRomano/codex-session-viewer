# Implementation log and handoff

This file records decisions and failed approaches so a later agent can resume from evidence rather than rediscovering the project. Read this together with the parser, loading, and Perfetto reference documents.

## 2026-09-07: initial implementation

- The repository started empty. The user's requested source references were available locally: Codex commit `a51608398d53b6d23ed98b8287de415b35f1eea5` and Perfetto commit `f8a7eeaac8f34dba9ce29950716b6012cfee8da2`.
- Work was divided into Rust format/parsing, browser loading/cache/graphs, timeline rendering/interactions, and application integration/analysis/CI. The TypeScript shape was written first to keep those boundaries concrete.
- The Sites scaffold was initially requested in the repository while agents began writing their files. It refused the now-nonempty target. A temporary scaffold supplied React/shadcn dependencies; the application uses a plain Vite static entry point because the requested product requires no SSR, Cloudflare backend, account, or networked persistence. Starter server packages were removed. No Sites registration or deployment was performed.
- The scaffold's Vite version had published vulnerabilities. It was updated to 8.2.2; the subsequent npm audit reported zero vulnerabilities. The committed lockfile records the tested dependency graph.
- Rust on PATH was originally 1.75 with no WASM target. A current Rust toolchain and matching wasm-bindgen CLI were installed in temporary task directories rather than changing the user's global toolchain. Build setup and the local override are documented by the parser notes; machine-specific paths must not be required in CI.
- An early design assumed a few hundred moderate JSONL files. Disk inventory instead found about 21.7 GB, including four 4.4–4.8 GB archives. The loader was therefore implemented around `File.stream()` and incremental Rust state, not `File.text()`.
- The format audit found modern `item_completed`, token usage, inter-agent metadata, path-addressed collaboration, and 2025 unwrapped legacy formats. Session titles alone live in `session_index.jsonl`; it does not replace the Rust metadata scan.
- Critical-path/flow analysis was first prototyped in TypeScript to establish the interface. Following the user's requirement that Rust own the core logic, it was ported to the Rust crate and invoked through an analysis worker. Native/WASM parity passed; the TypeScript prototype and duplicate tests were removed.
- Synthetic demo IDs originally used `demo-*` labels. That obscured the UUID-vs-canonical-path distinction in real dispatch handling. Demo files now use reserved synthetic UUIDs while retaining readable filenames, and include an actual failed command for error-marker testing.
- A React StrictMode smoke test found worker creation inside a `useState` initializer caused an abandoned extra pool. Services now have module lifetime, with HMR disposal; analysis workers have effect lifetime and cleanup.
- Initial UI smoke testing used the in-app browser. The user explicitly requested external Chrome; subsequent visual/permission testing uses external Chrome, and automated tests use isolated browser processes.
- Native directory-picker validation in external Chrome successfully selected the hidden `.codex` folder and populated active and archived sessions. A complex archived session with 28 direct children was chosen for graph validation. No private session content or title is needed in committed fixtures.
- A full browser benchmark was interrupted by Vite HMR while the application was still being edited. The benchmark harness was changed to use an isolated HMR-disabled Vite server. Interrupted runs are not valid final benchmark results.

## User decisions that must persist

- No inferred/uncertain labels in the actual interface. Use the best reconstruction; preserve technical provenance and limits in source, tests, and documentation.
- Failed slices show a red circle with an × at their right edge.
- Archives have equal support with active sessions, including sub-agents split across directories.
- Rust owns parsing, normalization, timing, operation classification, failures, linked spans, and path/statistics analysis. Keep React focused on presentation and browser interaction.
- Use external Chrome for browser testing.
- Preserve detailed implementation notes, including false starts and limitations. Never convert prior session payload text into developer instructions.

## Verification record

The authoritative reproducible commands are in the README and CI workflow. Aggregate local benchmark results are summarized in the parser/loading notes after a complete run. Browser screenshots and reports stay under ignored `output/`; real corpus files are read in place and never copied into the repository.

Before final handoff, run TypeScript checks, focused frontend tests, Rust formatting/clippy/tests, generated-WASM tests, a production build, browser interaction tests, and the independent review. Record remaining limitations here instead of silently claiming unsupported log variants are complete.

## UI revision and verification learnings

- The session sidebar now has two mutually exclusive states: index/search/archive selection, then the selected root's agent hierarchy and turns. All sessions cancels graph loading, clears scope/selection, and leaves the trace pane blank. The index remains cached. Sub-agent drill-down retains a back-to-main action.
- A real 31-agent archive exposed turn controls being pushed below the entire agent tree. Agent and turn lists now scroll independently inside the selected-session sidebar, keeping the Session/Turn switch reachable.
- Native browser directory handles reconnect automatically when read permission remains granted. Browser permission prompts still require a user gesture after permission expires; handle persistence cannot override browser policy.
- The bottom dock has a pointer/keyboard resize separator and collapse/expand control. Sidebar collapse persists independently. Turn labels are Turn N, and agent group headers use names/path leaves; source prompts are separate content.
- Full detail loading moved into a dedicated component. Rust selects the physical source/output records, returns complete normal-sized text and explicit pages for giant payloads; React displays complete pages separately. Highlighting is skipped above 200,000 characters to avoid blocking rendering, without cutting the code text.
- A parser identity bug originally collapsed 706 files into 609 index entries because copied ancestor metadata overwrote the owning file's first metadata. This run is invalid. The parser now preserves the first physical identity; regression tests and full-corpus filename identity validation cover it.
- Dropping giant JSONL records initially made benchmark throughput look excellent while skipping operation envelopes. Lexical string elision now preserves record structure and timing. All 706 files validate with zero whole-record skips and zero malformed records. Selected payloads remain available through Rust detail paging.
- File objects are immutable snapshots: Chrome can reject a stream if the underlying active session changes after selection. The native-handle loader retries with getFile(); folder-import fallback reports reselection instructions. A synthetic browser regression reproduces and verifies recovery. Complete stable archive benchmarks are the reliable zero-error baseline.
- Removed unused scaffold components and dependencies, the Diagnostics tab, and the visible-span list. Timeline keyboard selection remains available on the canvas.

## Earlier automated verification (before Session Log)

- `npm run check`: TypeScript, frontend unit suites, and Rust tests pass. At this checkpoint the engine had 32 focused parsing/analysis/detail tests; the loading pool has 21 tests and the Perfetto port has 8 tests.
- `bash scripts/test-wasm.sh`: native/WASM parity passes for traces, metadata, incremental UTF-8 input, analysis, and full-detail pages.
- `npm run build`: production builds pass; the final bundle has a roughly 422 KB WASM module (153 KB gzip). `npm audit --audit-level=high` reports zero vulnerabilities.
- External Google Chrome E2E: the original 14-scenario suite passed, then the added structured-output scenario and changed full-prompt scenario passed focused reruns. At this checkpoint the suite had 15 scenarios. Coverage includes active/archive import, title index, back-to-blank session navigation, independent sidebar/dock collapse, dock resizing, cache reuse, lazy descendants, complete >100 KB Unicode prompt rendering, native/WASM equivalence, changed-file snapshot recovery, multi-span/area selection, zoom/pan/overview/keyboard behavior, linked spans, failure glyph pixels, and thousands of overlapping slices.
- Early application test attempts used eight Chrome workers while the development server and 21 GB scan were active. They hit short waits and one test clicked the background example button before the modal appeared. Tests now scope that action to the dialog, wait for loaded graph state, use two browser workers, and run on an isolated HMR-disabled Vite server (5177). The development viewer remains on 5173.
- The native parser normalized 706 real files / 21.69 GB / 222,045 spans in 10.38 seconds, with zero malformed records, skipped envelopes, identity mismatches, or invalid spans. Native metadata scanning took 7.78 seconds. These are local OS-cache-dependent measurements, not portable performance guarantees.
- Stable archive browser baseline: 535 files, 94.3 seconds cold and 0.93 seconds warm; no errors. A 76-agent graph loaded eagerly in 2.8 seconds. The active corpus was changing during the full browser scan; six immutable File snapshots failed explicitly. See the loader notes for the complete report and native-handle recovery behavior.
- A final local review extended native snapshot retry from indexing/details to graph loading. One fresh handle snapshot is retried; immutable uploads and cancellations are never retried. Regression tests cover success after append, a second failure, and upload behavior.

## Independent review corrections

The independent GPT-5.5 xhigh review found two P2 issues. Both were fixed: cache/export copy now explicitly names prompt-derived titles and agent descriptions, and the detail pane displays each returned page separately. Concatenating structured pages was wrong because JSON wrappers and unchanged short fields repeat on every page. Native and WASM regressions cover nested structured outputs, independent long string fields, and repeated short source code. A browser regression validates every displayed output page as JSON and reconstructs the long payload for comparison.

Two smaller review findings were also fixed: external Google Chrome is the default in the local and CI browser gates, E2E rebuilds WASM before testing to prevent stale parity checks, and dismissing an analysis error now clears the hook's error state as well as application errors.

The final visual check uses the production preview at `127.0.0.1:5173`. A development-server log audit explained earlier interrupted manual selections: Vite watched generated Playwright HTML reports and reloaded the app when tests wrote them. `server.watch.ignored` now excludes output/, outputs/, and target/; tests also keep their isolated HMR-disabled server. To resume development, stop the preview process and use `npm run dev`.

A final real archive inspection found a prompt/source mismatch that synthetic plain-user fixtures did not catch: `title()` recorded the first user-role context block as Turn.prompt before filtering it out of the title. The title then reflected a later real request while full detail loading read the earlier context line. The parser now checks auxiliary context before capturing the prompt; a browser full-prompt fixture also includes an auxiliary recommended-plugins record before the real request. This is why visual QA on real archives remains part of the verification workflow.

The correction recognizes known Codex context wrappers instead of rejecting all XML, so genuine XML requests remain selectable. Brief agent descriptions unwrap recognized incoming-task envelopes; full source details retain the original envelope. Metadata cache version 7 invalidates earlier descriptions once. Native/WASM parity now also verifies that context filtering chooses the actual request's physical source line and that lazy details retrieve that same request.

The final full-prompt Chrome regression passed in 25.4 seconds including browser setup, and the rebuilt production bundle passed TypeScript checks. A preceding five-scenario application run completed all assertions but waited at process shutdown; interrupting its helper printed `5 passed`. The subsequent targeted regression exited cleanly. Treat assertion results separately from test-runner cleanup when investigating browser process issues.

The earlier independent review reran all 32 Rust tests, 29 frontend tests, formatting, strict Clippy, and native/WASM parity. It found no blocking issue and one documentation boundary: literal prompts beginning with reserved context prefixes are indistinguishable from injected wrappers. The format and parser notes now state that limitation instead of claiming all XML is preserved. Production Chrome inspection then confirmed the real archived turn prompt and 31-agent hierarchy; All sessions cleared the trace, and saved directory permission reconnected after reload.

The final archive view also exposed two child descriptions that looked like encoded noise. A bounded source comparison showed these were encrypted task messages, not compaction artifacts: child transport envelopes had empty plaintext payloads and explicit encrypted-content blocks; parent spawn messages contained the same ciphertext. No plaintext goal was recoverable from those files. Brief labels should omit recognized encrypted payloads, while source details preserve them. Recorded task-path names provide useful fallback titles when no readable title exists, leaving the description unset so a later plaintext parent dispatch can still take precedence.

## Later UI refinements and Session Log

- The initial session index now hides child sessions, using Rust-provided parent IDs, child IDs, and agent paths. Active and archived roots remain selectable. Child sessions appear only in the selected hierarchy.
- Removed the eager/lazy selector and Load descendant agents button: the browser UI always loads the graph eagerly. The library's lazy API and benchmarks remain useful and supported.
- Replaced branch/PR-style agent icons with agent icons and distinct message icons for turns.
- Removed the entire timeline button toolbar and bottom visible-duration status strip. Keyboard controls remain; F immediately centers selected spans at 80% width, and orange flow arrows are 2px/3px.
- Reproduced the reported WASM magic-word failure independently: a missing hashed binary URL on Vite preview returned HTTP 200, Content-Type text/html, starting `<!doctype html>`. This happens when an open page references an asset removed by a later build. Builds now preserve prior hashes; both workers explicitly fetch and validate WASM and can retry after a failed initialization. Unit and browser regressions exercise HTML responses and recovery.
- The later-turn detail failure had two contributors: a browser request used a turn ID without a physical detail selector, and the parser previously guarded per-turn incoming prompts with the first agent-description assignment. The frontend now requests details only with actual source/output/call selectors; Rust owns capturing each incoming prompt.
- Session Log entries are derived in Rust and reference span IDs, with distinct call/result phases. The UI presents bounded pages and on-demand complete details, and synchronizes entry hover and activation with the canvas.

The first combined 19-scenario Chrome attempt completed ten scenarios successfully, including top-level/archive navigation, eager loading, WASM HTML-response recovery, native/WASM parity, and log hover/click/phase behavior. The two test workers then stalled without active browser child processes and stopped reporting progress. After bounded inspection the exact test processes were terminated. This interrupted run is not reported as a complete passing suite; remaining and changed scenarios require a fresh run. A ten-minute global timeout now bounds CI/test-runner hangs in addition to individual test timeouts.

User feedback on the initial Session Log clarified that clicking should preserve zoom. The first implementation reused F-style 80% fitting, which made instant messages look like all surrounding work disappeared. Click now pans/selects at the current zoom; F remains explicit zoom-to-selection. The later styling pass makes the dock a denser feed and narrows track labels.

## Current verification checkpoint

The current suite contains 19 external-Chrome scenarios and 33 frontend unit tests. Before the archive detail follow-up, all 45 Rust tests and native/WASM parity passed. Historical counts above describe earlier checkpoints, not the current suite.

A fresh focused Chrome run confirmed five timeline scenarios, but two log checks failed: the example's legacy `event_msg.agent_message` was not represented, and an older fixture version had insufficient entries for pagination. The global time limit then prevented two remaining timeline cases from starting. These are not passing log results. The legacy assistant event needs engine support; the pagination fixture now uses canonical assistant response records. Focused reruns are required after the engine fix.

The independent reviewer also reproduced empty full-detail pages for legacy tool begin/end events. Archived tools must provide source/output record selectors and corresponding detail reconstruction. A successful clipped preview is not evidence that full details work. This correction is tracked in the parser notes.

The remaining two timeline Chrome cases (3,000 overlapping slices with scrolling/resizing, and keyboard selection without a duplicate list) and the large structured-output browser case passed in a clean focused run: 3/3 in 1.9 minutes. Together with the preceding five passing timeline cases, all seven current timeline scenarios have passed. A real production Chrome inspection confirmed that clicking a message retained 4,941 spans, 11 agents, and exactly the same viewport start/end; the compact feed and 150 px labels were visible and the browser reported no console errors.

## Feedback audit and task tracking

`TASKS.md` is now the canonical feedback checklist, covering every user request from the initial architecture through the compact Session Log and toolbar removal. The follow-up screenshot still showed the removed Fit toolbar, lazy/eager selector, old ruler copy, and raw WASM compilation failure. Current source and the freshly loaded production Chrome page no longer contain those elements; existing documents must reload to use updated code. Keeping old hashed assets available prevents worker failures but cannot rewrite JavaScript already executing in an old tab.

The audit found three smaller behavior gaps: repeating a log focus after a dock-tab roundtrip could reuse a consumed nonce; noninteractive log-body clicks did not focus; and keyboard dock resizing lacked the pointer path's upper bound. These receive focused browser coverage. Index counts also only included direct children; they now traverse Rust-provided canonical parent/child relationships to count unique recursive descendants, including archived and referenced-but-missing children, with cycle/dedup protection. This is presentation bookkeeping over the normalized index, not JSONL interpretation.

On the final legacy-event engine, `npm run check` passed TypeScript, 33 frontend tests, and 47 Rust tests. Expanded native/WASM parity passed, including full legacy tool details and event-only assistant messages. The production engine was rebuilt to a 484.72 KB WASM asset (172.34 KB gzip). The later subtree-count regression increases the frontend suite to 34 tests; its final run is recorded below.

The final independent GPT-5.5 xhigh review completed with no findings after the legacy-details and interaction fixes. It reran 47 Rust tests, 34 frontend tests, TypeScript checks, formatting, strict Clippy, and synthetic native source/output/call-ID detail probes. The final production build passed. External Chrome was refreshed and independently checked for zero toolbar nodes, no old ruler copy, 150 px track labels, exactly 60 mounted log entries, and no error banner. The complete 19-scenario Chrome run remains the last automated gate at this checkpoint.

## Final complete verification result

All 19 external Google Chrome scenarios passed in the final combined run, which exited with code 0 (7.6 minutes including cleanup). This includes all current sidebar/turn/archive/loading behaviors, bounded keyboard/pointer dock resizing, structured full-output pages, native/WASM equality, stale HTML/WASM response recovery, UTF-8/file snapshot recovery, paginated Session Log full content, repeated/body log focus and text-selection preservation, all timeline shortcuts/flows, failure glyph pixels, and 3,000 overlapping spans. Final frontend count is 34, Rust count is 47; production build, native/WASM parity, fmt/clippy, and independent review also passed. `TASKS.md` has no outstanding implementation or verification item.

### Why some local Chrome runs lingered after the assertions

The final run exposed the cleanup cause concretely. Both Playwright worker processes had no browser children but retained two local output sockets. `lsof` peer ownership traced those sockets to eight GoogleUpdater wake/crash-handler processes spawned by the test browsers; the updater processes had inherited stdout/stderr and detached. Closing only those eight identified test-owned helpers released the pipes, allowing Playwright to print `19 passed` and exit normally with code 0. No test worker was killed in this final run, and no assertion failure was suppressed. Earlier interrupted runs remain recorded as interrupted.

Do not implement broad process-name killing as a workaround: a user's other Chrome/updater processes may be unrelated. When this local macOS issue recurs, first verify the peer sockets/process lineage for the affected test workers. The repository's browser CI runs on Linux; this local updater behavior does not establish a CI failure. The global test timeout remains bounded so unattended jobs cannot wait indefinitely.

The final engine's focused real-archive recheck loaded 31 sessions with no missing children. Its critical path includes 176 segments across five child sessions; all 6,377 segments are ordered, nonoverlapping, and sum exactly to the reported total. All 246 send flows end on receiving message spans without endpoint reuse, and all 37,127 log entries point to valid spans. Aggregate full-corpus timings and inventory changes are recorded in the parser notes.

## Code-quality review and cleanup

The later quality request added pinned ESLint, typescript-eslint, React hook checks,
Prettier, Knip and editor defaults. Application TypeScript receives type-aware
linting; the compiler also rejects unused locals/parameters and switch fallthrough.
Rust now has an inherited workspace lint policy and remains subject to strict
Clippy and rustfmt. `npm run check` is the single local static/unit/native gate.
The initial formatter check identified 41 files with inconsistent formatting;
the whole supported source tree was formatted after agents finished editing.

The cleanup removed the unused one-off demo generator, unused exports and selector
fields, the obsolete optional WASM detail-parser shim, the duplicate critical-ID
fallback, unused layout fields and flow arguments, seven dead CSS rules and 27
shadowed declarations. Hook dependencies and callbacks now have explicit stable
ownership. Removed tests were duplicate absence assertions or assertions of an
unused getter; interaction scenarios and archive/parser compatibility regressions
were preserved. Retained lazy loading is a core API and benchmark behavior, not a
remaining UI option.

The Rust audit found a real error-path defect: native exports constructed
`wasm_bindgen::JsError`, which can call JavaScript imports and panic outside WASM.
Target-specific errors now return Rust errors natively and ordinary JavaScript
errors in WASM. Two native regressions cover invalid selectors and analysis input;
the parity harness also checks JavaScript errors versus WASM traps and clean native
CLI failure. The parser benchmark now pairs 10,000 distinct calls with results;
the earlier repeated-ID workload overwrote call state and underrepresented trace
work. These changes do not change valid normalized metadata or require a cache
version bump.

Independent review identified the upload cache's ambiguous folder identity.
Using an upload root name plus path/size/mtime could reuse metadata from a different
same-named folder. Uploads now receive a fresh selection identity and keep metadata
only in memory for refresh; saved native directory handles retain persistent
localStorage metadata and IndexedDB identity. Legacy `upload:*` cache entries are
discarded, including before a later native save. Tests cover identical file stats
with different contents, upload/native isolation, and current-selection refresh.
A Chrome regression uses a real structured-cloneable OPFS handle to exercise
IndexedDB restoration, permission checks and persistent metadata after reload.
It does not replace the separate manual verification of the granted `~/.codex`
directory.

The browser benchmark now defaults explicitly to external Google Chrome instead
of choosing bundled Chromium when installed. Its warm metric is explicitly a
rescan of the current uploaded selection; previous cross-upload persistence
measurements remain historical results. Native-directory persistence has separate
browser coverage. Dependency installation and audit use the package lock; the
final advisory check reported zero vulnerabilities.

CI now includes the complete frontend quality gate in addition to the existing
native/WASM/browser tests. Manual Pages publishing calls that reusable verification
workflow and deploys its successful static artifact, rather than rebuilding
without the same checks. Jobs have bounded timeouts and commit-pinned actions.
No hosted workflow or deployment was triggered locally. Architecture, repository
ownership, thread/index/rollout schemas, supported persistence modes and format
limits are expanded in the architecture/format docs; `contributing.md` describes
the gates and the policy for retaining meaningful tests.

At this checkpoint, all static checks, 36 frontend tests, 49 Rust tests, the
production build and expanded native/WASM parity pass. Completed Chrome and benchmark results follow below. The independent quality
review found no blocking source-level issues; its documentation follow-ups were
folded into the final publication pass.

The final quality-cleanup Chrome run passed all 20 scenarios and exited with code
0 in 6.2 minutes. The same updater pipe issue recurred; exact socket peer ownership
identified this run's eight helpers, and closing only those helpers allowed normal
runner completion. The new saved-handle reload/cache scenario passed. The external
Chrome benchmark also exited with code 0; its current-selection cache timing is
recorded in the loading notes. Production Chrome loaded `index-CohFx-n3.js`,
restored the saved directory automatically, and displayed the real 11-agent /
6,553-span trace with 60 mounted log entries and no alerts. The WASM build is
484.72 KB. Local documentation links, final formatting, and unused-code checks
also pass. Hosted CI and deployment remain unexecuted.

## Final selection, flows and dock polish

The initial selection outline could disappear against tiny spans. Selection now
has a white halo and dark outline with an 8 px minimum marker; failure circles
are drawn afterward to remain visible. Flow visibility has two independent
preferences: `<` toggles selected-span links and `>` toggles all links. Selected
links start enabled; all links start disabled. Bracket navigation enables selected
links without exposing every relationship. No toolbar was reintroduced.

Critical-path activation now uses the same select-and-center operation as the
log. It retains the active tab and current zoom, with full span details in the
right pane. The old generated advice and repeated operation totals were removed
from that pane; aggregate statistics remain in their own tab. Both grid columns
have zero intrinsic minimum widths so long code/output cannot enlarge the dock.
The Statistics footer copy was removed and track labels use the same readable
names as the timeline.

The README now introduces the local inspection use case, workflow, keyboard
controls, setup and reproducible verification commands. A privacy note explicitly
states that browser caches and directory handles belong to an entire origin:
sharing a Pages origin with other apps also shares that storage boundary.

The final browser pass exposed two additional issues before publication. First,
synchronous virtual-row measurements changed the scroll extent during a
ResizeObserver delivery, producing an undelivered-notifications error. TanStack's
animation-frame measurement option moves those changes outside the observer
cycle. The large-log scenario now requires no page errors during resize,
expansion, paging and collapse.

Second, a large structured-output test timed out after the new, narrower Critical
Path details pane displayed multiple pages. Isolating the test passed near its
90-second limit, so increasing the timeout would have hidden a product problem.
An independent external Chrome probe without tracing measured a single wrapped
1 MiB JSON string at 36.3 seconds of layout at 495 px width (29.7 seconds at
595 px). Rendering the same text in 16 KiB blocks took 0.78 seconds. The detail
view now bounds paragraph layout with presentation blocks for large plain text,
while retaining Rust's existing content pages and all recorded characters.
`Intl.Segmenter` keeps grapheme boundaries intact. Contained selections copy
`Range.toString()` so visual block separators never enter full or partial copied
text; the browser regression checks copying across a block boundary. Small text
and normal syntax highlighting retain their existing rendering.

Final publication checks retain the 49 Rust and 36 frontend regressions. Native/
WASM parity, strict Rust/TypeScript quality gates, the production build and npm
audit passed. The first full 20-case Chrome run passed 19 cases and identified
the large-output timeout above. All four affected Chrome scenarios were rerun
with the rendering correction: complete prompts, structured output with exact
cross-block copy, log/timeline navigation and the 4,000-entry virtual list. No
ResizeObserver errors remained. The independent final review found no issues.

The synthetic native benchmark measured 10,000 paired calls (3.45 MB) at 21.43 ms
median for metadata and 52.79 ms for traces. The final external Chrome loading
benchmark indexed four demo files with no errors, 1.703 s cold and 17 ms warm
within the same upload selection, with all four descendants loaded. These local
measurements include worker initialization and machine load; they are not fixed
CI performance budgets. The full real-corpus baseline remains documented above.

## Initial repository publication

The initial source commit was pushed to `benjaminRomano/codex-session-viewer` on
`main`. Publication included exactly 80 text files, with no real session data,
local paths, screenshots, reports, generated WASM, build directories or browser
profiles. Gitleaks 8.30.1 reported no leaks. The manual private-data pattern scan
found only the documented transport-shaped fixture in two tests; decoding it
verified sequential synthetic bytes 0–63, not an encrypted user payload. The
staged file hashes matched the scanned snapshot. Both commit identities use the
GitHub no-reply email instead of the configured personal address.

The push starts the hosted verification workflow. Its status is distinct from
the local checks recorded above and can be inspected in GitHub Actions. No draft
PR, release or Pages deployment was created. The final local Chrome page was
refreshed to the optimized build: selected-only flows, no toolbar or alert, and
14 mounted entries for a real log containing more than 7,500 entries.

## Hosted verification follow-up

The first completed hosted run passed Rust on Linux/macOS, all 36 frontend tests,
native/WASM parity and all 20 Chrome scenarios, then failed the standalone browser
benchmark before it selected any files. Its log confirmed a ten-minute
`page.goto(..., waitUntil: 'networkidle')` timeout. The development application's
background network activity is not a valid readiness signal for this benchmark.
The benchmark now opens an empty document on the Vite origin, imports the store
and parser modules explicitly, and waits only for DOM readiness with a bounded
startup timeout. It no longer mounts a second application's idle workers alongside
its measured pool. Startup milestones contain no session content, and the
synthetic CI benchmark has a separate three-minute step limit.

Inspection also found an independent worker failure loop: an idle parser worker
that failed to load immediately spawned another worker, even with no queued work.
Failed slots now retire and recreate capacity only when an eligible job needs it.
Active failures reject their job and advance the queue; failed constructors also
settle queued jobs instead of leaving them pending. Three focused regressions
cover idle failure, active/queued failure with cancellation, and constructor
failure. This brings the frontend suite to 39 tests; Rust remains at 49. No
evidence establishes that this loop caused the hosted navigation timeout.

The follow-up passed strict TypeScript/Rust quality gates, the production build,
independent review and all six affected Chrome engine/local-loading scenarios.
The local macOS run again required cleanup of verified test-owned updater pipes
after its assertions passed; the runner then exited successfully. The isolated
synthetic browser benchmark completed with four files, four warm cache hits, all
four agents and no errors: 1.575 s cold, 20.8 ms warm and 166.5 ms for the eager
graph. Hosted results are recorded by the verification workflow on the follow-up
commit.

## Scroll anchoring after the hosted retry

The next hosted run completed every job, including the repaired benchmark, but
its detailed report showed the large virtual-log resize scenario passed only on
retry. The synthetic trace showed a persistent jump of several hundred rows when
narrowing the feed with a long expanded prompt retained above the viewport.
TanStack's default remeasurement policy skips above-viewport compensation during
backward scrolling. That policy also skipped the retained prompt's large width
change; waiting for scrolling to stop did not restore the lost position.

The log now preserves the first-measure policy and compensates remeasured rows
entirely above the viewport regardless of the last scroll direction. Rows that
span the viewport still do not shift it as their bottom grows. The existing
resize regression explicitly combines upward scrolling with a width change and
keeps its mounted-row, position, overlap and full-payload assertions. CI now fails
on flaky browser tests, even when their retry passes, so this class of regression
cannot be hidden by an otherwise green workflow.

The compensation predicate alone was insufficient: two of three local attempts
still jumped, and React reported nested `flushSync` calls during ref measurement.
Disabling synchronous React flushes removed those errors and the large jump, but
the anchor still drifted by 385 px after waiting for measurements. Keeping that
failed approach would have concealed a smaller version of the same bug.
The asynchronous-only version updated the size cache and scroll offset before
recomputing row positions. Subsequent observer callbacks compared old positions
against the new offset and incorrectly compensated rows below the anchor.

The final layout uses TanStack's direct DOM update mode for the sizer height and
row positions, with React continuing to own row contents and the mounted range.
React no longer writes competing height/transform styles. Measurement callbacks
update the scroll extent and positions together before scheduling any required
React render. The regression also rejects console errors and polls the unchanged
80 px anchor bound until deferred measurements settle.

With that layout ownership, the strengthened 4,000-entry Chrome scenario passed
three consecutive runs with retries disabled (46.3 s, 43.7 s and 39.8 s). All
mounted-row, anchor-position, overlap, exact content and console-error assertions
passed. The full quality checks still pass: 49 Rust tests, 39 frontend tests,
strict lint/format/unused-code checks and the production build.
The separate log/timeline hover, selection and content-phase scenario also passed
(38.3 s), and the independent final review found no remaining issue.

## Vercel delivery and verified artifacts

The later request adds a hosted website and automatic deployment to the earlier
source-only publication scope. A separate `codex-session-viewer` Vercel project
uses a dedicated production origin. The old manual Pages workflow is removed;
the existing Verify workflow publishes only after both Rust platform jobs and
the browser job pass, using the same-run static artifact. Pull requests have no
deployment job or deployment credentials. Main runs are serialized and a final main-SHA check skips obsolete queued runs
or retries, so an older run cannot publish after a newer run. The GitHub production environment also
restricts deployment to main.

The deployment wrapper stages outside the checkout, builds Vercel Output API v3
configuration directly, and sends only prebuilt static output. This avoids a
second remote build and any upload of ignored local corpus, reports or source.
The packager validates the exact synthetic demo bytes, static filename allowlist,
regular-file status and WASM magic. It refuses existing stages. Immutable cache
headers match only existing hashed files, so missing assets do not receive a
one-year cache policy. HTML revalidates and there is no SPA fallback.

The live checker reads every file plus the root document, compares hashes and
lengths to the tested artifact, validates MIME/security/cache headers, and probes
a missing WASM URL for 404. It rejects redirects, including login pages. Network
work has four workers, per-request deadlines, a total deadline and bounded retry
for transient readiness failures. A failed smoke check marks the job failed;
rollback remains explicit because production may already have been published.

Setup findings: the project-create endpoint rejected `nodeVersion`, so creation
uses only name and the static framework selection; no server runtime is needed.
The default Vercel protection is standard protection, which keeps generated
URLs authenticated while allowing the assigned production domain. Automatic
approval review rejected disabling protection; that action was not performed.
The implementation uses the production domain without changing those defaults.
A one-year project-scoped deployment token was created and piped directly into
GitHub's production secret, without writing or displaying its value. The existing
local CLI authentication was used through the CLI, never read from its files.

The HTTP verification tests also exposed a fixture cleanup problem under denied
loopback binding: a listen promise without an error handler could hang setup.
Fixture startup now rejects bind failures and teardown handles a server that
never started. Tests must run with local-server permissions in this environment.

Local verification passed strict TypeScript/ESLint/Prettier/Knip, 61 frontend and
deployment tests, 49 Rust tests with fmt/Clippy, the production build and
native/WASM parity. Dependency audit reported zero vulnerabilities. The exact
85-file publication snapshot passed Gitleaks and the independent review's
private-path/generated-file audit. Independent source review found no issues.

The first production deployment used the artifact from successful Verify run 34178722895. All 10 public files matched its bytes and passed MIME/security/cache
checks; the root document and missing-WASM 404 check passed. External Chrome
loaded the synthetic four-agent/73-span trace through WASM, opened the 63-entry
virtual log, and focused a log operation while retaining the other timeline
spans and the Log tab. The production domain is publicly accessible with
Vercel's original protection settings unchanged. Automatic publication is
verified separately by the next main-push workflow.

The first automatic Verify run (34180441903 on 0d21580) passed both Rust jobs,
61 frontend/deployment tests and native/WASM parity, then failed the existing
4,000-entry log resize test on both attempts. The captured reading anchor was
unmounted after narrowing the feed during upward scrolling. The other 19 Chrome
tests passed. App source and dependency versions were unchanged from the prior
successful run, exposing a remaining timing-sensitive resize defect. Deployment
was correctly skipped; the manually published, previously verified site remains
online. This must be repaired rather than weakening the assertion or retry gate.

The retained synthetic prompt's resize increased the virtual container from
365,007 to 399,806 pixels, while scrollTop moved from 182,473 to 182,640 (only 167 px).
The expected reading row 1987 (span 1939) was replaced by a range around row 1601
for at least five seconds. The content height changed, but the corresponding
scroll compensation was lost; this is stronger evidence than a missing locator
alone. The package/deployment changes did not alter application source.

A separate application-owned resize anchor was considered, but instrumentation
identified a smaller cause in the existing observer: TanStack's scroll-idle
debounce replays its cached last native offset. Resize compensation can already
have moved the DOM/internal position before the browser delivers the next scroll
event. Replaying the old offset resets the virtual range; a subsequent small
measurement can overwrite the large compensation. A controlled local old-code
run logged cached 182,473 versus actual 210,112 after 27,342 px of retained-row growth,
then failed on the same span 1939 anchor as CI in 36.3 seconds. Temporarily holding
native notifications through the assertion prevents accidental recovery from
hiding this broken ordering. The regression retains the original mounted-row,
80 px anchor, overlap, complete-payload and console-error checks.

The final change adapts TanStack's offset observer only for idle notifications:
it reads the live element scrollTop instead of replaying the cached event offset.
Native scroll notifications and the library's subscription cleanup remain intact.
This avoids a second application-owned anchor state machine. Existing direct DOM
geometry updates, deferred measurement and above-fold policy remain necessary
for the separate failures documented earlier.

The strengthened external Chrome regression passed three consecutive runs with
retries disabled (39.6 s, 44.3 s, 42.4 s), after the old code failed the same controlled
ordering in 36.3 s. All original anchor, overlap, mounted-row, full-payload and
console-error assertions remain. Strict frontend quality checks and all 61 tests
pass. Independent focused review found no issues; Linux CI remains the final
automatic publication check.
