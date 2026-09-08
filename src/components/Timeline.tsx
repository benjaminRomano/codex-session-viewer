import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Flow, ParsedSession, Span, TimeRange, TrackKind } from '../types';
import { TRACKS, TRACK_LABELS } from '../types';
import {
  attachKeyboardNavigation,
  firstVisibleSpan,
  fitRange,
  focusRange,
  formatDuration,
  normalizeCriticalSegments,
  partitionLanes,
  sliceColor,
  wheelZoomRatio,
  zoomRange,
} from '../lib/perfetto';
import type { CriticalSegmentRange } from '../lib/perfetto';
import './timeline.css';

export interface TimelineProps {
  sessions: ParsedSession[];
  range?: TimeRange;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  flows: (Flow & { sourceTime?: number; targetTime?: number })[];
  criticalSegments?: CriticalSegmentRange[];
  measurement?: TimeRange | null;
  onInspectSession?: (id: string) => void;
  onToggleCritical?: () => void;
  onMeasureChange?: (range: TimeRange | null) => void;
  highlightedId?: string;
  focusRequest?: { spanId: string; nonce: number };
}

interface Row {
  id: string;
  session: ParsedSession;
  group: boolean;
  label: string;
  lanes: Span[][];
  y: number;
  height: number;
}
interface PositionedSpan {
  span: Span;
  row: Row;
  lane: number;
}
interface Drag {
  x: number;
  y: number;
  lastX: number;
  currentX: number;
  currentY: number;
  mode: 'select' | 'pan' | 'measure';
  additive: boolean;
}
const GROUP_HEIGHT = 22;
const LANE_HEIGHT = 20;
const LABEL_WIDTH = 150;
const RULER_HEIGHT = 28;
const EMPTY_CRITICAL_SEGMENTS: CriticalSegmentRange[] = [];

function spanCenterY(item: PositionedSpan) {
  return (
    item.row.y + (item.row.group ? GROUP_HEIGHT / 2 : item.lane * LANE_HEIGHT + LANE_HEIGHT / 2)
  );
}

function traceBounds(sessions: ParsedSession[]): TimeRange {
  let start = Infinity;
  let end = -Infinity;
  for (const session of sessions) {
    start = Math.min(start, session.metadata.startTime);
    end = Math.max(end, session.metadata.endTime);
  }
  return Number.isFinite(start) ? { start, end: Math.max(start + 1, end) } : { start: 0, end: 1 };
}

function setupCanvas(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  return ctx;
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 6) return '';
  // Avoid expensive text measurement on long tool payloads.
  const truncated = text.replace(/\s+/g, ' ').slice(0, Math.ceil(maxWidth / 3));
  if (truncated === text && ctx.measureText(truncated).width <= maxWidth) return truncated;
  let lo = 0;
  let hi = truncated.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(truncated.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return truncated.slice(0, lo) + '…';
}

function tickStep(duration: number, width: number): number {
  const target = duration / Math.max(1, width / 115);
  const power = Math.pow(10, Math.floor(Math.log10(target)));
  for (const multiplier of [1, 2, 5, 10])
    if (power * multiplier >= target) return power * multiplier;
  return power * 10;
}

function firstVisibleRow(rows: Row[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].y + rows[mid].height < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function arrow(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  color: string,
  monotonic = false,
) {
  const bend = monotonic
    ? Math.max(0, (tx - sx) / 3)
    : Math.max(18, Math.min(100, Math.abs(tx - sx) / 3));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.bezierCurveTo(sx + bend, sy, tx - bend, ty, tx, ty);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - 5, ty - 3);
  ctx.lineTo(tx - 5, ty + 3);
  ctx.closePath();
  ctx.fill();
}

