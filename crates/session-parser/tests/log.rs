use serde_json::{json, Value};
use session_parser::{parse_session, ParsedSession};
use std::collections::HashSet;

fn record(second: u32, kind: &str, payload: Value) -> String {
    json!({"timestamp":format!("2026-09-07T00:00:{second:02}Z"),"type":kind,"payload":payload})
        .to_string()
        + "\n"
}
#[test]
fn log_orders_messages_calls_results_and_keeps_valid_span_references() {
    let input = record(0, "session_meta", json!({"id":"root"}))
        + &record(
            1,
            "event_msg",
            json!({"type":"task_started","turn_id":"turn"}),
        )
        + &record(
            1,
            "event_msg",
            json!({"type":"user_message","message":"Inspect the parser."}),
        )
        + &record(
            2,
            "response_item",
            json!({"type":"function_call","name":"exec_command","call_id":"shell","arguments":"{\"cmd\":\"cargo test\"}"}),
        )
        + &record(
            3,
            "response_item",
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"Tests are running."}]}),
        )
        + &record(
            3,
            "event_msg",
            json!({"type":"item_completed","item":{"type":"AgentMessage","id":"rich-message","content":[{"type":"Text","text":"Tests are running."}]}}),
        )
        + &record(
            4,
            "response_item",
            json!({"type":"function_call_output","call_id":"shell","output":"All tests passed."}),
        )
        + &record(
            5,
            "response_item",
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"Tests are running."}]}),
        )
        + &record(
            6,
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn"}),
        );
    let parsed: ParsedSession = serde_json::from_str(&parse_session(&input)).unwrap();
    let entries = &parsed.log_entries;
    assert_eq!(entries.len(), 5);
    assert!(entries
        .windows(2)
        .all(|pair| pair[0].timestamp <= pair[1].timestamp));
    assert_eq!(
        entries.iter().map(|e| e.role.as_str()).collect::<Vec<_>>(),
        vec!["user", "tool", "assistant", "tool", "assistant"]
    );
    assert_eq!(entries[1].phase.as_deref(), Some("call"));
    assert_eq!(entries[3].phase.as_deref(), Some("result"));
    assert_eq!(entries[1].span_id, entries[3].span_id);
    let spans: HashSet<_> = parsed.spans.iter().map(|s| s.id.as_str()).collect();
    assert!(entries.iter().all(|e| spans.contains(e.span_id.as_str())));
    assert_eq!(entries.iter().filter(|e| e.role == "assistant").count(), 2);
    assert!(entries.iter().all(|e| e.title != "Inference"));
}

#[test]
fn log_falls_back_to_actual_turn_prompt_and_reads_older_analysis_json() {
    let input = record(0, "session_meta", json!({"id":"root"}))
        + &record(
            1,
            "event_msg",
            json!({"type":"task_started","turn_id":"turn"}),
        )
        + &record(
            1,
            "event_msg",
            json!({"type":"user_message","message":"<environment_context>Injected</environment_context>"}),
        )
        + &record(
            2,
            "response_item",
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"This is the actual request."}]}),
        );
    let parsed: ParsedSession = serde_json::from_str(&parse_session(&input)).unwrap();
    let fallback = parsed
        .log_entries
        .iter()
        .find(|e| {
            parsed
                .spans
                .iter()
                .any(|span| span.id == e.span_id && span.track == "turns")
        })
        .unwrap();
    assert_eq!(fallback.role, "user");
    assert_eq!(parsed.turns[0].prompt, "This is the actual request.");
    let mut old = serde_json::to_value(&parsed).unwrap();
    old.as_object_mut().unwrap().remove("logEntries");
    let compatible: ParsedSession = serde_json::from_value(old).unwrap();
    assert!(compatible.log_entries.is_empty());
    assert_eq!(parsed.log_entries.len(), 1);
}

#[test]
fn injected_instructions_are_not_assistant_conversation_messages() {
    let input = record(0, "session_meta", json!({"id":"root"}))
        + &record(
            1,
            "event_msg",
            json!({"type":"task_started","turn_id":"turn"}),
        )
        + &record(
            1,
            "response_item",
            json!({"type":"message","role":"developer","content":[{"type":"input_text","text":"<app-context>Injected instructions</app-context>"}]}),
        )
        + &record(
            1,
            "response_item",
            json!({"type":"message","role":"system","content":[{"type":"input_text","text":"Synthetic system instructions"}]}),
        )
        + &record(
            1,
            "event_msg",
            json!({"type":"user_message","message":"<environment_context>Injected environment</environment_context>"}),
        )
        + &record(
            2,
            "event_msg",
            json!({"type":"user_message","message":"<request>Keep this actual user XML.</request>"}),
        )
        + &record(
            3,
            "response_item",
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"<result>This actual assistant XML is retained.</result>"}]}),
        );
    let parsed: ParsedSession = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(
        parsed
            .log_entries
            .iter()
            .map(|entry| entry.role.as_str())
            .collect::<Vec<_>>(),
        vec!["user", "assistant"]
    );
    assert_eq!(
        parsed
            .spans
            .iter()
            .filter(|span| span.name == "Assistant message")
            .count(),
        1
    );
}

#[test]
fn event_only_assistant_messages_load_details_and_deduplicate_matching_responses() {
    let message = "Implementation and verification complete.";
    let input = record(0, "session_meta", json!({"id":"root"}))
        + &record(
            1,
            "event_msg",
            json!({"type":"agent_message","message":message}),
        )
        + &record(
            1,
            "response_item",
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":message}]}),
        );
    let parsed: ParsedSession = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed.log_entries.len(), 1);
    assert_eq!(parsed.log_entries[0].role, "assistant");
    let mut details = session_parser::details::DetailParser::new("{\"sourceLine\":2}").unwrap();
    details.push(&input);
    let page: Value = serde_json::from_str(&details.finish()).unwrap();
    assert_eq!(page["output"], message);
}
