use session_parser::{
    analysis::{aggregate, analyze, build_flows, critical_path},
    AgentOperation, ParsedSession, SessionMetadata, Span, Turn,
};

#[test]
fn invalid_analysis_inputs_return_native_errors_without_panicking() {
    assert!(session_parser::analyze_sessions("{", "root", 0.0, 1.0).is_err());
    assert!(session_parser::analyze_sessions("[]", "root", 1.0, 0.0).is_err());
    assert!(session_parser::analyze_sessions("[]", "root", f64::NAN, 1.0).is_err());
    assert!(session_parser::aggregate_spans("{").is_err());
}

fn span(id: &str, session: &str, track: &str, start: f64, end: f64) -> Span {
    Span {
        id: id.into(),
        session_id: session.into(),
        track: track.into(),
        name: track.into(),
        start_time: start,
        end_time: end,
        status: "complete".into(),
        ..Default::default()
    }
}
fn session(id: &str, spans: Vec<Span>) -> ParsedSession {
    ParsedSession {
        metadata: SessionMetadata {
            id: id.into(),
            agent_path: Some(format!("/root/{id}")),
            ..Default::default()
        },
        spans,
        ..Default::default()
    }
}
fn op(span: &str, kind: &str, target: &str, time: f64) -> AgentOperation {
    AgentOperation {
        span_id: span.into(),
        kind: kind.into(),
        target_ids: vec![target.into()],
        timestamp: time,
        description: None,
    }
}
fn turn(id: &str, end: f64, status: &str) -> Turn {
    Turn {
        id: id.into(),
        index: 0,
        title: id.into(),
        start_time: 0.0,
        end_time: end,
        model: "synthetic".into(),
        status: status.into(),
        prompt: String::new(),
        source_line: None,
    }
}

