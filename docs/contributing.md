# Contributing and quality gates

Read `TASKS.md` for current requirements, `architecture.md` for ownership, and
`session-format.md` before changing JSONL interpretation. The implementation notes
record rejected approaches, measured limits, and verification evidence. Keep them
current when a bug changes the model or a user changes expected behavior.

## Local verification

Use Node 24 and the Rust/wasm-bindgen versions pinned in the README. On a fresh
checkout, run `npm ci` and `npm run build:wasm` before type checks: generated WASM
bindings are deliberately not checked in.

| Command                     | Gate                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`         | Strict TypeScript, including unused locals/parameters and switch fallthrough.                                                         |
| `npm run lint`              | ESLint recommended rules, type-aware rules for application TypeScript, consistent type imports, React hook ordering and dependencies. |
| `npm run format:check`      | Prettier for TypeScript, JavaScript, CSS, JSON, YAML, HTML and Markdown.                                                              |
| `npm run check:unused`      | Knip unused files, exports and dependencies.                                                                                          |
| `npm test`                  | Frontend loader, worker, layout, navigation and index regressions.                                                                    |
| `npm run check:rust`        | Rustfmt, Clippy with warnings denied, and all Rust tests.                                                                             |
| `npm run check`             | All gates above, in one command.                                                                                                      |
| `npm run build`             | WASM generation, TypeScript and the production bundle.                                                                                |
| `bash scripts/test-wasm.sh` | Native/WASM JSON parity, streaming, analysis and full details.                                                                        |
| `npm run test:e2e`          | External Google Chrome against an isolated local server.                                                                              |
| `npm run bench:browser`     | Synthetic browser load/refresh/graph timings with production workers.                                                                 |

Use `npm run format`, `npm run format:rust`, and `npm run lint:fix` to apply
mechanical fixes. Inspect the result; a passing formatter does not validate
behavior. The build, tests and tools use lockfiles and exact dependency versions.

ESLint uses type-aware checks for `src/` and ordinary TypeScript checks for tests
and configuration. Browser tests intentionally evaluate dynamically imported
modules in a separate browser realm; they are verified through browser behavior
and native/WASM parity rather than pretending those imports are statically typed.
Do not add blanket lint disables or broaden an ignore to silence a new error.

Knip has explicit entries for worker modules and scripts called from shell or
Playwright configuration. Its `/src/*` mapping accounts for Vite browser imports
in the benchmark. Add an entry only when a real external invocation exists;
otherwise remove the unused module. Generated WASM and private/generated output
are ignored. Synthetic JSONL fixtures and third-party license text retain their
original contents rather than being rewritten by Prettier.

## Review and tests

Prefer direct contracts over optional compatibility paths when every caller uses
the current engine. Keep format adapters that are demonstrated in supported
Codex archives. Remove dead CSS, duplicate exports, abandoned scripts and repeated
assertions, but retain distinct regressions for concurrency, cancellation, source
selectors, legacy records, UTF-8 paging, graph joins and cache identity.

A useful test proves an observable invariant or a previously broken workflow.
Avoid tests that merely restate a helper's implementation or repeat the same
absence assertion in every UI scenario. Use synthetic fixtures; never copy a
private rollout into a test. Parser changes require native and WASM verification
and a metadata cache-version change when normalized cached fields change.

Browser tests and benchmarks default to external Chrome. Install it with
`npx playwright install chrome` if needed. The E2E server uses port 5177; the
benchmark owns port 5175 unless given a development-server URL. Do not run
competing test servers. The loading notes describe opt-in real-corpus benchmarks
and distinguish a warm current upload selection from a persisted native directory.

Some local macOS Chrome updater helpers can inherit Playwright output pipes and
delay teardown after all assertions finish. Diagnose process/socket ownership as
described in the implementation notes. Do not broadly kill browser/updater
processes, suppress assertion failures or claim an interrupted run passed.

## CI and deployment

`Verify` runs on pull requests, main pushes, manual dispatch. Its Linux/macOS engine jobs run formatting, strict Clippy, native tests and
the synthetic parser benchmark. Its browser job builds WASM, checks dependencies,
runs all frontend quality gates, verifies native/WASM parity, runs Chrome E2E and
the browser benchmark, and retains verification reports and the static bundle.
Jobs have time limits, actions are pinned to commit hashes, and permissions are
read-only. Dependabot covers npm, Cargo and Actions updates.

Browser retries retain diagnostic evidence, but a flaky test still fails CI.
Investigate its first failure rather than treating a successful retry as proof
that the original behavior was correct.

Successful main pushes and manual runs on main deploy the same-run static
artifact to Vercel after both engine jobs and the browser job pass. Only that job
receives project-scoped deployment credentials from the main-only production
environment. The packager rejects unexpected files and validates synthetic demos;
the live check compares every served file to the tested artifact. See
[deployment.md](deployment.md) for setup and recovery. Local checks do not establish
that hosted CI or deployment ran; record that distinction in handoff notes.

## Session bug reports and regressions

Open **Session info** beside the sidebar agent count. Copy the session ID; choose
a child from the dialog's Session selector when the issue is in that agent.
Include the affected turn/span, observed and expected timing, parser version,
and relevant diagnostics. The source path in the dialog identifies the local
rollout. An ID identifies the file; it does not grant another person access to it.

For an authorized local investigation, locate only that rollout in `sessions/`
or `archived_sessions/`, or match its ID in `session_index.jsonl`. Do not search
credentials or unrelated Codex files. Use the native `session-parser` CLI to
inspect normalized spans and `--details` with physical source/output lines. Keep
real rollouts and derived JSON in ignored local output directories. Never attach
the whole rollout or paste personal prompts/tool output into a public issue or PR.

1. Compare the reported span with its lifecycle records, timestamps, turn IDs
   and call IDs. Check missing completion events, late results, copied history
   and intervening metadata before assuming a duration is measured model work.
2. Reduce the cause to synthetic records in `crates/session-parser/tests`.
   Preserve event order, missing events and relative time gaps; replace IDs,
   prompts, paths and output with invented values. Confirm the test fails on the
   old parser for the intended reason before changing the engine.
3. Fix interpretation in Rust. Assert the correct turn/span boundaries and
   preserve explicit overlaps and legitimate long operations; do not hide an
   outlier with a maximum-duration cutoff in React. Add native/WASM contract
   coverage in `scripts/check-wasm.mjs` for the affected browser boundary.
4. Reparse the authorized source locally and compare the relevant aggregate
   durations. Record the cause, false starts and content-free results in the
   implementation notes. Bump `PARSER_VERSION` when parser semantics change.
5. Run `npm run check`, the production build, native/WASM parity and relevant
   external Chrome scenarios. Review the diff and publication file set before
   opening the PR; merge only after CI passes and verify the main deployment.

The missing-completion regression demonstrates this workflow: an unfinished turn
followed by a later visit previously extended to file end. The engine now bounds
it by its own last recorded activity, while a late explicit completion can still
prove overlap with a newer turn. Compaction has two distinct records: an operation
with explicit elapsed time and an instantaneous history-commit marker. Large
opaque replacement history is not displayable detail content and must not create
empty pagination.
