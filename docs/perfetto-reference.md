# Perfetto source reference

The timeline was implemented against the local Perfetto checkout at commit
`f8a7eeaac8f34dba9ce29950716b6012cfee8da2`. Perfetto is licensed under Apache 2.0.
The applicable copyright notices remain in the derived files, and the license
is included in [licenses/Perfetto-LICENSE.txt](licenses/Perfetto-LICENSE.txt).

This application is a React and Canvas 2D implementation for Codex JSONL data.
It does not embed Perfetto's Mithril application, SQL trace processor, or plugins.
The algorithms and values below were ported from source; component structure,
Codex track modeling, and layout code are original adaptations.

## Exact ports

| Behavior                      | Source and implementation                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slice-name normalization      | [`components/colorizer.ts`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/components/colorizer.ts): remove matches of `/( )?\d+/g` before selecting a color.                                                                                                                                                                                                        |
| String hash                   | [`base/hash.ts`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/base/hash.ts): initial `0x811c9dc5 & 0xfffffff`, character XOR, multiply by 16777619, mask to signed 32 bits, absolute value modulo range. Floating-point multiplication is deliberately preserved.                                                                                                  |
| Default slice palette         | [`components/colorizer.ts`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/components/colorizer.ts): HSLuv hue `hash(name, 360)`, saturation 80, lightness `hash(name + 'x', 40) + 40`; selected variant has lightness 30. This is Perfetto's default procedural palette, not its optional Material Design palette.                                                  |
| Color conversion and contrast | [`base/color.ts`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/base/color.ts): HSLuv-to-RGB conversion followed by flooring each channel times 255. Choose black text at YIQ brightness ≥180, otherwise white. Uses the current `hsluv` library's class API.                                                                                                       |
| Wheel zoom                    | [`timeline_interactions.ts`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/frontend/timeline_page/timeline_interactions.ts): `1 - sign(deltaY) * log2(1 + abs(deltaY)) * -0.02`, anchored to the pointer's fraction of the plot width. Predominantly horizontal wheel motion pans.                                                                                  |
| Keyboard motion               | [`wasd_navigation_handler.ts`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/frontend/timeline_page/wasd_navigation_handler.ts): physical W/S zoom, A/D pan; initial 50 px and 0.1 ratio; spring 0.4; acceleration 1/50 per ms; minimum 8 px and 0.008 ratio per frame; 700 ms animation extension. The step/target update order and stop thresholds are preserved. |
| Light theme colors            | [`theme_provider.scss`](https://github.com/google/perfetto/blob/f8a7eeaac8f34dba9ce29950716b6012cfee8da2/ui/src/assets/theme_provider.scss): white canvas, `#edf0f1` secondary surface, `#333` text, `#75797c` muted text, `#ccc` and `#e0e0e0` borders, `#2667e7` accent, expanded group `#262f3b`/`#e8eaed`, collapsed group `#f4fafb`.                                                                     |

## Adaptations and limits

- Perfetto's observable lifecycle is replaced with React effects and
  `requestAnimationFrame`; disposal removes all keyboard/mouse listeners.
  Keybindings are suspended for editable fields and open dialogs. Blur stops
  keyboard acceleration. The mouse anchor defaults to the plot center before
  the first mouse movement.
- JSONL timestamps use millisecond epoch numbers. The minimum visible interval
  is 1 µs, rather than Perfetto's 10 ns bigint interval, because these source
  records do not provide nanosecond precision. Zoom and pan fit within the
  current session or selected turn.
- Default drag performs rectangular multitrack selection. Shift-click toggles
  individual slices, Shift-drag pans, and middle-button drag also pans. The
  Ctrl-wheel binding is also accepted with Meta; Shift-wheel pans vertically
  oriented mouse wheels horizontally.
- `>` toggles flow arrows; `[` follows an incoming flow and `]` follows an
  outgoing flow. Flows use span IDs produced by the session graph. Unloaded
  endpoints do not produce speculative arrows. Flow navigation selects the
  linked span and brings it into
  view. These controls remain keyboard commands; there is no permanent timeline toolbar.
- `M` measures the bounds of selected spans, or enables a time-range drag when
  no spans are selected. `F` immediately centers the selected span/selection union,
  filling 80% of the plot, or fits the current scope when nothing is selected.
  The overview can be brushed to zoom or clicked to center; double-clicking the
  overview resets the current scope. Double-clicking an agent group drills
  into it through the application callback.
- Codex groups/track labels and the activity overview are domain-specific. The
  application uses system Arial typography rather than copying Perfetto's font
  bundle. This is not a pixel-identical reproduction of the entire Perfetto UI.
- The red path uses the exact start/end intervals of supplied critical-path
  segments, including separate portions of a wait around child execution.
  Geometry is chronological and clipped to scope; connectors never backtrack
  in time. The renderer does not compute criticality or convert temporal
  adjacency into a claim of proven causality. Communication flows accept explicit
  source/target anchor times, including the end of a returning wait operation.
- Per the requested presentation, the UI uses the best reconstructed timeline
  without adding “inferred” qualifiers. Internal evidence flags remain in the
  data model; ordinary communication arrows do not visually qualify it. Failed spans
  carry a red circle with a white cross at their right edge.

## Rendering cost

Each agent is one group, named only by its agent name/path. Track intervals are sorted and partitioned using a
min-heap in `O(n log n + n log k)`, where `k` is maximum overlap. Independent
overlaps get separate 20 px lanes within one logical track with one label and
one bottom separator. Group headers are 22 px, and the label column is 150 px. Concurrent tool calls remain selectable.
Positions are indexed by span ID for linked navigation.

The scrolling canvas is only the size of the visible viewport; it is never a
canvas the height of the full trace. Binary search finds the first visible row
and the first relevant span in each nonoverlapping lane. Subpixel slices sharing
one pixel are coalesced visually, except selected and critical slices. The
selection model retains each original span. Layout and overview density are
memoized independently of pointer movement and pan/zoom.

The overview uses a difference array, so creating its density histogram takes
`O(n + width)` instead of visiting every covered pixel for every span. The DOM
does not contain one element per trace span. The focused canvas supports arrow
keys to select spans, Shift to extend selection, Home/End to jump, and Enter to
inspect the selected agent. A screen-reader status announces the selected span;
there is no duplicate visual span list. Measurement can be controlled by the
application, so clearing it from the details panel also clears the canvas.

Unit tests cover reference color values, wheel scaling/anchor behavior, interval
partitioning, and selection-relevant binary search boundaries. Browser checks
must additionally cover canvas selection, multi-agent flows, zoom, measurements,
and rendering with a real session graph.

## 2026-09-07: compact navigation and flow revision

- Removed the permanent timeline toolbar and the bottom agent/span/visible-duration
  strip. The application retains its dock tabs and shared navigation. The canvas
  still exposes counts and selections to assistive technology; `?` opens concise
  keyboard help on demand. Measurements remain visible on the ruler and in the dock.
- The earlier `F` handler always reset the whole scope, ignoring selected spans.
  It now unions selected intervals and centers that range with an immediate 80%
  plot fill. The same focus helper handles span double-clicks. Scope boundaries
  clamp the result; zero-duration slices receive a 1 µs view. An offscreen selected
  track is revealed, expanding its collapsed group when necessary.
- The pinned Perfetto `CoreCommands` binds F to `SelectionManager.scrollToSelection`.
  Its `core/scroll_helper.ts` default centers at the current zoom, then uses
  `fillRatio = 5` (20% selected width) when already centered or when the interval
  exceeds half the view. That is not the requested screenshot behavior. We use the
  explicitly requested immediate 80% width, not an alleged verbatim port of that
  default. Upstream's optional `viewPercentage` uses a separate padding formula;
  it is not part of the default F path. The prior scope-only implementation and
  upstream default were both rejected for this interaction.
- `frontend/timeline_page/flow_events_renderer.ts` supplies 2 px ordinary and
  3 px focused stroke widths. Those widths are retained. User-selected brighter
  orange (`#e88718`, focused `#d66a00`) replaces the thin blue-gray adaptation;
  unrelated flows keep 55% opacity so they remain readable while selecting a span.
  The critical path stays red and its visibility is owned by the application.
- Hover now presents one compact line: duration followed by span name. Track,
  status, and other details belong in the selected-span dock. Pressing F clears
  stale hover text immediately after moving the viewport.
- Nine focused unit cases pass, including centered 80% bounds, boundary clamping,
  zero-duration events, and existing color/interval/critical-segment checks.
  Chrome cases cover first-press selected focus, keyboard-only controls, compact
  tooltip content, and actual 2 px/3 px orange flow draw calls, as well as the
  existing viewport, overlap, failure, measurement, and selection behaviors.
