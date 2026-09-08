// Portions Copyright (C) 2018–2025 The Android Open Source Project.
// Licensed under the Apache License, Version 2.0.
// https://www.apache.org/licenses/LICENSE-2.0
// Adapted from Perfetto: base/hash.ts, components/colorizer.ts,
// frontend/timeline_page/{timeline_interactions,wasd_navigation_handler}.ts.
// See docs/perfetto-reference.md for pinned sources and adaptation details.
import { Hsluv } from 'hsluv';
import type { Span, TimeRange } from '../types';

const PERFETTO = {
  wheelZoomSpeed: -0.02,
  initialPanStepPx: 50,
  initialZoomStep: 0.1,
  snapFactor: 0.4,
  accelerationPerMs: 1 / 50,
  animationDuration: 700,
  zoomRatioPerFrame: 0.008,
  keyboardPanPxPerFrame: 8,
} as const;

/** Exact Perfetto hash; do not replace the multiply with Math.imul. */
export function perfettoHash(s: string, max: number): number {
  let hash = 0x811c9dc5 & 0xfffffff;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 16777619) & 0xffffffff;
  }
  return Math.abs(hash) % max;
}

export interface SliceColor {
  base: string;
  variant: string;
  text: string;
  textVariant: string;
}
export interface CriticalSegmentRange {
  spanId: string;
  start: number;
  end: number;
}
const colorCache = new Map<string, SliceColor>();

function rgb(h: number, s: number, l: number) {
  const color = new Hsluv();
  color.hsluv_h = h;
  color.hsluv_s = s;
  color.hsluv_l = l;
  color.hsluvToRgb();
  const r = Math.floor(color.rgb_r * 255);
  const g = Math.floor(color.rgb_g * 255);
  const b = Math.floor(color.rgb_b * 255);
  return {
    css: `rgb(${r} ${g} ${b})`,
    text: (r * 299 + g * 587 + b * 114) / 1000 >= 180 ? '#000' : '#fff',
  };
}

/** Perfetto's default procedural (HSLuv) slice color scheme. */
export function sliceColor(sliceName: string): SliceColor {
  const name = sliceName.replace(/( )?\d+/g, '');
  const cached = colorCache.get(name);
  if (cached) return cached;
  const hue = perfettoHash(name, 360);
  const base = rgb(hue, 80, perfettoHash(name + 'x', 40) + 40);
  const variant = rgb(hue, 80, 30);
  const result = {
    base: base.css,
    variant: variant.css,
    text: base.text,
    textVariant: variant.text,
  };
  // Session names can be unbounded; this is a rendering cache, not stored data.
  if (colorCache.size > 8192) colorCache.clear();
  colorCache.set(name, result);
  return result;
}

export function wheelZoomRatio(deltaY: number): number {
  const sign = deltaY < 0 ? -1 : 1;
  return 1 - sign * Math.log2(1 + Math.abs(deltaY)) * PERFETTO.wheelZoomSpeed;
}

export function fitRange(range: TimeRange, bounds: TimeRange): TimeRange {
  const fullDuration = Math.max(0.001, bounds.end - bounds.start);
  const duration = Math.max(
    Math.min(0.001, fullDuration),
    Math.min(fullDuration, range.end - range.start),
  );
  const start = Math.max(bounds.start, Math.min(bounds.end - duration, range.start));
  return { start, end: start + duration };
}

export function zoomRange(
  range: TimeRange,
  ratio: number,
  anchor: number,
  bounds: TimeRange,
): TimeRange {
  const duration = range.end - range.start;
  const nextDuration = Math.max(0.001, duration * Math.max(0.01, ratio));
  const center = range.start + duration * Math.max(0, Math.min(1, anchor));
  const start = center - nextDuration * Math.max(0, Math.min(1, anchor));
  return fitRange({ start, end: start + nextDuration }, bounds);
}

