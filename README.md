# Codex Session Viewer

See where your Codex sessions spend time. Follow model activity, tool calls, waits,
and sub-agent communication on a Perfetto-style timeline, then jump into the
corresponding conversation or code.

The viewer processes your files locally in your browser. A Rust engine parses your
existing JSONL rollouts in browser workers; React presents the trace. There is no session upload service,
account setup, or API key.

## What you can explore

- **Sessions and archives.** Search top-level threads by title, inspect their
  model, turn count and descendants, then focus on a whole session, one turn or
  a particular agent.
- **Parallel work.** Each agent has grouped tracks for inference, shell commands,
  files, skills, code mode, messages and waits. Overlapping operations stack within
  a single track. Failed spans carry a red × and retain recorded error output.
- **Communication.** Orange links connect dispatches and messages to their receiving
  agents. Show all links or just those connected to your selection.
- **Conversation.** The Session Log is a scrolling, virtualized feed of messages,
  calls and results. Hover to highlight a span; click to center it without losing
  surrounding work. Expand entries for complete prompts and highlighted code.
- **Latency.** Select multiple spans, measure an interval, compare operation
  statistics, or follow the critical path through child-agent completion joins.
  Inspect critical-path operations directly beside the path table.
- **Large histories.** Streaming WASM parsing, bounded worker concurrency, cached
  metadata and eager descendant loading keep indexing separate from interaction.

## Open the viewer

Use [codex-session-viewer.vercel.app](https://codex-session-viewer.vercel.app) in
Chrome or Edge. No installation is needed. Choose **Explore example** to try a
synthetic trace, or **Open folder** to read your local Codex sessions. Files stay
in your browser; Vercel serves the application assets.

## Run locally

The web toolchain uses native TypeScript 7, Vite 8/Oxc, Vitest 5, type-aware Oxlint,
and oxfmt. `npm run lint` checks the existing TypeScript safety and React hook rules;
`npm run format` applies the shared formatting defaults.

You need **Node.js 24.20.0** (`nvm use`), **npm 12.0.2**, **Rust 1.98.1**, and **wasm-bindgen-cli 0.2.128**.

```sh
git clone https://github.com/benjaminRomano/codex-session-viewer.git
cd codex-session-viewer
nvm install && nvm use
npm install --global npm@12.0.2
rustup toolchain install 1.98.1 --component rustfmt,clippy --target wasm32-unknown-unknown
cargo +1.98.1 install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
npm run build:wasm
npm run dev
```

Open **http://127.0.0.1:5173** in Chrome or Edge. Choose **Explore example** for a
synthetic four-agent trace, or **Open folder** to select `~/.codex`.

On macOS, press **⌘ ⇧ G** in the folder picker and enter `~/.codex`.
**⌘ ⇧ .** reveals hidden folders. The opening dialog also walks you through these
steps. Firefox and Safari can use the folder-import fallback.

The viewer reads only `sessions/`, `archived_sessions/`, and the title index
`session_index.jsonl`. Your files are never modified. Native directory handles
are saved in IndexedDB and their metadata is cached in localStorage. Reloads
reconnect when permission remains granted; the browser may require another click
after a restart. Folder imports cache only the current selection because browsers
do not expose their directory identity.

Use the **Session info** button beside the agent count to copy a session ID and
inspect parser diagnostics. Include that ID when reporting a timing or content
problem; see the [regression workflow](docs/contributing.md#session-bug-reports-and-regressions).

Select a thread to replace the session list with its agent tree and turn controls.
**All sessions** closes the trace and returns to the list. Collapse the sidebar or
resize/collapse the bottom dock for more timeline space. Descendants load
independently and automatically, including files in the archive.

## Timeline controls

| Input         | Action                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| W / S         | Zoom in / out                                                                    |
| A / D         | Pan left / right                                                                 |
| Ctrl + wheel  | Zoom at the pointer                                                              |
| Shift + drag  | Pan                                                                              |
| Drag          | Select spans across tracks                                                       |
| Shift + click | Add or remove a span                                                             |
| F             | Center selected spans at 80% width; fit the current scope if nothing is selected |
| C             | Toggle the critical path                                                         |
| M             | Measure the selection or drag a measurement                                      |
| >             | Toggle all communication links                                                   |
| <             | Toggle links connected to selected spans                                         |
| [ / ]         | Follow incoming / outgoing links                                                 |

Selected-span links are enabled initially. All links take precedence when enabled;
turn them off to return to selected-only mode if selected-span links remain enabled,
or to hide links if both options are off. Click the keyboard icon for help.

## Verify and benchmark

```sh
npm run build                 # Rust → WASM and production assets
npm run check                 # lint, format, types, unused code, frontend and Rust tests
bash scripts/test-wasm.sh      # native/WASM parsing, streaming, analysis and detail parity
npx playwright install chrome
npm run test:e2e              # isolated external Google Chrome
cargo bench --locked -p session-parser --bench loading
npm run bench:browser
```

Oxlint includes type-aware TypeScript and React hook rules. oxfmt, Knip,
rustfmt and strict Clippy are required locally and in CI. Use `npm run format`
and `npm run format:rust` before submitting changes. CI verifies the Rust engine
on Linux/macOS, exercises the browser against WASM, and publishes a static build
artifact. Successful main pushes automatically deploy that exact artifact to
Vercel; pull requests only verify. See [deployment setup](docs/deployment.md) for
credentials, manual publication and rollback. The hosted app has a dedicated
origin. Its folder permissions and cache are separate from localhost.

Real-data benchmarks are opt-in and report aggregate timings/counts:

```sh
npm run bench:corpus -- ~/.codex/sessions ~/.codex/archived_sessions
npm run bench:corpus -- ~/.codex/sessions ~/.codex/archived_sessions --trace
npm run bench:browser -- --directory ~/.codex
```

See [loading measurements](docs/implementation-notes-loading.md) for methodology,
cache scope and completed measurements. Reports, browser profiles, screenshots and
generated WASM stay ignored. Fixtures are synthetic.

## Architecture and format notes

Rust owns record normalization, failures, agent relationships, log projections,
statistics and critical-path reconstruction. TypeScript owns filesystem access,
caching, loading coordination and presentation. The [architecture](docs/architecture.md)
includes the repository map and engine contracts; [session formats](docs/session-format.md)
describe thread metadata, the title index, JSONL events and archive compatibility.

The viewer reconstructs the timing available in the rollouts; they are not a
complete request-level profiler. Some older payloads are encrypted, and compressed,
reverted or segmented `history_base` layouts need additional version-resolution
support. Full details retain the recorded contents; giant payloads use separate
content pages. Cached/exported metadata may contain prompt-derived titles and
agent descriptions, so treat an exported index as personal data.

Development references: [quality gates](docs/contributing.md),
[current tasks](TASKS.md), [implementation history](docs/implementation-notes.md),
[loader design](docs/loading.md), and [Perfetto ports](docs/perfetto-reference.md).

Perfetto-derived colors and navigation retain Apache 2.0 attribution and the
[upstream license](docs/licenses/Perfetto-LICENSE.txt). This is an independent
viewer; it does not embed the complete Perfetto application.
