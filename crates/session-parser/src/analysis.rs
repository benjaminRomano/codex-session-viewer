//! Trace analysis is shared by native validation and the browser WASM worker.
//! This is a reconstructed blocking chain, because rollout logs do not prove
//! scheduling causality or every wait's exact completion dependency.
use crate::{AgentOperation, ParsedSession, Span};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub id: String,
    pub source_span_id: String,
    pub target_span_id: String,
    pub kind: String,
    pub inferred: bool,
    pub source_time: f64,
    pub target_time: f64,
}
#[derive(Clone, Debug, Serialize)]
pub struct CriticalSegment {
    pub span: Span,
    pub start: f64,
    pub end: f64,
    pub duration: f64,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct CriticalPath {
    pub segments: Vec<CriticalSegment>,
    pub total: f64,
    pub observed: f64,
    pub inferred: f64,
    pub suggestions: Vec<String>,
    pub statistics: Vec<Statistic>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Statistic {
    pub name: String,
    pub count: usize,
    pub total: f64,
    pub max: f64,
    pub track: String,
}
#[derive(Debug, Serialize)]
pub struct Analysis {
    pub flows: Vec<Flow>,
    pub path: CriticalPath,
    pub statistics: Vec<Statistic>,
}

fn excluded(span: &Span) -> bool {
    matches!(span.track.as_str(), "turns" | "messages" | "system")
}
fn priority(span: &Span) -> u8 {
    match span.track.as_str() {
        "inference" => 0,
        "code" => 1,
        _ => 2,
    }
}
fn session_map(sessions: &[ParsedSession]) -> HashMap<&str, &ParsedSession> {
    let mut map = HashMap::new();
    for session in sessions {
        map.insert(session.metadata.id.as_str(), session);
        if let Some(path) = &session.metadata.agent_path {
            map.insert(path, session);
        }
    }
    // Root metadata in older logs omits agent_path even though messages target /root.
    let mut roots = sessions
        .iter()
        .filter(|session| session.metadata.parent_id.is_none());
    if let (Some(root), None) = (roots.next(), roots.next()) {
        map.entry("/root").or_insert(root);
    }
    map
}
fn operation_targets<'a>(
    by_id: &HashMap<&str, &'a ParsedSession>,
    parent: &ParsedSession,
    operation: &AgentOperation,
    span: &Span,
) -> Vec<&'a ParsedSession> {
    let outcome = span
        .output
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
    if operation.kind == "wait"
        && outcome.as_ref().is_some_and(|output| {
            output["timed_out"].as_bool() == Some(true)
                || output["message"]
                    .as_str()
                    .is_some_and(|message| message.to_ascii_lowercase().contains("interrupt"))
        })
    {
        return Vec::new();
    }
    let mut targets: Vec<_> = operation
        .target_ids
        .iter()
        .filter_map(|id| {
            by_id.get(id.as_str()).copied().or_else(|| {
                if id.is_empty() || id.starts_with('/') || crate::is_thread_id(id) {
                    return None;
                }
                // Task names are relative to the sender, never a global basename.
                // Older root records omit their path; missing child paths are ambiguous.
                let path = parent
                    .metadata
                    .agent_path
                    .as_deref()
                    .or_else(|| parent.metadata.parent_id.is_none().then_some("/root"))?;
                by_id.get(format!("{path}/{id}").as_str()).copied()
            })
        })
        .collect();
    if operation.kind == "wait"
        && operation.target_ids.is_empty()
        && crate::normalized(&span.name) == "wait_agent"
        && outcome.as_ref().is_some_and(|output| {
            output["timed_out"].as_bool() == Some(false)
                && output["message"].as_str().is_some_and(|message| {
                    message
                        .trim()
                        .trim_end_matches('.')
                        .eq_ignore_ascii_case("Wait completed")
                })
        })
    {
        // This tool waits for any child mailbox update. A successful result plus
        // a recorded direct-child completion within the interval permits the
        // same reconstructed join as a named wait; timeout alone never does.
        let reported = outcome.as_ref().map(crate::targets).unwrap_or_default();
        targets.extend(by_id.values().copied().filter(|child| {
            child.metadata.parent_id.as_deref() == Some(&parent.metadata.id)
                && (reported.is_empty()
                    || reported.iter().any(|id| {
                        by_id
                            .get(id.as_str())
                            .is_some_and(|matched| matched.metadata.id == child.metadata.id)
                    }))
        }));
    }
    targets.sort_by(|a, b| a.metadata.id.cmp(&b.metadata.id));
    targets.dedup_by(|a, b| a.metadata.id == b.metadata.id);
    targets
}
pub fn build_flows(sessions: &[ParsedSession], start: f64, end: f64) -> Vec<Flow> {
    let by_id = session_map(sessions);
    let mut flows = Vec::new();
    let mut seen = HashSet::new();
    let mut matched_receives = HashSet::new();
    for session in sessions {
        let spans: HashMap<&str, &Span> = session
            .spans
            .iter()
            .map(|span| (span.id.as_str(), span))
            .collect();
        for op in &session.agent_operations {
            let Some(source) = spans.get(op.span_id.as_str()) else {
                continue;
            };
            if source.end_time < start || source.start_time > end {
                continue;
            }
            for target in operation_targets(&by_id, session, op, source) {
                if target.metadata.id == session.metadata.id {
                    continue;
                }
                let endpoint = if op.kind == "wait" {
                    // An arbitrary child output during a timed-out wait is not a completed join.
                    let completion = target
                        .turns
                        .iter()
                        .filter(|turn| {
                            matches!(turn.status.as_str(), "complete" | "completed")
                                && turn.end_time >= source.start_time
                                && turn.end_time <= source.end_time
                        })
                        .max_by(|a, b| a.end_time.total_cmp(&b.end_time));
                    completion.and_then(|turn| {
                        target
                            .spans
                            .iter()
                            .filter(|span| {
                                span.end_time <= turn.end_time
                                    && span.end_time >= source.start_time
                                    && span.track != "turns"
                            })
                            .max_by(|a, b| a.end_time.total_cmp(&b.end_time))
                    })
                } else if op.kind == "send" {
                    target
                        .spans
                        .iter()
                        .filter(|span| {
                            span.track == "agent_messages"
                                && span.name == "Agent message received"
                                && span.start_time >= source.start_time
                                && !matched_receives.contains(span.id.as_str())
                                && span.target_agent_id.as_deref().is_none_or(|sender| {
                                    sender == session.metadata.id
                                        || by_id.get(sender).is_some_and(|origin| {
                                            origin.metadata.id == session.metadata.id
                                        })
                                })
                        })
                        .min_by(|a, b| {
                            let correlates = |span: &Span| {
                                source.call_id.is_some() && source.call_id == span.call_id
                            };
                            correlates(b)
                                .cmp(&correlates(a))
                                .then_with(|| a.start_time.total_cmp(&b.start_time))
                                .then_with(|| a.id.cmp(&b.id))
                        })
                } else {
                    target
                        .spans
                        .iter()
                        .filter(|span| {
                            span.start_time >= op.timestamp
                                && if op.kind == "spawn" {
                                    span.track == "turns"
                                } else {
                                    span.track != "turns"
                                }
                        })
                        .min_by(|a, b| a.start_time.total_cmp(&b.start_time))
                };
                let Some(endpoint) = endpoint else {
                    continue;
                };
                if endpoint.end_time < start || endpoint.start_time > end {
                    continue;
                }
                if op.kind == "send" {
                    matched_receives.insert(endpoint.id.as_str());
                }
                let (source_id, target_id) = if op.kind == "wait" {
                    (&endpoint.id, &source.id)
                } else {
                    (&source.id, &endpoint.id)
                };
                let id = format!("{source_id}:{target_id}:{}", op.kind);
                if seen.insert(id.clone()) {
                    flows.push(Flow {
                        id,
                        source_span_id: source_id.clone(),
                        target_span_id: target_id.clone(),
                        kind: op.kind.clone(),
                        inferred: true,
                        source_time: if op.kind == "wait" {
                            endpoint.end_time
                        } else {
                            source.start_time
                        },
                        target_time: if op.kind == "wait" {
                            source.end_time
                        } else {
                            endpoint.start_time
                        },
                    });
                }
            }
        }
    }
    flows
}