export function Timeline({
  sessions,
  range,
  selectedIds,
  onSelectionChange,
  flows,
  criticalSegments = EMPTY_CRITICAL_SEGMENTS,
  measurement,
  onInspectSession,
  onMeasureChange,
  onToggleCritical,
  highlightedId,
  focusRequest,
}: TimelineProps) {
  const rootRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 430 });
  const [scrollTop, setScrollTop] = useState(0);
  const bounds = useMemo(() => range ?? traceBounds(sessions), [range, sessions]);
  const [view, setView] = useState<TimeRange>(bounds);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showAllFlows, setShowAllFlows] = useState(false);
  const [showSelectedFlows, setShowSelectedFlows] = useState(true);
  const [measureMode, setMeasureMode] = useState(false);
  const [internalMeasure, setInternalMeasure] = useState<TimeRange | null>(null);
  const measure = measurement === undefined ? internalMeasure : measurement;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    span?: Span;
  } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const pendingReveal = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(120, size.width * 0.2));
  const plotWidth = Math.max(1, size.width - labelWidth);
  const duration = Math.max(0.001, view.end - view.start);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const flowMode = showAllFlows ? 'all' : showSelectedFlows ? 'selected' : 'hidden';
  const enabledFlows = useMemo(
    () =>
      showAllFlows
        ? flows
        : showSelectedFlows
          ? flows.filter(
              (flow) => selected.has(flow.sourceSpanId) || selected.has(flow.targetSpanId),
            )
          : [],
    [flows, selected, showAllFlows, showSelectedFlows],
  );
  const critical = useMemo(
    () => new Set(criticalSegments.map((segment) => segment.spanId)),
    [criticalSegments],
  );
  const scopeKey = `${sessions[0]?.metadata.id ?? ''}:${range?.start ?? ''}:${range?.end ?? ''}`;
  const priorScope = useRef(scopeKey);

  useEffect(() => {
    if (priorScope.current !== scopeKey) {
      priorScope.current = scopeKey;
      setView(bounds);
      setInternalMeasure(null);
      setCollapsed(new Set());
      if (viewportRef.current) viewportRef.current.scrollTop = 0;
    } else {
      // Preserve zoom while child sessions arrive; expand a fully fitted view.
      setView((current) => fitRange(current, bounds));
    }
  }, [scopeKey, bounds]);

  const layout = useMemo(() => {
    const rows: Row[] = [];
    const positions = new Map<string, PositionedSpan>();
    let y = 0;
    let count = 0;
    for (const session of sessions) {
      const id = session.metadata.id;
      const agentPath = session.metadata.agentPath?.split('/').filter(Boolean).at(-1);
      const group: Row = {
        id,
        session,
        group: true,
        label:
          session.metadata.agentName ||
          (agentPath && agentPath !== 'root' ? agentPath : 'Main agent'),
        lanes: [],
        y,
        height: GROUP_HEIGHT,
      };
      rows.push(group);
      y += GROUP_HEIGHT;
      const tracks = new Map<TrackKind, Span[]>();
      for (const span of session.spans) {
        if (span.endTime < bounds.start || span.startTime > bounds.end) continue;
        count++;
        const track = tracks.get(span.track);
        if (track) track.push(span);
        else tracks.set(span.track, [span]);
        if (collapsed.has(id)) positions.set(span.id, { span, row: group, lane: 0 });
      }
      if (collapsed.has(id)) continue;
      for (const track of TRACKS) {
        const spans = tracks.get(track);
        if (!spans?.length) continue;
        const lanes = partitionLanes(spans);
        const row: Row = {
          id: `${id}:${track}`,
          session,
          group: false,
          label: TRACK_LABELS[track],
          lanes,
          y,
          height: lanes.length * LANE_HEIGHT,
        };
        rows.push(row);
        for (let lane = 0; lane < lanes.length; lane++)
          for (const span of lanes[lane]) positions.set(span.id, { span, row, lane });
        y += row.height;
      }
    }
    return { rows, positions, height: y, count };
  }, [sessions, bounds, collapsed]);

  const criticalDraw = useMemo(() => {
    return normalizeCriticalSegments(
      criticalSegments.flatMap((segment) => {
        const item = layout.positions.get(segment.spanId);
        return item
          ? [
              {
                ...segment,
                start: Math.max(segment.start, item.span.startTime),
                end: Math.min(segment.end, item.span.endTime),
              },
            ]
          : [];
      }),
      bounds,
    );
  }, [criticalSegments, layout, bounds]);

  useLayoutEffect(() => {
    if (!pendingReveal.current) return;
    const item = layout.positions.get(pendingReveal.current);
    if (!item || item.row.group) return;
    if (viewportRef.current)
      viewportRef.current.scrollTop = Math.max(0, spanCenterY(item) - size.height / 3);
    pendingReveal.current = null;
  }, [layout, size.height, selectedIds]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () =>
      setSize({ width: viewport.clientWidth, height: Math.max(100, viewport.clientHeight) });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const setMeasurement = useCallback(
    (value: TimeRange | null) => {
      setInternalMeasure(value);
      onMeasureChange?.(value);
    },
    [onMeasureChange],
  );
  const pan = useCallback(
    (px: number) => {
      setView((v) => {
        const delta = (px / plotWidth) * (v.end - v.start);
        return fitRange({ start: v.start + delta, end: v.end + delta }, boundsRef.current);
      });
    },
    [plotWidth],
  );
  const zoom = useCallback(
    (x: number, ratio: number) => {
      setView((v) => zoomRange(v, ratio, (x - labelWidth) / plotWidth, boundsRef.current));
    },
    [plotWidth, labelWidth],
  );
  const fit = useCallback(() => {
    let start = Infinity;
    let end = -Infinity;
    for (const id of selectedIds) {
      const item = layout.positions.get(id);
      if (item) {
        start = Math.min(start, item.span.startTime);
        end = Math.max(end, item.span.endTime);
      }
    }
    setView(
      Number.isFinite(start) ? focusRange({ start, end }, boundsRef.current) : boundsRef.current,
    );
    const active = layout.positions.get(selectedIds.at(-1) ?? '');
    if (active && viewportRef.current) {
      if (active.row.group) {
        pendingReveal.current = active.span.id;
        setCollapsed((old) => {
          const next = new Set(old);
          next.delete(active.span.sessionId);
          return next;
        });
      } else {
        const y = spanCenterY(active);
        const viewport = viewportRef.current;
        if (y < viewport.scrollTop || y > viewport.scrollTop + viewport.clientHeight)
          viewport.scrollTop = Math.max(0, y - viewport.clientHeight / 2);
      }
    }
    setHover(null);
  }, [selectedIds, layout]);

  const lastFocusRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRequest) {
      lastFocusRequest.current = null;
      return;
    }
    const key = `${focusRequest.nonce}:${focusRequest.spanId}`;
    if (lastFocusRequest.current === key) return;
    const item = layout.positions.get(focusRequest.spanId);
    if (!item) return;
    lastFocusRequest.current = key;
    const width = viewRef.current.end - viewRef.current.start;
    const center = (item.span.startTime + item.span.endTime) / 2;
    setView(fitRange({ start: center - width / 2, end: center + width / 2 }, boundsRef.current));
    if (item.row.group) {
      pendingReveal.current = item.span.id;
      setCollapsed((old) => {
        const next = new Set(old);
        next.delete(item.span.sessionId);
        return next;
      });
    } else if (viewportRef.current) {
      viewportRef.current.scrollTop = Math.max(
        0,
        spanCenterY(item) - viewportRef.current.clientHeight / 2,
      );
    }
    setHover(null);
  }, [focusRequest, layout]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return attachKeyboardNavigation(root, {
      pan,
      zoom,
      isEnabled: () => !document.querySelector('dialog[open],[role=dialog]'),
    });
  }, [pan, zoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || (event.shiftKey && !event.ctrlKey)) {
        event.preventDefault();
        pan(event.deltaX || event.deltaY);
      } else if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoom(event.clientX - viewport.getBoundingClientRect().left, wheelZoomRatio(event.deltaY));
      }
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [pan, zoom]);

  const revealSpan = useCallback(
    (id: string, additive = false) => {
      const position = layout.positions.get(id);
      if (!position) return;
      pendingReveal.current = id;
      onSelectionChange(additive ? [...new Set([...selectedIds, id])] : [id]);
      setCollapsed((old) => {
        if (!old.has(position.span.sessionId)) return old;
        const next = new Set(old);
        next.delete(position.span.sessionId);
        return next;
      });
      const span = position.span;
      const v = viewRef.current;
      if (span.startTime < v.start || span.endTime > v.end) {
        const width = Math.max(v.end - v.start, (span.endTime - span.startTime) * 1.4);
        const center = (span.startTime + span.endTime) / 2;
        setView(
          fitRange({ start: center - width / 2, end: center + width / 2 }, boundsRef.current),
        );
      }
    },
    [layout, onSelectionChange, selectedIds],
  );

  const navigateFlow = useCallback(
    (direction: number) => {
      const connected = flows.filter((f) =>
        direction > 0 ? selected.has(f.sourceSpanId) : selected.has(f.targetSpanId),
      );
      const options = connected.length ? connected : flows;
      if (!options.length) return;
      const index =
        (((navigationIndex + direction) % options.length) + options.length) % options.length;
      setNavigationIndex(index);
      const flow = options[index];
      revealSpan(direction > 0 ? flow.targetSpanId : flow.sourceSpanId);
      setShowSelectedFlows(true);
    },
    [flows, selected, navigationIndex, revealSpan],
  );

  const keyboardOrder = useRef<{
    positions: Map<string, PositionedSpan>;
    items: PositionedSpan[];
  } | null>(null);
  const navigateCanvas = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    const activeId = selectedIds.at(-1);
    if (event.key === 'Enter') {
      const active = activeId ? layout.positions.get(activeId) : undefined;
      if (active) onInspectSession?.(active.span.sessionId);
      return;
    }
    if (keyboardOrder.current?.positions !== layout.positions) {
      keyboardOrder.current = {
        positions: layout.positions,
        items: [...layout.positions.values()].sort(
          (a, b) =>
            a.span.startTime - b.span.startTime ||
            a.span.endTime - b.span.endTime ||
            a.span.id.localeCompare(b.span.id),
        ),
      };
    }
    const items = keyboardOrder.current.items;
    if (!items.length) return;
    const index = items.findIndex((item) => item.span.id === activeId);
    let next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : Math.max(
              0,
              Math.min(
                items.length - 1,
                index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1),
              ),
            );
    if (index >= 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const current = items[index];
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      let distance = Infinity;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const dy = spanCenterY(item) - spanCenterY(current);
        if (dy * direction <= 0) continue;
        const score =
          Math.abs(dy) * (bounds.end - bounds.start + 1) +
          Math.abs(item.span.startTime - current.span.startTime);
        if (score < distance) {
          distance = score;
          next = i;
        }
      }
    }
    revealSpan(items[next].span.id, event.shiftKey);
  };

  const measureSelection = useCallback(() => {
    let start = Infinity;
    let end = -Infinity;
    for (const id of selectedIds) {
      const item = layout.positions.get(id);
      if (item) {
        start = Math.min(start, item.span.startTime);
        end = Math.max(end, item.span.endTime);
      }
    }
    if (Number.isFinite(start)) {
      setMeasurement({ start, end });
      setMeasureMode(false);
    } else setMeasureMode((mode) => !mode);
  }, [selectedIds, layout, setMeasurement]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        document.querySelector('dialog[open],[role=dialog]') ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target as HTMLElement | null)?.closest(
          'input,textarea,select,[contenteditable=true]',
        )
      )
        return;
      if (event.key === '>' || (event.code === 'Period' && event.shiftKey)) {
        event.preventDefault();
        setShowAllFlows((value) => !value);
      } else if (event.key === '<' || (event.code === 'Comma' && event.shiftKey)) {
        event.preventDefault();
        setShowSelectedFlows((value) => !value);
      } else if (event.code === 'BracketRight') {
        event.preventDefault();
        navigateFlow(1);
      } else if (event.code === 'BracketLeft') {
        event.preventDefault();
        navigateFlow(-1);
      } else if (event.code === 'KeyM') {
        event.preventDefault();
        measureSelection();
      } else if (event.code === 'KeyC' && !event.repeat) {
        event.preventDefault();
        onToggleCritical?.();
      } else if (event.code === 'KeyF') {
        event.preventDefault();
        fit();
      } else if (event.key === 'Escape') {
        setMeasurement(null);
        setMeasureMode(false);
        onSelectionChange([]);
        setShowHelp(false);
      } else if (event.key === '?') {
        event.preventDefault();
        setShowHelp((value) => !value);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [navigateFlow, measureSelection, fit, onSelectionChange, setMeasurement, onToggleCritical]);

  const timeAt = useCallback(
    (x: number) => view.start + ((x - labelWidth) / plotWidth) * duration,
    [view.start, duration, labelWidth, plotWidth],
  );
  const xAt = useCallback(
    (time: number) => labelWidth + ((time - view.start) / duration) * plotWidth,
    [view.start, duration, labelWidth, plotWidth],
  );
  const ticks = useMemo(() => {
    const step = tickStep(duration, plotWidth);
    const first = Math.ceil((view.start - bounds.start) / step) * step + bounds.start;
    const result: number[] = [];
    for (let tick = first; tick <= view.end && result.length < 200; tick += step) result.push(tick);
    return result;
  }, [duration, plotWidth, view.start, view.end, bounds.start]);

  // Draw only visible rows, and binary-search their sorted non-overlapping spans.
  useLayoutEffect(() => {
    const ctx = setupCanvas(canvasRef.current, size.width, size.height);
    if (!ctx) return;
    const selectionRects: { left: number; width: number; y: number }[] = [];
    const failures: { x: number; y: number }[] = [];
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, size.height);
    const firstRow = firstVisibleRow(layout.rows, scrollTop);
    for (let i = firstRow; i < layout.rows.length; i++) {
      const row = layout.rows[i];
      const y = row.y - scrollTop;
      if (y > size.height) break;
      if (row.group) {
        const isCollapsed = collapsed.has(row.session.metadata.id);
        ctx.fillStyle = isCollapsed ? '#f4fafb' : '#262f3b';
        ctx.fillRect(0, y, size.width, row.height);
        ctx.fillStyle = isCollapsed ? '#333' : '#e8eaed';
        ctx.font = 'bold 11px Arial, sans-serif';
        ctx.fillText(isCollapsed ? '▸' : '▾', 9, y + row.height / 2);
        ctx.fillText(ellipsis(ctx, row.label, labelWidth - 31), 24, y + row.height / 2);
        ctx.font = '10px Arial, sans-serif';
        ctx.fillStyle = isCollapsed ? '#75797c' : '#c6cbd1';
        const model = row.session.metadata.model || 'Unknown model';
        const turns = `${row.session.turns.length} turn${row.session.turns.length === 1 ? '' : 's'}`;
        ctx.fillText(`${model}  ·  ${turns}`, labelWidth + 10, y + row.height / 2);
        continue;
      }
      ctx.fillStyle = '#f8f9fa';
      ctx.fillRect(0, y, labelWidth, row.height);
      ctx.strokeStyle = '#e0e0e0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + row.height - 0.5);
      ctx.lineTo(size.width, y + row.height - 0.5);
      ctx.stroke();
      ctx.font = '11px Arial, sans-serif';
      ctx.fillStyle = '#4c5359';
      ctx.fillText(
        row.label,
        21,
        Math.min(y + row.height - LANE_HEIGHT / 2, Math.max(LANE_HEIGHT / 2, y + LANE_HEIGHT / 2)),
      );
      ctx.strokeStyle = '#eaecee';
      ctx.beginPath();
      for (const tick of ticks) {
        const x = Math.floor(xAt(tick)) + 0.5;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + row.height);
      }
      ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.rect(labelWidth, y, plotWidth, row.height);
      ctx.clip();
      const firstLane = Math.max(0, Math.floor(-y / LANE_HEIGHT));
      const lastLane = Math.min(row.lanes.length - 1, Math.floor((size.height - y) / LANE_HEIGHT));
      for (let lane = firstLane; lane <= lastLane; lane++) {
        const spans = row.lanes[lane];
        const laneY = y + lane * LANE_HEIGHT;
        let lastPixel = -Infinity;
        for (let j = firstVisibleSpan(spans, view.start); j < spans.length; j++) {
          const span = spans[j];
          if (span.startTime > view.end) break;
          const rawX = xAt(span.startTime);
          const right = xAt(span.endTime);
          const left = Math.max(labelWidth, rawX);
          const width = Math.max(2, Math.min(size.width, right) - left);
          const isSelected = selected.has(span.id);
          const isHighlighted = span.id === highlightedId;
          const isCritical = critical.has(span.id);
          // Subpixel slices in the same lane/pixel are visually indistinguishable.
          if (
            width <= 2 &&
            Math.floor(left) === lastPixel &&
            !isSelected &&
            !isCritical &&
            !isHighlighted
          )
            continue;
          lastPixel = Math.floor(left);
          const color = sliceColor(span.name);
          ctx.fillStyle = isSelected ? color.variant : color.base;
          ctx.fillRect(left, laneY + 1, width, LANE_HEIGHT - 2);
          if (width > 17) {
            ctx.fillStyle = isSelected ? color.textVariant : color.text;
            ctx.font = '10px Arial, sans-serif';
            const text = ellipsis(ctx, span.name, width - 8);
            ctx.fillText(text, left + 4, laneY + LANE_HEIGHT / 2);
          }
          if (isSelected) {
            selectionRects.push({ left, width, y: laneY });
          }
          if (isHighlighted && !isSelected) {
            ctx.strokeStyle = '#2667e7';
            ctx.lineWidth = 2;
            ctx.strokeRect(left - 1, laneY + 0.5, width + 2, LANE_HEIGHT - 1);
            ctx.lineWidth = 1;
          }
          if (/error|failed|aborted/i.test(span.status)) {
            failures.push({
              x: Math.min(size.width - 5, left + width - 1),
              y: laneY + LANE_HEIGHT / 2,
            });
          }
        }
      }
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(labelWidth, 0, plotWidth, size.height);
    ctx.clip();
    if (enabledFlows.length) {
      // Flow geometry is bounded to the canvas even for unloaded/collapsed rows.
      for (const flow of enabledFlows) {
        const source = layout.positions.get(flow.sourceSpanId);
        const target = layout.positions.get(flow.targetSpanId);
        if (!source || !target) continue;
        const sy = spanCenterY(source) - scrollTop;
        const ty = spanCenterY(target) - scrollTop;
        if ((sy < 0 && ty < 0) || (sy > size.height && ty > size.height)) continue;
        const sx = xAt(flow.sourceTime ?? source.span.endTime);
        const tx = xAt(flow.targetTime ?? target.span.startTime);
        if ((sx < labelWidth && tx < labelWidth) || (sx > size.width && tx > size.width)) continue;
        const active = selected.has(source.span.id) || selected.has(target.span.id);
        // Perfetto uses 2px ordinary and 3px focused flows. Keep the requested
        // orange visible even when another, unrelated slice is selected.
        ctx.lineWidth = active ? 3 : 2;
        ctx.globalAlpha = active || !selected.size ? 1 : 0.55;
        arrow(ctx, sx, sy, tx, ty, active ? '#d66a00' : '#e88718');
      }
      ctx.globalAlpha = 1;
    }
    if (criticalDraw.length) {
      let previous: { end: number; y: number } | undefined;
      for (const segment of criticalDraw) {
        const item = layout.positions.get(segment.spanId);
        if (!item) continue;
        const y = spanCenterY(item) - scrollTop;
        const sx = xAt(segment.start);
        const ex = xAt(segment.end);
        ctx.strokeStyle = '#d92626';
        ctx.fillStyle = '#d92626';
        ctx.lineWidth = 2;
        if (previous) {
          const py = previous.y;
          if (!((py < 0 && y < 0) || (py > size.height && y > size.height)))
            arrow(ctx, xAt(previous.end), py, sx, y, '#d92626', true);
        }
        if (y >= 0 && y <= size.height) {
          ctx.beginPath();
          ctx.moveTo(sx, y);
          ctx.lineTo(ex, y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(sx, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        previous = { end: segment.end, y };
      }
    }
    ctx.lineWidth = 1;
    if (measure) {
      const left = xAt(measure.start);
      const right = xAt(measure.end);
      ctx.fillStyle = '#2667e718';
      ctx.fillRect(left, 0, right - left, size.height);
      ctx.strokeStyle = '#2667e7';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(left, 0);
      ctx.lineTo(left, size.height);
      ctx.moveTo(right, 0);
      ctx.lineTo(right, size.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (
      drag &&
      drag.mode === 'select' &&
      Math.abs(drag.currentX - drag.x) + Math.abs(drag.currentY - drag.y) > 4
    ) {
      const x = Math.min(drag.x, drag.currentX);
      const y = Math.min(drag.y, drag.currentY) - scrollTop;
      const w = Math.abs(drag.currentX - drag.x);
      const h = Math.abs(drag.currentY - drag.y);
      ctx.fillStyle = '#2667e724';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#2667e7';
      ctx.strokeRect(x, y, w, h);
    }
    if (hover && !drag && hover.x >= labelWidth) {
      ctx.strokeStyle = '#5558';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x + 0.5, 0);
      ctx.lineTo(hover.x + 0.5, size.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Draw selection last so adjacent subpixel spans and flows cannot cover it.
    // The minimum width is a focus marker; timing and hit testing stay unchanged.
    for (const rect of selectionRects) {
      const width = Math.max(8, rect.width - 1);
      const left = rect.left + (rect.width - width) / 2;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.strokeRect(left, rect.y + 2, width, LANE_HEIGHT - 4);
      ctx.strokeStyle = '#101820';
      ctx.lineWidth = 2;
      ctx.strokeRect(left, rect.y + 2, width, LANE_HEIGHT - 4);
    }
    // A failed operation remains identifiable even when selected or on a path.
    for (const { x, y } of failures) {
      ctx.fillStyle = '#ca2626';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x - 2, y - 2);
      ctx.lineTo(x + 2, y + 2);
      ctx.moveTo(x + 2, y - 2);
      ctx.lineTo(x - 2, y + 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(labelWidth - 0.5, 0);
    ctx.lineTo(labelWidth - 0.5, size.height);
    ctx.stroke();
  }, [
    layout,
    size,
    scrollTop,
    collapsed,
    labelWidth,
    plotWidth,
    ticks,
    xAt,
    view,
    selected,
    highlightedId,
    critical,
    enabledFlows,
    criticalDraw,
    measure,
    drag,
    hover,
  ]);

  useLayoutEffect(() => {
    const ctx = setupCanvas(rulerRef.current, size.width, RULER_HEIGHT);
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, RULER_HEIGHT);
    ctx.fillStyle = '#75797c';
    ctx.font = '10px Arial, sans-serif';
    ctx.save();
    ctx.beginPath();
    ctx.rect(labelWidth, 0, plotWidth, RULER_HEIGHT);
    ctx.clip();
    for (const tick of ticks) {
      const x = xAt(tick);
      ctx.fillStyle = '#555';
      ctx.fillText(formatDuration(tick - bounds.start), x + 5, 11);
      ctx.strokeStyle = '#ccc';
      ctx.beginPath();
      ctx.moveTo(Math.floor(x) + 0.5, 21);
      ctx.lineTo(Math.floor(x) + 0.5, RULER_HEIGHT);
      ctx.stroke();
    }
    if (measure) {
      const left = Math.max(labelWidth, xAt(measure.start));
      const right = Math.min(size.width, xAt(measure.end));
      ctx.fillStyle = '#2667e7';
      ctx.fillRect(left, 27, right - left, 3);
      const label = `↔ ${formatDuration(measure.end - measure.start)}`;
      const width = ctx.measureText(label).width + 12;
      const x = Math.max(labelWidth, Math.min(size.width - width, (left + right - width) / 2));
      ctx.fillRect(x, 1, width, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 6, 11);
    } else if (hover && hover.x >= labelWidth) {
      const label = formatDuration(timeAt(hover.x) - bounds.start);
      const width = ctx.measureText(label).width + 12;
      const x = Math.max(labelWidth, Math.min(size.width - width, hover.x - width / 2));
      ctx.fillStyle = '#3d5688';
      ctx.fillRect(x, 1, width, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 6, 11);
    }
    ctx.restore();
  }, [size.width, ticks, xAt, bounds.start, labelWidth, plotWidth, hover, measure, timeAt]);

  const overviewDensity = useMemo(() => {
    const bins = Math.max(1, Math.ceil(plotWidth));
    const delta = new Float32Array(bins + 1);
    const full = Math.max(1, bounds.end - bounds.start);
    for (const session of sessions)
      for (const span of session.spans) {
        if (span.track === 'turns' || span.endTime < bounds.start || span.startTime > bounds.end)
          continue;
        const start = Math.max(
          0,
          Math.min(bins - 1, Math.floor(((span.startTime - bounds.start) / full) * bins)),
        );
        const end = Math.max(
          start + 1,
          Math.min(bins, Math.ceil(((span.endTime - bounds.start) / full) * bins)),
        );
        delta[start] += 1;
        delta[end] -= 1;
      }
    let value = 0;
    let max = 1;
    for (let i = 0; i < bins; i++) {
      value += delta[i];
      delta[i] = value;
      max = Math.max(max, value);
    }
    return { values: delta, max };
  }, [sessions, bounds, plotWidth]);

  useLayoutEffect(() => {
    const ctx = setupCanvas(overviewRef.current, size.width, 42);
    if (!ctx) return;
    ctx.fillStyle = '#edf0f1';
    ctx.fillRect(0, 0, size.width, 42);
    ctx.fillStyle = '#75797c';
    ctx.font = '10px Arial, sans-serif';
    ctx.fillText('ACTIVITY', 13, 15);
    ctx.fillStyle = '#333';
    ctx.font = '11px Arial, sans-serif';
    ctx.fillText(formatDuration(bounds.end - bounds.start), 13, 30);
    ctx.fillStyle = '#9bafbf';
    for (let i = 0; i < overviewDensity.values.length - 1; i++) {
      const h = Math.sqrt(overviewDensity.values[i] / overviewDensity.max) * 29;
      if (h > 0) ctx.fillRect(labelWidth + i, 36 - h, 1, h);
    }
    const full = Math.max(1, bounds.end - bounds.start);
    const left = labelWidth + ((view.start - bounds.start) / full) * plotWidth;
    const right = labelWidth + ((view.end - bounds.start) / full) * plotWidth;
    ctx.fillStyle = '#ffffffa0';
    ctx.fillRect(labelWidth, 0, left - labelWidth, 42);
    ctx.fillRect(right, 0, size.width - right, 42);
    ctx.strokeStyle = '#3d5688';
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, 2.5, Math.max(1, right - left - 1), 36);
    ctx.fillStyle = '#3d5688';
    ctx.fillRect(left, 12, 3, 16);
    ctx.fillRect(right - 3, 12, 3, 16);
  }, [size.width, labelWidth, plotWidth, bounds, view, overviewDensity]);

  const hitTest = useCallback(
    (x: number, y: number): PositionedSpan | undefined => {
      if (x < labelWidth) return undefined;
      const row = layout.rows[firstVisibleRow(layout.rows, y)];
      if (!row || row.group || y < row.y || y > row.y + row.height) return undefined;
      const lane = Math.min(row.lanes.length - 1, Math.floor((y - row.y) / LANE_HEIGHT));
      const spans = row.lanes[lane];
      if (!spans) return undefined;
      const time = timeAt(x);
      const tolerance = (duration / plotWidth) * 3;
      const first = firstVisibleSpan(spans, time - tolerance);
      let best: Span | undefined;
      for (let i = first; i < spans.length; i++) {
        const span = spans[i];
        if (span.startTime > time + tolerance) break;
        if (
          span.endTime >= time - tolerance &&
          (!best || Math.abs(span.startTime - time) < Math.abs(best.startTime - time))
        )
          best = span;
      }
      return best ? { span: best, row, lane } : undefined;
    },
    [labelWidth, layout, timeAt, duration, plotWidth],
  );

  const coordinates = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top + scrollTop };
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const { x, y } = coordinates(event);
    if (x < labelWidth) {
      const row = layout.rows[firstVisibleRow(layout.rows, y)];
      if (row?.group)
        setCollapsed((old) => {
          const next = new Set(old);
          if (next.has(row.id)) next.delete(row.id);
          else next.add(row.id);
          return next;
        });
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const mode = event.button === 1 || event.shiftKey ? 'pan' : measureMode ? 'measure' : 'select';
    const next: Drag = {
      x,
      y,
      lastX: x,
      currentX: x,
      currentY: y,
      mode,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
    };
    dragRef.current = next;
    setDrag(next);
    if (mode === 'measure') setMeasurement({ start: timeAt(x), end: timeAt(x) });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = coordinates(event);
    const current = dragRef.current;
    if (!current) {
      setHover({
        x,
        y: y - scrollTop,
        clientX: event.clientX,
        clientY: event.clientY,
        span: hitTest(x, y)?.span,
      });
      return;
    }
    if (current.mode === 'pan') pan(current.lastX - x);
    if (current.mode === 'measure')
      setMeasurement({
        start: Math.min(timeAt(current.x), timeAt(x)),
        end: Math.max(timeAt(current.x), timeAt(x)),
      });
    const next = { ...current, lastX: x, currentX: x, currentY: y };
    dragRef.current = next;
    setDrag(next);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = dragRef.current;
    if (!current) return;
    const { x, y } = coordinates(event);
    const movement = Math.abs(x - current.x) + Math.abs(y - current.y);
    if (movement < 5 && current.mode !== 'measure') {
      const hit = hitTest(x, y);
      if (hit) {
        if (current.additive) {
          const ids = new Set(selectedIds);
          if (ids.has(hit.span.id)) ids.delete(hit.span.id);
          else ids.add(hit.span.id);
          onSelectionChange([...ids]);
        } else onSelectionChange([hit.span.id]);
      } else if (!current.additive) onSelectionChange([]);
    } else if (current.mode === 'select') {
      const start = timeAt(Math.min(current.x, x));
      const end = timeAt(Math.max(current.x, x));
      const minY = Math.min(current.y, y);
      const maxY = Math.max(current.y, y);
      const ids = new Set(current.additive ? selectedIds : []);
      for (let i = firstVisibleRow(layout.rows, minY); i < layout.rows.length; i++) {
        const row = layout.rows[i];
        if (row.y > maxY) break;
        const firstLane = Math.max(0, Math.floor((minY - row.y) / LANE_HEIGHT));
        const lastLane = Math.min(row.lanes.length - 1, Math.floor((maxY - row.y) / LANE_HEIGHT));
        for (let lane = firstLane; lane <= lastLane; lane++) {
          const spans = row.lanes[lane];
          for (let j = firstVisibleSpan(spans, start); j < spans.length; j++) {
            const span = spans[j];
            if (span.startTime > end) break;
            ids.add(span.id);
          }
        }
      }
      onSelectionChange([...ids]);
    }
    if (current.mode === 'measure') setMeasureMode(false);
    dragRef.current = null;
    setDrag(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const overviewDrag = useRef<number | null>(null);
  const overviewTime = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    return (
      bounds.start +
      Math.max(0, Math.min(1, (x - labelWidth) / plotWidth)) * (bounds.end - bounds.start)
    );
  };
  const visibleRows = layout.rows.slice(
    firstVisibleRow(layout.rows, scrollTop),
    firstVisibleRow(layout.rows, scrollTop + size.height) + 1,
  );
  return (
    <section className="trace-timeline" ref={rootRef} aria-label="Session performance timeline">
      {showHelp && (
        <div className="timeline-help">
          <span>
            <kbd>F</kbd> focus selected spans
          </span>
          <span>
            <kbd>W</kbd>/<kbd>S</kbd> zoom
          </span>
          <span>
            <kbd>A</kbd>/<kbd>D</kbd> pan
          </span>
          <span>
            <kbd>Ctrl</kbd> + wheel zoom at pointer
          </span>
          <span>Drag selects across tracks</span>
          <span>
            <kbd>Shift</kbd> + click adds spans
          </span>
          <span>
            <kbd>Shift</kbd> + drag pans
          </span>
          <span>
            <kbd>C</kbd> toggle critical path
          </span>
          <span>
            <kbd>M</kbd> measure
          </span>
          <span>
            <kbd>&gt;</kbd> all flows {showAllFlows ? 'on' : 'off'}
          </span>
          <span>
            <kbd>&lt;</kbd> selected flows {showSelectedFlows ? 'on' : 'off'}
          </span>
          <span>All flows takes precedence</span>
          <span>
            <kbd>[</kbd>/<kbd>]</kbd> follow links
          </span>
          <span>Focus canvas: arrows select, Shift adds, Home/End jump</span>
          <span>Double-click an agent to inspect</span>
        </div>
      )}
      <canvas
        className="timeline-overview"
        ref={overviewRef}
        aria-label="Session overview: drag to focus a time range"
        style={{ height: 42 }}
        onPointerDown={(event) => {
          overviewDrag.current = overviewTime(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (overviewDrag.current !== null) {
            const end = overviewTime(event);
            if (
              Math.abs(end - overviewDrag.current) >
              ((bounds.end - bounds.start) / plotWidth) * 3
            )
              setView(
                fitRange(
                  {
                    start: Math.min(overviewDrag.current, end),
                    end: Math.max(overviewDrag.current, end),
                  },
                  bounds,
                ),
              );
          }
        }}
        onPointerUp={(event) => {
          if (overviewDrag.current !== null) {
            const end = overviewTime(event);
            if (
              Math.abs(end - overviewDrag.current) <=
              ((bounds.end - bounds.start) / plotWidth) * 3
            )
              setView(fitRange({ start: end - duration / 2, end: end + duration / 2 }, bounds));
            overviewDrag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onDoubleClick={() => setView(boundsRef.current)}
      />
      <canvas
        className="timeline-ruler"
        ref={rulerRef}
        style={{ height: RULER_HEIGHT }}
        data-view-start={view.start}
        data-view-end={view.end}
        aria-label={`Visible time range ${formatDuration(view.start - bounds.start)} to ${formatDuration(view.end - bounds.start)}`}
      />
      <div
        className="timeline-viewport"
        ref={viewportRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className="timeline-scroll-content"
          style={{ height: Math.max(size.height, layout.height) }}
        >
          <canvas
            ref={canvasRef}
            className={`timeline-canvas ${measureMode ? 'is-measuring' : ''} ${drag?.mode === 'pan' ? 'is-panning' : ''}`}
            style={{ height: size.height }}
            tabIndex={0}
            role="application"
            aria-roledescription="Interactive performance timeline"
            aria-label={`Timeline with ${sessions.length} agents and ${layout.count.toLocaleString()} spans. Arrow keys select spans. Shift adds to selection. Home and End jump. Enter inspects the selected agent. Press question mark for all shortcuts.`}
            data-testid="timeline-canvas"
            data-agent-count={sessions.length}
            data-flow-count={flows.length}
            data-flow-mode={flowMode}
            data-show-all-flows={showAllFlows}
            data-show-selected-flows={showSelectedFlows}
            data-enabled-flow-count={enabledFlows.length}
            data-highlighted-id={highlightedId}
            data-span-count={layout.count}
            data-visible-rows={visibleRows.length}
            data-label-width={labelWidth}
            data-group-height={GROUP_HEIGHT}
            data-lane-height={LANE_HEIGHT}
            data-measure-start={measure?.start}
            data-measure-end={measure?.end}
            data-logical-track-count={layout.rows.filter((row) => !row.group).length}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onKeyDown={navigateCanvas}
            onPointerCancel={() => {
              dragRef.current = null;
              setDrag(null);
            }}
            onPointerLeave={() => {
              if (!dragRef.current) setHover(null);
            }}
            onDoubleClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const y = event.clientY - rect.top + scrollTop;
              const row = layout.rows[firstVisibleRow(layout.rows, y)];
              if (row?.group) onInspectSession?.(row.session.metadata.id);
              else if (hover?.span)
                setView(
                  focusRange({ start: hover.span.startTime, end: hover.span.endTime }, bounds),
                );
            }}
          />
        </div>
        {hover?.span && !drag && (
          <div
            className="timeline-tooltip"
            role="tooltip"
            style={{
              left: Math.max(4, Math.min(window.innerWidth - 350, hover.clientX + 12)),
              top: Math.min(window.innerHeight - 32, hover.clientY + 16),
            }}
          >
            <span>{formatDuration(hover.span.endTime - hover.span.startTime)}</span>{' '}
            <strong>{hover.span.name}</strong>
          </div>
        )}
      </div>
      <span className="timeline-sr-status" aria-live="polite">
        {`Flows: ${flowMode === 'selected' ? 'selected spans only' : flowMode}. `}
        {selectedIds.length > 0 &&
          (() => {
            const item = layout.positions.get(selectedIds.at(-1)!);
            return item
              ? `Selected ${item.span.name}, ${formatDuration(item.span.endTime - item.span.startTime)}, ${item.row.label}, ${item.span.status}. ${selectedIds.length} spans selected.`
              : '';
          })()}
      </span>
    </section>
  );
}