/** Center selected slices with the requested 80% viewport fill. */
export function focusRange(selection: TimeRange, bounds: TimeRange): TimeRange {
  const center = (selection.start + selection.end) / 2;
  const duration = Math.max(0.001, (selection.end - selection.start) / 0.8);
  return fitRange({ start: center - duration / 2, end: center + duration / 2 }, bounds);
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1) return `${(ms * 1000).toFixed(abs < 0.01 ? 1 : 0)} µs`;
  if (abs < 1000) return `${ms.toFixed(abs < 10 ? 2 : abs < 100 ? 1 : 0)} ms`;
  if (abs < 60000) return `${(ms / 1000).toFixed(abs < 10000 ? 2 : 1)} s`;
  if (abs < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((abs % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((abs % 3600000) / 60000)}m`;
}

/** Greedy interval partitioning: each overlapping slice receives a visible lane. */
export function partitionLanes(spans: Span[]): Span[][] {
  const sorted = [...spans].sort((a, b) => a.startTime - b.startTime || b.endTime - a.endTime);
  const lanes: Span[][] = [];
  const heap: { end: number; lane: number }[] = [];
  const push = (value: { end: number; lane: number }) => {
    heap.push(value);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heap[parent].end <= value.end) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = value;
  };
  const pop = () => {
    const root = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].end < heap[child].end) child++;
        if (heap[child].end >= last.end) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return root;
  };
  for (const span of sorted) {
    const lane = heap.length && heap[0].end <= span.startTime ? pop().lane : lanes.length;
    if (lane === lanes.length) lanes.push([]);
    lanes[lane].push(span);
    push({ lane, end: Math.max(span.startTime + 0.001, span.endTime) });
  }
  return lanes;
}

/** On a non-overlapping lane, binary search skips all slices before the view. */
export function firstVisibleSpan(spans: Span[], start: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].endTime < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Preserve split waits as individual path segments and never draw time backwards. */
export function normalizeCriticalSegments(
  segments: CriticalSegmentRange[],
  bounds: TimeRange,
): CriticalSegmentRange[] {
  const ordered = segments
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start,
    )
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: CriticalSegmentRange[] = [];
  let cursor = bounds.start;
  for (const segment of ordered) {
    const start = Math.max(bounds.start, cursor, segment.start);
    const end = Math.min(bounds.end, segment.end);
    if (end <= start) continue;
    result.push({ ...segment, start, end });
    cursor = end;
  }
  return result;
}

/** Port of Perfetto's spring/acceleration keyboard navigation with RAF lifecycle. */
export function attachKeyboardNavigation(
  element: HTMLElement,
  callbacks: {
    pan: (px: number) => void;
    zoom: (x: number, ratio: number) => void;
    isEnabled?: () => boolean;
  },
): () => void {
  type Motion = { direction: number; position: number; target: number; start: number; end: number };
  const pan: Motion = { direction: 0, position: 0, target: 0, start: 0, end: 0 };
  const zoom: Motion = { direction: 0, position: 0, target: 0, start: 0, end: 0 };
  let mouseX = element.clientWidth / 2;
  let frame = 0;
  const animate = (now: number) => {
    frame = 0;
    for (const [motion, isPan] of [
      [pan, true],
      [zoom, false],
    ] as const) {
      if (now >= motion.end) continue;
      const step = (motion.target - motion.position) * PERFETTO.snapFactor;
      if (motion.direction !== 0) {
        const velocity =
          1 + Math.max(Math.round(now - motion.start), 0) * PERFETTO.accelerationPerMs;
        const speed = isPan ? PERFETTO.keyboardPanPxPerFrame : PERFETTO.zoomRatioPerFrame;
        motion.target += motion.direction * Math.max(speed * velocity, step);
      }
      motion.position += step;
      if (Math.abs(step) > (isPan ? 1e-1 : 1e-6)) {
        if (isPan) callbacks.pan(step);
        else callbacks.zoom(mouseX, 1 - step);
      } else motion.end = 0;
    }
    if (now < pan.end || now < zoom.end) frame = requestAnimationFrame(animate);
  };
  const keyDirection = (code: string) => (code === 'KeyA' || code === 'KeyS' ? -1 : 1);
  const keydown = (event: KeyboardEvent) => {
    if (callbacks.isEnabled?.() === false || event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      (event.target as HTMLElement | null)?.closest('input,textarea,select,[contenteditable=true]')
    )
      return;
    if (!['KeyA', 'KeyD', 'KeyW', 'KeyS'].includes(event.code)) return;
    event.preventDefault();
    const isPan = event.code === 'KeyA' || event.code === 'KeyD';
    const motion = isPan ? pan : zoom;
    const direction = keyDirection(event.code);
    const now = performance.now();
    if (motion.direction !== direction) {
      motion.position = 0;
      motion.target = direction * (isPan ? PERFETTO.initialPanStepPx : PERFETTO.initialZoomStep);
      motion.end = 0;
    }
    motion.direction = direction;
    if (now > motion.end) motion.start = now;
    motion.end = now + PERFETTO.animationDuration;
    if (!frame) frame = requestAnimationFrame(animate);
  };
  const keyup = (event: KeyboardEvent) => {
    if (['KeyA', 'KeyD'].includes(event.code) && pan.direction === keyDirection(event.code))
      pan.direction = 0;
    if (['KeyW', 'KeyS'].includes(event.code) && zoom.direction === keyDirection(event.code))
      zoom.direction = 0;
  };
  const mousemove = (event: MouseEvent) => {
    mouseX = event.clientX - element.getBoundingClientRect().left;
  };
  const blur = () => {
    pan.direction = zoom.direction = 0;
  };
  document.addEventListener('keydown', keydown);
  document.addEventListener('keyup', keyup);
  element.addEventListener('mousemove', mousemove);
  window.addEventListener('blur', blur);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('keyup', keyup);
    element.removeEventListener('mousemove', mousemove);
    window.removeEventListener('blur', blur);
  };
}