fn append(segments: &mut Vec<CriticalSegment>, span: &Span, start: f64, end: f64) {
    if end <= start {
        return;
    }
    if let Some(last) = segments.last_mut() {
        if last.span.id == span.id && last.end == start {
            last.end = end;
            last.duration += end - start;
            return;
        }
    }
    segments.push(CriticalSegment {
        span: span.clone(),
        start,
        end,
        duration: end - start,
    });
}
fn walk(
    by_id: &HashMap<&str, &ParsedSession>,
    id: &str,
    start: f64,
    end: f64,
    visited: &mut HashSet<String>,
) -> Vec<CriticalSegment> {
    let Some(session) = by_id.get(id) else {
        return Vec::new();
    };
    if !visited.insert(session.metadata.id.clone()) {
        return Vec::new();
    }
    let spans: Vec<&Span> = session
        .spans
        .iter()
        .filter(|span| {
            !excluded(span)
                && span.end_time > span.start_time
                && span.end_time > start
                && span.start_time < end
        })
        .collect();
    let mut events: Vec<(f64, bool, usize)> = spans
        .iter()
        .enumerate()
        .flat_map(|(i, span)| {
            [
                (span.start_time.max(start), true, i),
                (span.end_time.min(end), false, i),
            ]
        })
        .collect();
    events.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    let mut active = HashSet::new();
    let mut segments = Vec::new();
    let mut previous = start;
    for (time, is_start, index) in events {
        if time > previous {
            let selected = active
                .iter()
                .copied()
                .map(|i: usize| spans[i])
                .min_by(|a, b| {
                    priority(b)
                        .cmp(&priority(a))
                        .then_with(|| {
                            (a.end_time - a.start_time).total_cmp(&(b.end_time - b.start_time))
                        })
                        .then_with(|| a.id.cmp(&b.id))
                });
            if let Some(span) = selected {
                append(&mut segments, span, previous, time);
            }
        }
        if is_start {
            active.insert(index);
        } else {
            active.remove(&index);
        }
        previous = time;
    }
    let mut result = Vec::new();
    for segment in segments {
        if segment.span.track != "agent_wait" {
            result.push(segment);
            continue;
        }
        let op = session
            .agent_operations
            .iter()
            .find(|op| op.span_id == segment.span.id && op.kind == "wait");
        let finished = op
            .into_iter()
            .flat_map(|op| operation_targets(by_id, session, op, &segment.span))
            .filter_map(|child| {
                child
                    .turns
                    .iter()
                    .filter(|turn| {
                        matches!(turn.status.as_str(), "complete" | "completed")
                            && turn.end_time >= segment.start
                            && turn.end_time <= segment.end
                    })
                    .max_by(|a, b| a.end_time.total_cmp(&b.end_time))
                    .map(|turn| (child.metadata.id.as_str(), turn.end_time))
            })
            .max_by(|a, b| a.1.total_cmp(&b.1));
        let Some((child_id, completion)) = finished else {
            result.push(segment);
            continue;
        };
        let children = walk(by_id, child_id, segment.start, completion, visited);
        if children.is_empty() {
            result.push(segment);
            continue;
        }
        let mut cursor = segment.start;
        for child in children {
            if child.start > cursor {
                append(&mut result, &segment.span, cursor, child.start);
            }
            cursor = child.end;
            result.push(child);
        }
        if cursor < segment.end {
            append(&mut result, &segment.span, cursor, segment.end);
        }
    }
    visited.remove(&session.metadata.id);
    result
}
pub fn aggregate(spans: &[Span]) -> Vec<Statistic> {
    let mut map: BTreeMap<(String, String), Statistic> = BTreeMap::new();
    for span in spans {
        let duration = (span.end_time - span.start_time).max(0.0);
        let row = map
            .entry((span.track.clone(), span.name.clone()))
            .or_insert_with(|| Statistic {
                name: span.name.clone(),
                count: 0,
                total: 0.0,
                max: 0.0,
                track: span.track.clone(),
            });
        row.count += 1;
        row.total += duration;
        row.max = row.max.max(duration);
    }
    let mut rows: Vec<_> = map.into_values().collect();
    rows.sort_by(|a, b| {
        b.total
            .total_cmp(&a.total)
            .then_with(|| a.name.cmp(&b.name))
    });
    rows
}
fn duration(ms: f64) -> String {
    if ms < 1.0 {
        format!("{:.0} µs", ms * 1000.0)
    } else if ms < 1000.0 {
        format!("{ms:.0} ms")
    } else if ms < 60_000.0 {
        format!("{:.2} s", ms / 1000.0)
    } else {
        format!(
            "{}m {:.0}s",
            (ms / 60_000.0).floor(),
            ms % 60_000.0 / 1000.0
        )
    }
}
pub fn critical_path(
    sessions: &[ParsedSession],
    root_id: &str,
    start: f64,
    end: f64,
) -> CriticalPath {
    let segments = walk(
        &session_map(sessions),
        root_id,
        start,
        end,
        &mut HashSet::new(),
    );
    let observed = segments
        .iter()
        .filter(|s| !s.span.inferred)
        .map(|s| s.duration)
        .sum();
    let inferred = segments
        .iter()
        .filter(|s| s.span.inferred)
        .map(|s| s.duration)
        .sum();
    let mut merged: HashMap<&str, Span> = HashMap::new();
    // Count each operation once even if nesting splits its contribution into segments.
    for segment in &segments {
        let span = merged.entry(&segment.span.id).or_insert_with(|| {
            let mut s = segment.span.clone();
            s.start_time = 0.0;
            s.end_time = 0.0;
            s
        });
        span.end_time += segment.duration;
    }
    let stats = aggregate(&merged.into_values().collect::<Vec<_>>());
    let mut suggestions = Vec::new();
    if let Some(slowest) = stats.first() {
        suggestions.push(format!("{} accounts for {} of the critical path. Inspect its inputs and output before optimizing it.",slowest.name,duration(slowest.total)));
    }
    if let Some(repeated) = stats
        .iter()
        .filter(|s| s.count >= 3)
        .max_by_key(|s| s.count)
    {
        suggestions.push(format!("{} occurs {} times on the path. Combining independent calls may reduce dispatch overhead.",repeated.name,repeated.count));
    }
    let waiting: f64 = segments
        .iter()
        .filter(|s| s.span.track == "agent_wait")
        .map(|s| s.duration)
        .sum();
    if waiting > 1000.0 {
        suggestions.push(format!("{} remains in agent waits. Check whether work can start earlier or use a narrower completion dependency.",duration(waiting)));
    }
    CriticalPath {
        segments,
        total: observed + inferred,
        observed,
        inferred,
        suggestions,
        statistics: stats,
    }
}
pub fn analyze(sessions: &[ParsedSession], root_id: &str, start: f64, end: f64) -> Analysis {
    let spans: Vec<Span> = sessions
        .iter()
        .flat_map(|s| &s.spans)
        .filter(|span| span.track != "turns" && span.end_time >= start && span.start_time <= end)
        .map(|span| {
            let mut span = span.clone();
            span.start_time = span.start_time.max(start);
            span.end_time = span.end_time.min(end);
            span
        })
        .collect();
    Analysis {
        flows: build_flows(sessions, start, end),
        path: critical_path(sessions, root_id, start, end),
        statistics: aggregate(&spans),
    }
}
