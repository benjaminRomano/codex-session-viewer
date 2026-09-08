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

`Verify` runs on pull requests, main pushes, manual dispatch and reusable workflow
calls. Its Linux/macOS engine jobs run formatting, strict Clippy, native tests and
the synthetic parser benchmark. Its browser job builds WASM, checks dependencies,
runs all frontend quality gates, verifies native/WASM parity, runs Chrome E2E and
the browser benchmark, and retains verification reports and the static bundle.
Jobs have time limits, actions are pinned to commit hashes, and permissions are
read-only. Dependabot covers npm, Cargo and Actions updates.

The manual Pages workflow calls the same verification workflow and downloads its
successful static artifact. Deployment receives Pages/OIDC permissions only in
the deploy job. It does not rebuild a different artifact after testing. Local
checks do not establish that hosted CI or deployment ran; record that distinction
in handoff notes.