#[test]
fn nested_wrappers_do_not_double_count_and_focus_clips() {
    let root = session(
        "root",
        vec![
            span("wrapper", "root", "code", 0.0, 100.0),
            span("shell", "root", "shell", 20.0, 80.0),
        ],
    );
    let path = critical_path(&[root], "root", 10.0, 90.0);
    assert_eq!(path.total, 80.0);
    assert_eq!(path.segments.len(), 3);
    assert_eq!(path.segments[1].span.id, "shell");
    assert_eq!(path.segments[0].start, 10.0);
    assert_eq!(path.segments[2].end, 90.0);
    assert_eq!(
        path.statistics
            .iter()
            .find(|s| s.track == "code")
            .unwrap()
            .count,
        1
    );
}
#[test]
fn critical_path_follows_latest_completed_child_and_preserves_wait_tail() {
    let mut root = session("root", vec![span("wait", "root", "agent_wait", 0.0, 100.0)]);
    root.agent_operations.push(op("wait", "wait", "child", 0.0));
    let mut child = session("child", vec![span("tool", "child", "shell", 10.0, 70.0)]);
    child.turns.push(turn("child-turn", 80.0, "complete"));
    let path = critical_path(&[root, child], "root", 0.0, 100.0);
    assert_eq!(path.total, 100.0);
    assert!(path.segments.iter().any(|s| s.span.id == "tool"));
    assert_eq!(path.segments.last().unwrap().end, 100.0);
}
#[test]
fn critical_path_recursively_enters_grandchild_waits_without_double_counting() {
    let mut root = session(
        "root",
        vec![span("root-wait", "root", "agent_wait", 0.0, 100.0)],
    );
    root.agent_operations
        .push(op("root-wait", "wait", "child", 0.0));
    let mut child = session(
        "child",
        vec![span("child-wait", "child", "agent_wait", 10.0, 90.0)],
    );
    child
        .agent_operations
        .push(op("child-wait", "wait", "grandchild", 10.0));
    child.turns.push(turn("child-turn", 95.0, "complete"));
    let mut grandchild = session(
        "grandchild",
        vec![span("grandchild-tool", "grandchild", "shell", 20.0, 60.0)],
    );
    grandchild
        .turns
        .push(turn("grandchild-turn", 70.0, "complete"));
    let path = critical_path(&[root, child, grandchild], "root", 0.0, 100.0);
    assert_eq!(path.total, 100.0);
    assert_eq!(
        path.segments
            .iter()
            .filter(|s| s.span.session_id == "grandchild")
            .map(|s| s.duration)
            .sum::<f64>(),
        40.0
    );
    assert!(path.segments.iter().any(|s| s.span.session_id == "child"));
    assert!(path
        .segments
        .windows(2)
        .all(|pair| pair[0].end <= pair[1].start));
}
#[test]
fn successful_targetless_mailbox_wait_joins_only_direct_completed_children() {
    for (outcome, joins) in [
        (r#"{"message":"Wait completed.","timed_out":false}"#, true),
        (r#"{"message":"Wait timed out.","timed_out":true}"#, false),
        (
            r#"{"message":"Wait interrupted by new input.","timed_out":false}"#,
            false,
        ),
        (r#"{"message":"Unknown outcome.","timed_out":false}"#, false),
    ] {
        let mut wait = span("wait", "root", "agent_wait", 0.0, 100.0);
        wait.name = "wait_agent".into();
        wait.output = Some(outcome.into());
        let mut root = session("root", vec![wait]);
        let mut wait_op = op("wait", "wait", "", 0.0);
        wait_op.target_ids.clear();
        root.agent_operations.push(wait_op);
        let mut child = session(
            "child",
            vec![span("child-tool", "child", "shell", 10.0, 60.0)],
        );
        child.metadata.parent_id = Some("root".into());
        child.turns.push(turn("child-turn", 70.0, "complete"));
        let mut other = session(
            "other",
            vec![span("unrelated-tool", "other", "shell", 0.0, 90.0)],
        );
        other.metadata.parent_id = Some("some-other-root".into());
        other.turns.push(turn("other-turn", 95.0, "complete"));
        let sessions = [root, child, other];
        let path = critical_path(&sessions, "root", 0.0, 100.0);
        assert_eq!(path.total, 100.0);
        assert_eq!(
            path.segments
                .iter()
                .any(|segment| segment.span.id == "child-tool"),
            joins
        );
        assert!(!path
            .segments
            .iter()
            .any(|segment| segment.span.id == "unrelated-tool"));
        assert_eq!(!build_flows(&sessions, 0.0, 100.0).is_empty(), joins);
    }
}
#[test]
fn timed_out_wait_does_not_invent_a_join() {
    let mut root = session("root", vec![span("wait", "root", "agent_wait", 0.0, 100.0)]);
    root.agent_operations.push(op("wait", "wait", "child", 0.0));
    let mut child = session("child", vec![span("tool", "child", "shell", 10.0, 70.0)]);
    child.turns.push(turn("child-turn", 80.0, "running"));
    let sessions = [root, child];
    let path = critical_path(&sessions, "root", 0.0, 100.0);
    assert_eq!(path.segments.len(), 1);
    assert_eq!(path.segments[0].span.id, "wait");
    assert!(build_flows(&sessions, 0.0, 100.0).is_empty());
}
#[test]
fn cycles_terminate_and_never_inflate_elapsed_time() {
    let mut root = session(
        "root",
        vec![span("root-wait", "root", "agent_wait", 0.0, 100.0)],
    );
    root.agent_operations
        .push(op("root-wait", "wait", "child", 0.0));
    root.turns.push(turn("root-turn", 100.0, "complete"));
    let mut child = session(
        "child",
        vec![span("child-wait", "child", "agent_wait", 0.0, 100.0)],
    );
    child
        .agent_operations
        .push(op("child-wait", "wait", "root", 0.0));
    child.turns.push(turn("child-turn", 100.0, "complete"));
    assert_eq!(
        critical_path(&[root, child], "root", 0.0, 100.0).total,
        100.0
    );
}
#[test]
fn flows_resolve_canonical_paths_and_focus_hides_outside_endpoints() {
    let mut root = session(
        "root",
        vec![span("send", "root", "agent_messages", 20.0, 21.0)],
    );
    root.agent_operations
        .push(op("send", "send", "/root/child", 20.0));
    let mut receive = span("receive", "child", "agent_messages", 22.0, 22.0);
    receive.name = "Agent message received".into();
    let child = session("child", vec![receive]);
    let sessions = [root, child];
    let flows = build_flows(&sessions, 0.0, 100.0);
    assert_eq!(flows.len(), 1);
    assert_eq!(flows[0].source_span_id, "send");
    assert_eq!(flows[0].target_span_id, "receive");
    assert!(build_flows(&sessions, 50.0, 100.0).is_empty());
}
#[test]
fn send_flows_use_sender_matched_receives_and_prefer_explicit_correlation() {
    let mut source = session(
        "source",
        vec![
            span("send-one", "source", "agent_messages", 10.0, 11.0),
            span("send-two", "source", "agent_messages", 12.0, 13.0),
        ],
    );
    source.spans[0].call_id = Some("message-one".into());
    source.metadata.parent_id = Some("target".into());
    source
        .agent_operations
        .push(op("send-one", "send", "/root", 10.0));
    source
        .agent_operations
        .push(op("send-two", "send", "/root", 12.0));
    let receive = |id: &str, time: f64, sender: &str, correlation: Option<&str>| {
        let mut value = span(id, "target", "agent_messages", time, time);
        value.name = "Agent message received".into();
        value.target_agent_id = Some(sender.into());
        value.call_id = correlation.map(str::to_owned);
        value
    };
    let mut target = session(
        "target",
        vec![
            span("earlier-inference", "target", "inference", 10.0, 20.0),
            receive("wrong-sender", 14.0, "/root/other", None),
            receive("second-receive", 15.0, "/root/source", None),
            receive(
                "correlated-receive",
                16.0,
                "/root/source",
                Some("message-one"),
            ),
        ],
    );
    target.metadata.agent_path = None;
    let flows = build_flows(&[source, target], 0.0, 100.0);
    assert_eq!(flows.len(), 2);
    assert_eq!(flows[0].target_span_id, "correlated-receive");
    assert_eq!(flows[1].target_span_id, "second-receive");
    assert_eq!(flows[0].target_time, 16.0);
    assert!(flows.iter().all(|f| f.source_time <= f.target_time));
}
#[test]
fn deterministic_overlap_choice_and_statistics() {
    let spans = vec![
        span("b", "root", "shell", 0.0, 50.0),
        span("a", "root", "shell", 0.0, 50.0),
    ];
    let rows = aggregate(&spans);
    assert_eq!(rows[0].count, 2);
    assert_eq!(rows[0].total, 100.0);
    assert_eq!(rows[0].max, 50.0);
    let result = analyze(&[session("root", spans)], "root", 10.0, 20.0);
    assert_eq!(result.path.total, 10.0);
    assert_eq!(result.path.segments[0].span.id, "a");
    assert_eq!(result.statistics[0].total, 20.0);
}
#[test]
fn missing_child_and_zero_duration_do_not_fail() {
    let mut root = session(
        "root",
        vec![
            span("wait", "root", "agent_wait", 0.0, 100.0),
            span("instant", "root", "tools", 20.0, 20.0),
        ],
    );
    root.agent_operations
        .push(op("wait", "wait", "missing", 0.0));
    let result = analyze(&[root], "root", 0.0, 100.0);
    assert_eq!(result.path.total, 100.0);
    assert!(result.flows.is_empty());
}
