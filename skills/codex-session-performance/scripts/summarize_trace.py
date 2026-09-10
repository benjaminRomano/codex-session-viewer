#!/usr/bin/env python3
"""Summarize normalized Session Viewer exports, without reading rollout payloads."""

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path


def bounds(item, start_key="startTime", end_key="endTime"):
    start, end = item[start_key], item[end_key]
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           or not math.isfinite(v) for v in (start, end)) or end < start:
        raise ValueError(f"Invalid interval: {start!r}, {end!r}")
    return start, end


def union_ms(intervals):
    total, previous_end = 0, None
    for start, end in sorted(intervals):
        total += max(0, end - max(start, previous_end if previous_end is not None else start))
        previous_end = max(end, previous_end if previous_end is not None else end)
    return total


def seconds(ms):
    return round(ms / 1000, 3)


def summarize(sessions, session_id, turn_selector=None, analysis=None, limit=15):
    if not isinstance(sessions, list):
        raise ValueError("--sessions must contain an array of normalized sessions")
    matches = [s for s in sessions if s.get("metadata", {}).get("id") == session_id]
    if len(matches) != 1:
        raise ValueError("Selected session must appear exactly once")
    session = matches[0]
    turns = session.get("turns", [])
    if not turns:
        raise ValueError("Selected session has no normalized turns")
    turn_rows = []
    for n, turn in enumerate(turns, 1):
        start, end = bounds(turn)
        turn_rows.append({"ordinal": n, "id": turn["id"], "startMs": start,
                          "endMs": end, "durationSeconds": seconds(end - start),
                          "status": turn.get("status", "unknown"),
                          "sourceLine": turn.get("sourceLine")})
    selected = turns
    if turn_selector is not None:
        selected = [t for n, t in enumerate(turns, 1)
                    if t["id"] == turn_selector or str(n) == turn_selector]
        if len(selected) != 1:
            raise ValueError("Turn selector must resolve to exactly one turn")
    start = min(bounds(t)[0] for t in selected)
    end = max(bounds(t)[1] for t in selected)
    active = union_ms([bounds(t) for t in selected])
    warnings = []
    if any(t.get("status") != "complete" for t in selected):
        warnings.append("Scope contains incomplete/unknown turns; bounds are observations, not completion.")
    metadata = session["metadata"]
    diagnostics = {k: metadata.get(k) for k in
                   ("recordCount", "malformedLines", "oversizedLines", "oversizedBytes",
                    "elidedStrings", "elidedBytes") if k in metadata}
    if any(diagnostics.get(k, 0) for k in ("malformedLines", "oversizedLines", "elidedStrings")):
        warnings.append("Some source content was malformed, skipped, or elided; inspect relevant raw records.")
    result = {"sessionId": session_id, "turns": turn_rows,
              "scope": {"turnIds": [t["id"] for t in selected], "startMs": start,
                        "endMs": end, "elapsedSeconds": seconds(end - start),
                        "activeTurnUnionSeconds": seconds(active),
                        "betweenTurnGapSeconds": seconds(end - start - active)},
              "diagnostics": diagnostics, "warnings": warnings}
    result["intentEvidence"] = "Not assessed: zero parse errors does not imply an available original task. Inspect relevant messages; child titles may come from later replies."
    indexed = {s["metadata"]["id"]: s for s in sessions}
    pending = list(metadata.get("childIds", []))
    pending.extend(s["metadata"]["id"] for s in sessions
                   if s["metadata"].get("parentId") == session_id)
    seen, related = {session_id}, []
    while pending:
        child_id = pending.pop()
        if child_id in seen:
            continue
        seen.add(child_id)
        child = indexed.get(child_id)
        if child is None:
            warnings.append(f"Missing descendant export: {child_id}")
            continue
        pending.extend(child["metadata"].get("childIds", []))
        pending.extend(s["metadata"]["id"] for s in sessions
                       if s["metadata"].get("parentId") == child_id)
        related_turns = []
        for turn in child.get("turns", []):
            left, right = bounds(turn)
            if right < start or left > end:
                continue
            related_turns.append({"id": turn["id"], "startMs": left, "endMs": right,
                                  "status": turn.get("status", "unknown")})
        related.append({"sessionId": child_id, "turnsIntersectingScope": related_turns})
    result["descendantContext"] = related
    if analysis is None:
        return result
    path = analysis["path"]
    segments = []
    tracks, agents = defaultdict(float), defaultdict(float)
    for segment in path["segments"]:
        left, right = bounds(segment, "start", "end")
        left, right = max(start, left), min(end, right)
        if right <= left:
            continue
        span = segment["span"]
        duration = right - left
        track, agent = span["track"], span["sessionId"]
        tracks[track] += duration
        agents[agent] += duration
        segments.append({"spanId": span["id"], "sessionId": agent,
                         "track": track, "startMs": left, "endMs": right,
                         "durationSeconds": seconds(duration),
                         "sourceLine": span.get("sourceLine"),
                         "outputLine": span.get("outputLine"),
                         "inferred": span.get("inferred", None)})
    coverage = union_ms([(x["startMs"], x["endMs"]) for x in segments])
    summed = sum(tracks.values())
    overlap = max(0, summed - coverage)
    if overlap > 0.001:
        warnings.append("Path segments overlap: category sums are not an exclusive wall-time breakdown.")
    if end - start - coverage > 1:
        warnings.append("Path does not cover the entire requested scope; gaps are unattributed.")
    if not segments:
        warnings.append("No positive path segments intersect the selected scope; verify the analysis input.")
    known_spans = {x["id"]: x for s in sessions for x in s.get("spans", [])}
    if any(x["spanId"] not in known_spans for x in segments):
        warnings.append("Some path spans are absent from the supplied sessions; verify export provenance.")
    grouped = defaultdict(list)
    for segment in segments:
        grouped[segment["spanId"]].append(segment)
    operations = []
    for span_id, fragments in grouped.items():
        sample = fragments[0]
        operation = {k: sample[k] for k in ("spanId", "sessionId", "track", "sourceLine", "outputLine", "inferred")}
        operation["fragmentCount"] = len(fragments)
        operation["exposedSeconds"] = seconds(union_ms([(x["startMs"], x["endMs"]) for x in fragments]))
        original = known_spans.get(span_id)
        if original is not None:
            left, right = bounds(original)
            operation["normalizedSpanLifetimeSeconds"] = seconds(right - left)
            operation["scopeClippedLifetimeSeconds"] = seconds(max(0, min(end, right) - max(start, left)))
        operations.append(operation)
    result["path"] = {
        "segmentCount": len(segments), "coverageSeconds": seconds(coverage),
        "uncoveredSeconds": seconds(end - start - coverage),
        "overlapSeconds": seconds(overlap),
        "categorySummedSeconds": {k: seconds(v) for k, v in sorted(tracks.items(), key=lambda x: -x[1])},
        "agentSummedSeconds": {k: seconds(v) for k, v in sorted(agents.items(), key=lambda x: -x[1])},
        "topSegments": sorted(segments, key=lambda x: -x["durationSeconds"])[:limit],
        "topOperations": sorted(operations, key=lambda x: -x["exposedSeconds"])[:limit],
        "interpretation": "Reconstructed path only. Infer causal dependencies from source evidence; inference gaps are not measured model compute."
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions", required=True, type=Path)
    parser.add_argument("--session", required=True)
    parser.add_argument("--turn", help="Stable turn ID or one-based ordinal")
    parser.add_argument("--analysis", type=Path)
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error("--limit must be between 1 and 100")
    try:
        sessions = json.loads(args.sessions.read_text())
        analysis = json.loads(args.analysis.read_text()) if args.analysis else None
        print(json.dumps(summarize(sessions, args.session, args.turn, analysis, args.limit), indent=2))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"Cannot summarize trace: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
