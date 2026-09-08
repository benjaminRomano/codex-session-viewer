import { describe, expect, it } from 'vitest';
import {
  firstVisibleSpan,
  fitRange,
  focusRange,
  normalizeCriticalSegments,
  partitionLanes,
  perfettoHash,
  sliceColor,
  wheelZoomRatio,
  zoomRange,
} from './perfetto';
import type { Span } from '../types';

function span(id: string, startTime: number, endTime: number): Span {
  return {
    id,
    startTime,
    endTime,
    sessionId: 'session',
    track: 'shell',
    name: id,
    status: 'complete',
    inferred: false,
  };
}

describe('Perfetto source fidelity', () => {
  it('matches the upstream hash and procedural HSLuv color vectors', () => {
    expect(perfettoHash('Model inference', 360)).toBe(232);
    expect(perfettoHash('exec_command', 360)).toBe(28);
    expect(sliceColor('Model inference').base).toBe('rgb(88 186 235)');
    expect(sliceColor('exec_command').base).toBe('rgb(241 138 91)');
    expect(sliceColor('functions.exec').base).toBe('rgb(68 156 166)');
    expect(sliceColor('Skill read').base).toBe('rgb(62 163 82)');
    expect(sliceColor('spawn_agent').base).toBe('rgb(49 127 98)');
    expect(sliceColor('exec_command 123')).toEqual(sliceColor('exec_command'));
    expect(sliceColor('exec_command').variant).not.toBe(sliceColor('exec_command').base);
  });

  it('uses logarithmic wheel zoom and preserves the time under the pointer', () => {
    expect(wheelZoomRatio(0)).toBe(1);
    expect(wheelZoomRatio(3)).toBeCloseTo(1.04);
    expect(wheelZoomRatio(-3)).toBeCloseTo(0.96);
    expect(wheelZoomRatio(127)).toBeCloseTo(1.14);
    const before = { start: 100, end: 1100 };
    const after = zoomRange(before, 0.5, 0.2, { start: 0, end: 2000 });
    expect(after).toEqual({ start: 200, end: 700 });
    expect(before.start + (before.end - before.start) * 0.2).toBe(
      after.start + (after.end - after.start) * 0.2,
    );
  });

  it('fits pan and extreme zoom to bounds without an inverted or zero interval', () => {
    const bounds = { start: 100, end: 1000 };
    expect(fitRange({ start: -100, end: 200 }, bounds)).toEqual({ start: 100, end: 400 });
    expect(fitRange({ start: 900, end: 1200 }, bounds)).toEqual({ start: 700, end: 1000 });
    expect(zoomRange(bounds, 1000, 0.5, bounds)).toEqual(bounds);
    const tiny = zoomRange(bounds, 0, 0.5, bounds);
    expect(tiny.end).toBeGreaterThan(tiny.start);
  });

  it('centers selected spans at 80% fill on the first focus command', () => {
    const focused = focusRange({ start: 400, end: 600 }, { start: 0, end: 1000 });
    expect(focused).toEqual({ start: 375, end: 625 });
    expect(200 / (focused.end - focused.start)).toBe(0.8);
    expect(focusRange({ start: 0, end: 200 }, { start: 0, end: 1000 })).toEqual({
      start: 0,
      end: 250,
    });
    expect(focusRange({ start: 0, end: 1000 }, { start: 0, end: 1000 })).toEqual({
      start: 0,
      end: 1000,
    });
    const instant = focusRange({ start: 500, end: 500 }, { start: 0, end: 1000 });
    expect(instant.end).toBeGreaterThan(instant.start);
    expect((instant.start + instant.end) / 2).toBeCloseTo(500);
  });
});

describe('virtualized trace interval layout', () => {
  it('retains separate portions of a wait around child work in monotonic critical-path order', () => {
    expect(
      normalizeCriticalSegments(
        [
          { spanId: 'wait', start: 80, end: 100 },
          { spanId: 'child', start: 40, end: 80 },
          { spanId: 'wait', start: 20, end: 40 },
        ],
        { start: 25, end: 95 },
      ),
    ).toEqual([
      { spanId: 'wait', start: 25, end: 40 },
      { spanId: 'child', start: 40, end: 80 },
      { spanId: 'wait', start: 80, end: 95 },
    ]);
  });

  it('clips overlapping or invalid critical geometry instead of connecting backwards', () => {
    expect(
      normalizeCriticalSegments(
        [
          { spanId: 'a', start: 0, end: 10 },
          { spanId: 'b', start: 5, end: 15 },
          { spanId: 'a', start: 0, end: 10 },
          { spanId: 'bad', start: NaN, end: 100 },
        ],
        { start: 0, end: 20 },
      ),
    ).toEqual([
      { spanId: 'a', start: 0, end: 10 },
      { spanId: 'b', start: 10, end: 15 },
    ]);
  });

  it('partitions overlapping spans while reusing lanes for touching intervals', () => {
    const input = [span('c', 4, 6), span('a', 0, 10), span('b', 0, 4), span('d', 10, 11)];
    const lanes = partitionLanes(input);
    expect(lanes).toHaveLength(2);
    expect(
      lanes
        .flat()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['a', 'b', 'c', 'd']);
    for (const lane of lanes)
      for (let i = 1; i < lane.length; i++)
        expect(lane[i].startTime).toBeGreaterThanOrEqual(lane[i - 1].endTime);
    expect(input[0].id).toBe('c');
  });

  it('retains zero-duration events and handles thousands of simultaneous operations', () => {
    const input = Array.from({ length: 5000 }, (_, i) => span(String(i), 0, 10));
    const lanes = partitionLanes(input);
    expect(lanes).toHaveLength(5000);
    expect(lanes.flat()).toHaveLength(5000);
    expect(partitionLanes([span('one', 0, 0), span('two', 0, 0)])).toHaveLength(2);
  });

  it('finds spans crossing the left viewport edge and includes exact edge events', () => {
    const lane = [span('a', 0, 5), span('b', 10, 20), span('instant', 25, 25)];
    expect(firstVisibleSpan(lane, -1)).toBe(0);
    expect(firstVisibleSpan(lane, 5)).toBe(0);
    expect(firstVisibleSpan(lane, 6)).toBe(1);
    expect(firstVisibleSpan(lane, 15)).toBe(1);
    expect(firstVisibleSpan(lane, 25)).toBe(2);
    expect(firstVisibleSpan(lane, 26)).toBe(3);
    expect(firstVisibleSpan([], 0)).toBe(0);
  });
});
