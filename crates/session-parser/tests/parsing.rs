use serde_json::{json, Value};
use session_parser::{details::DetailParser, parse_session, scan_metadata, Engine};

// Synthetic transport-shaped bytes, not an encrypted user payload.
const ENCODED_TASK: &str = "gAAAAABqnf6AAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw==";

fn record(second: u32, kind: &str, payload: Value) -> String {
    json!({"timestamp":format!("2026-09-07T00:00:{second:02}Z"),"type":kind,"payload":payload})
        .to_string()
        + "\n"
}
fn meta() -> String {
    record(
        0,
        "session_meta",
        json!({"id":"root","cwd":"/synthetic","timestamp":"2026-09-07T00:00:00Z"}),
    )
}
fn start() -> String {
    record(
        1,
        "event_msg",
        json!({"type":"task_started","turn_id":"turn-1"}),
    )
}
fn end() -> String {
    record(
        10,
        "event_msg",
        json!({"type":"task_complete","turn_id":"turn-1"}),
    )
}
fn call(second: u32, id: &str, name: &str, args: Value) -> String {
    record(
        second,
        "response_item",
        json!({"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()}),
    )
}
fn output(second: u32, id: &str, out: Value) -> String {
    record(
        second,
        "response_item",
        json!({"type":"function_call_output","call_id":id,"output":out.to_string()}),
    )
}

#[test]
fn pairs_parallel_calls_by_id_and_exposes_inferred_gaps() {
    let input = meta()
        + &start()
        + &call(2, "a", "exec_command", json!({"cmd":"cargo test"}))
        + &call(3, "b", "exec_command", json!({"cmd":"cargo fmt"}))
        + &output(5, "b", json!({"ok":true}))
        + &output(7, "a", json!({"ok":true}))
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let spans = parsed["spans"].as_array().unwrap();
    let a = spans.iter().find(|s| s["callId"] == "a").unwrap();
    let b = spans.iter().find(|s| s["callId"] == "b").unwrap();
    assert_eq!(
        a["endTime"].as_f64().unwrap() - a["startTime"].as_f64().unwrap(),
        5000.0
    );
    assert_eq!(
        b["endTime"].as_f64().unwrap() - b["startTime"].as_f64().unwrap(),
        2000.0
    );
    assert!(spans
        .iter()
        .filter(|s| s["track"] == "inference")
        .all(|s| s["inferred"] == true));
    assert_eq!(parsed["metadata"]["turnCount"], 1);
}

#[test]
fn metadata_and_trace_discover_uuid_and_path_subagents() {
    let child = "11111111-1111-4111-8111-111111111111";
    let input = meta()
        + &start()
        + &call(
            2,
            "spawn",
            "spawn_agent",
            json!({"task_name":"worker","message":"Validate the streaming parser and nested agents."}),
        )
        + &output(3, "spawn", json!({"task_name":"/root/worker"}))
        + &record(
            3,
            "event_msg",
            json!({"type":"sub_agent_activity","agent_thread_id":child,"agent_path":"/root/worker","kind":"started"}),
        )
        + &call(
            4,
            "send",
            "send_message",
            json!({"target":"/root/worker","message":"synthetic"}),
        )
        + &output(5, "send", json!({}))
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let metadata: Value = serde_json::from_str(&scan_metadata(&input)).unwrap();
    assert_eq!(metadata["childIds"], json!([child]));
    assert_eq!(parsed["metadata"], metadata);
    assert!(parsed["agentOperations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|op| op["targetIds"] == json!([child])));
    assert_eq!(
        parsed["agentOperations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["kind"] == "spawn")
            .unwrap()["description"],
        "Validate the streaming parser and nested agents."
    );
}

#[test]
fn classic_spawn_output_is_indexed_without_building_spans() {
    let child = "22222222-2222-4222-8222-222222222222";
    let input = meta()
        + &call(
            1,
            "spawn",
            "spawn_agent",
            json!({"message":"Synthetic task"}),
        )
        + &output(2, "spawn", json!({"agent_id":child}));
    let metadata: Value = serde_json::from_str(&scan_metadata(&input)).unwrap();
    assert_eq!(metadata["childIds"], json!([child]));
}

#[test]
fn inherited_parent_records_are_excluded_by_ordinal() {
    let input=json!({"timestamp":"2026-09-07T00:00:00Z","ordinal":0,"type":"session_meta","payload":{"id":"child","parent_thread_id":"root","agent_path":"/root/worker","subagent_history_start_ordinal":10}}).to_string()+"\n"+&json!({"timestamp":"2026-09-07T00:00:01Z","ordinal":2,"type":"event_msg","payload":{"type":"task_started","turn_id":"inherited"}}).to_string()+"\n"+&json!({"timestamp":"2026-09-07T00:00:03Z","ordinal":10,"type":"event_msg","payload":{"type":"task_started","turn_id":"own"}}).to_string()+"\n";
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["turns"].as_array().unwrap().len(), 1);
    assert_eq!(parsed["turns"][0]["id"], "own");
    assert_eq!(parsed["metadata"]["agentPath"], "/root/worker");
}

#[test]
fn rich_nested_item_has_exact_times_and_skill_track() {
    let input = meta()
        + &start()
        + &record(
            8,
            "event_msg",
            json!({"type":"item_completed","turn_id":"turn-1","started_at_ms":1788739202100u64,"completed_at_ms":1788739202400u64,"item":{"type":"CommandExecution","id":"nested","command":["cat","SKILL.md"],"exit_code":0,"aggregated_output":"synthetic instructions"}}),
        )
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let span = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "nested")
        .unwrap();
    assert_eq!(span["track"], "skills");
    assert_eq!(
        span["endTime"].as_f64().unwrap() - span["startTime"].as_f64().unwrap(),
        300.0
    );
    assert_eq!(span["inferred"], false);
}

#[test]
fn incremental_chunks_match_whole_parse_and_tolerate_truncated_record() {
    let input = meta()
        + &start()
        + &call(2, "a", "exec_command", json!({"cmd":"echo café"}))
        + &end()
        + "{\"truncated\":";
    let mut engine = Engine::new(false);
    for character in input.chars() {
        engine.push(&character.to_string());
    }
    let chunked = serde_json::to_value(engine.finish()).unwrap();
    let whole: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(chunked, whole);
    assert_eq!(chunked["metadata"]["malformedLines"], 1);
    let span = chunked["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "a")
        .unwrap();
    assert_eq!(span["status"], "incomplete");
}

#[test]
fn unknown_events_do_not_break_metadata_and_latest_model_wins() {
    let input = meta()
        + &start()
        + &record(2, "turn_context", json!({"model":"gpt-5"}))
        + &record(
            3,
            "event_msg",
            json!({"type":"future_event","something":true}),
        )
        + &record(4, "turn_context", json!({"model":"gpt-6"}))
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["metadata"]["model"], "gpt-6");
    assert_eq!(parsed["metadata"]["malformedLines"], 0);
}

#[test]
fn giant_lines_are_skipped_without_losing_following_records() {
    let mut engine = Engine::new(false);
    engine.push(&meta());
    for _ in 0..9 {
        engine.push(&"x".repeat(1024 * 1024));
    }
    engine.push("\n");
    engine.push(&start());
    engine.push(&end());
    let parsed = engine.finish();
    assert_eq!(parsed.metadata.turn_count, 1);
    assert!(parsed.warnings.iter().any(|w| w.contains("8 MiB")));
}

#[test]
fn duplicated_item_completion_does_not_duplicate_tool_span() {
    let completed = record(
        7,
        "event_msg",
        json!({"type":"item_completed","turn_id":"turn-1","started_at_ms":1788739202000u64,"completed_at_ms":1788739207000u64,"item":{"type":"CommandExecution","id":"call","command":["echo","hello"],"exit_code":0}}),
    );
    let input = meta()
        + &start()
        + &call(2, "call", "exec_command", json!({"cmd":"echo hello"}))
        + &completed
        + &output(7, "call", json!({"ok":true}))
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(
        parsed["spans"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["callId"] == "call")
            .count(),
        1
    );
}

#[test]
fn oldest_unwrapped_rollouts_are_valid_but_have_unknown_durations() {
    let input=json!({"id":"old","timestamp":"2025-01-01T00:00:00Z","instructions":"synthetic"}).to_string()+"\n"+&json!({"record_type":"model_input"}).to_string()+"\n"+&json!({"type":"message","role":"user","content":[{"type":"input_text","text":"A synthetic legacy task"}]}).to_string()+"\n"+&json!({"type":"function_call","call_id":"old-call","name":"exec_command","arguments":"{}"}).to_string()+"\n";
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["metadata"]["malformedLines"], 0);
    assert_eq!(parsed["metadata"]["id"], "old");
    assert_eq!(parsed["metadata"]["turnCount"], 1);
    assert!(parsed["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("no per-record timestamps")));
    let span = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "old-call")
        .unwrap();
    assert_eq!(span["startTime"], span["endTime"]);
}

#[test]
fn failed_rich_command_survives_later_output_and_settings_update_model() {
    let input = meta()
        + &start()
        + &call(2, "call", "exec_command", json!({"cmd":"false"}))
        + &record(
            3,
            "event_msg",
            json!({"type":"item_completed","turn_id":"turn-1","started_at_ms":1788739202000u64,"completed_at_ms":1788739203000u64,"item":{"type":"CommandExecution","id":"call","command":["false"],"exit_code":1,"status":"failed"}}),
        )
        + &output(3, "call", json!({"output":"failure"}))
        + &record(
            4,
            "event_msg",
            json!({"type":"thread_settings_applied","thread_settings":{"model":"gpt-6"}}),
        )
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let span = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "call")
        .unwrap();
    assert_eq!(span["status"], "error");
    assert_eq!(parsed["metadata"]["model"], "gpt-6");
}

#[test]
fn structured_output_error_and_unicode_detail_cap() {
    let input = meta()
        + &start()
        + &call(2, "call", "exec_command", json!({"cmd":"é".repeat(10000)}))
        + &output(3, "call", json!({"exit_code":2}))
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let span = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "call")
        .unwrap();
    assert_eq!(span["status"], "error");
    assert!(span["code"].as_str().unwrap().len() < 16500);
}

#[test]
fn first_metadata_owns_identity_despite_copied_ancestor_history() {
    let input = meta()
        + &record(
            1,
            "session_meta",
            json!({"id":"ancestor","agent_path":"/root/ancestor"}),
        )
        + &start()
        + &call(2, "call", "exec_command", json!({"cmd":"echo identity"}))
        + &end();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["metadata"]["id"], "root");
    assert!(parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["sessionId"] == "root"));
}

#[test]
fn giant_output_keeps_envelope_status_and_timing_with_bounded_strings() {
    let input = meta()
        + &start()
        + &call(
            2,
            "huge",
            "exec_command",
            json!({"cmd":"generate synthetic output"}),
        )
        + &record(
            8,
            "response_item",
            json!({"type":"function_call_output","call_id":"huge","output":{"isError":true,"text":"x".repeat(9*1024*1024)}}),
        )
        + &end();
    let mut engine = Engine::new(false);
    for chunk in input.as_bytes().chunks(7777) {
        engine.push(std::str::from_utf8(chunk).unwrap());
    }
    let parsed = engine.finish();
    assert_eq!(parsed.metadata.malformed_lines, 0);
    assert_eq!(parsed.metadata.oversized_lines, 0);
    assert_eq!(parsed.metadata.elided_strings, 1);
    assert!(parsed.metadata.elided_bytes > 8 * 1024 * 1024);
    let span = parsed
        .spans
        .iter()
        .find(|s| s.call_id.as_deref() == Some("huge"))
        .unwrap();
    assert_eq!(span.status, "error");
    assert_eq!(span.end_time - span.start_time, 6000.0);
}

#[test]
fn elision_preserves_split_escaped_quotes_unicode_and_surrogate_pairs() {
    for prefix in [65522, 65527, 65530, 65533, 65536] {
        let text = format!(
            "{}\\uD83D\\uDE00\\\"\\\\{}",
            "x".repeat(prefix),
            "é".repeat(100)
        );
        let line=format!("{{\"timestamp\":\"2026-09-07T00:00:02Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"function_call_output\",\"call_id\":\"c\",\"output\":\"{text}\"}}}}\n");
        let input = meta() + &call(1, "c", "exec_command", json!({})) + &line;
        let mut engine = Engine::new(false);
        for ch in input.chars() {
            engine.push(&ch.to_string());
        }
        let parsed = engine.finish();
        assert_eq!(parsed.metadata.malformed_lines, 0, "prefix {prefix}");
        assert_eq!(parsed.metadata.elided_strings, 1);
    }
}

#[test]
fn code_wrappers_extract_source_and_legacy_exit_headers_are_failures() {
    let input = meta()
        + &call(
            1,
            "code",
            "functions.exec",
            json!({"code":"const results = await Promise.all([]);"}),
        )
        + &record(
            2,
            "response_item",
            json!({"type":"function_call_output","call_id":"code","output":"Wall time: 1 s\nProcess exited with code 2\nFinal output:\nsynthetic"}),
        );
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let span = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "code")
        .unwrap();
    assert_eq!(span["status"], "error");
    assert_eq!(span["language"], "javascript");
    assert_eq!(span["code"], "const results = await Promise.all([]);");
}

#[test]
fn stdout_failure_words_do_not_override_successful_exit_header() {
    let input = meta()
        + &call(1, "shell", "exec_command", json!({"cmd":"cat example-log"}))
        + &record(
            2,
            "response_item",
            json!({"type":"function_call_output","call_id":"shell","output":"Exit code: 0\nOutput:\nProcess exited with code 1"}),
        );
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["spans"][0]["status"], "complete");
}

#[test]
fn child_task_description_comes_from_initial_inter_agent_message() {
    let body = "Validate local session loading across multiple nested agents.";
    for message in [
        body.to_owned(),
        format!("Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n{body}"),
    ] {
        let input = record(
            0,
            "session_meta",
            json!({"id":"child","parent_thread_id":"root","agent_path":"/root/worker"}),
        ) + &start()
            + &record(
                2,
                "response_item",
                json!({"type":"agent_message","author":"/root","recipient":"/root/worker","content":[{"type":"input_text","text":message}]}),
            );
        let metadata: Value = serde_json::from_str(&scan_metadata(&input)).unwrap();
        assert_eq!(
            metadata["agentDescription"],
            "Validate local session loading across multiple nested agents."
        );
        let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
        assert_eq!(parsed["turns"][0]["prompt"], message);
        assert_eq!(parsed["turns"][0]["title"], body);
        assert_eq!(metadata["title"], body);
    }
}

#[test]
fn encoded_agent_operation_payloads_are_not_brief_goals() {
    for (message, opaque) in [
        (ENCODED_TASK.to_owned(), true),
        (
            "gAAAA is ordinary prose describing a token prefix.".into(),
            false,
        ),
        (format!("Please inspect this token: {ENCODED_TASK}"), false),
        (format!("gAAAA{}", "A".repeat(95)), false),
        (
            format!("{}?", &ENCODED_TASK[..ENCODED_TASK.len() - 1]),
            false,
        ),
    ] {
        let arguments = json!({"task_name":"worker","message":message});
        let input = meta() + &start() + &call(2, "spawn", "spawn_agent", arguments.clone());
        let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
        let description = &parsed["agentOperations"][0]["description"];
        if opaque {
            assert!(description.is_null());
        } else {
            assert_eq!(description, &message);
        }
        let span = parsed["spans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|span| span["callId"] == "spawn")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(span["args"].as_str().unwrap()).unwrap(),
            arguments
        );
        let mut details = DetailParser::new("{\"sourceLine\":3}").unwrap();
        details.push(&input);
        let page: Value = serde_json::from_str(&details.finish()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(page["args"].as_str().unwrap()).unwrap(),
            arguments
        );
    }
}

#[test]
fn encrypted_child_content_uses_identity_title_without_blocking_plaintext() {
    let header =
        "Message Type: NEW_TASK\nTask name: /root/verification_review\nSender: /root\nPayload:\n";
    for (path, nickname, expected) in [
        (
            Some("/root/verification_review"),
            Some("Carver"),
            "verification review",
        ),
        (None, Some("Carver"), "Carver"),
        (None, None, "Untitled session"),
    ] {
        let input = record(
            0,
            "session_meta",
            json!({"id":"child","parent_thread_id":"root","agent_path":path,"agent_nickname":nickname}),
        ) + &start()
            + &record(
                2,
                "response_item",
                json!({"type":"agent_message","author":"/root","content":[
                    {"type":"input_text","text":header},
                    {"type":"encrypted_content","encrypted_content":"opaque-body-with-no-guessable-shape"}
                ]}),
            );
        let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
        let metadata: Value = serde_json::from_str(&scan_metadata(&input)).unwrap();
        assert_eq!(metadata, parsed["metadata"]);
        assert_eq!(metadata["title"], expected);
        assert!(metadata["agentDescription"].is_null());
        assert_eq!(parsed["turns"][0]["prompt"], header);

        let body = "Validate the complete streaming parser.";
        let with_plaintext = input
            + &record(
                3,
                "response_item",
                json!({"type":"agent_message","author":"/root","content":[{"type":"input_text","text":body}]}),
            );
        let metadata: Value = serde_json::from_str(&scan_metadata(&with_plaintext)).unwrap();
        assert_eq!(metadata["title"], body);
        assert_eq!(metadata["agentDescription"], body);
    }
}

#[test]
fn generated_auto_review_label_keeps_original_prompt() {
    let prompt = "The following is the Codex agent history whose request action you are assessing.\nSynthetic original history.";
    for model in ["codex-auto-review", "ordinary-model"] {
        let input = meta()
            + &record(0, "turn_context", json!({"model":model}))
            + &start()
            + &record(
                2,
                "event_msg",
                json!({"type":"user_message","message":prompt}),
            );
        let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
        assert_eq!(parsed["turns"][0]["prompt"], prompt);
        assert_eq!(
            parsed["metadata"]["title"],
            if model == "codex-auto-review" {
                "Review tool request".to_owned()
            } else {
                prompt.replace('\n', " ")
            }
        );
    }
}
#[test]
fn code_cell_wait_is_not_an_agent_operation() {
    let input = meta()
        + &call(
            1,
            "cell-resume",
            "wait",
            json!({"cell_id":"cell-1","yield_time_ms":1000}),
        );
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["spans"][0]["track"], "code");
    assert!(parsed["agentOperations"].as_array().unwrap().is_empty());
}

#[test]
fn missing_completion_stops_at_own_activity_not_later_turns_or_settings() {
    let input = meta()
        + &start()
        + &call(2, "command", "exec_command", json!({"cmd":"true"}))
        + &output(5, "command", json!({"exit_code":0}))
        + &record(6, "event_msg", json!({"type":"token_count"}))
        + &record(20, "event_msg", json!({"type":"thread_settings_applied"}))
        + &record(21, "event_msg", json!({"type":"task_started","turn_id":"next"}))
        + &record(22, "event_msg", json!({"type":"task_complete","turn_id":"next"}))
        + &json!({"timestamp":"2026-09-08T00:00:00Z","type":"event_msg","payload":{"type":"thread_settings_applied"}}).to_string();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let first = &parsed["turns"][0];
    assert_eq!(
        first["endTime"].as_f64().unwrap() - first["startTime"].as_f64().unwrap(),
        5000.0
    );
    assert_eq!(first["status"], "incomplete");
    assert!(parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|span| span["turnId"] == "turn-1")
        .all(|span| span["endTime"].as_f64().unwrap() <= first["endTime"].as_f64().unwrap()));
    assert_eq!(
        parsed["metadata"],
        serde_json::from_str::<Value>(&scan_metadata(&input)).unwrap()
    );
}

#[test]
fn late_completion_preserves_the_new_active_turn_and_explicit_overlap() {
    let input = meta()
        + &start()
        + &record(
            2,
            "event_msg",
            json!({"type":"task_started","turn_id":"next"}),
        )
        + &record(
            3,
            "event_msg",
            json!({"type":"task_complete","turn_id":"turn-1"}),
        )
        + &call(4, "next-call", "exec_command", json!({"cmd":"true"}))
        + &output(5, "next-call", json!({"exit_code":0}))
        + &record(
            6,
            "event_msg",
            json!({"type":"task_complete","turn_id":"next"}),
        );
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let call = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["callId"] == "next-call")
        .unwrap();
    assert_eq!(call["turnId"], "next");
    assert!(
        parsed["turns"][0]["endTime"].as_f64().unwrap()
            > parsed["turns"][1]["startTime"].as_f64().unwrap()
    );
    assert_eq!(parsed["turns"][0]["status"], "complete");
}

#[test]
fn compaction_uses_recorded_elapsed_time_and_keeps_the_commit_marker_instant() {
    let input = meta()
        + &start()
        + &record(
            5,
            "event_msg",
            json!({"type":"item_completed", "turn_id":"turn-1", "started_at_ms":1788739202000u64, "completed_at_ms":1788739372000u64, "item":{"type":"ContextCompaction","id":"compact"}}),
        )
        + &record(6, "compacted", json!({"replacement_history":[]}));
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let spans = parsed["spans"].as_array().unwrap();
    let operation = spans
        .iter()
        .find(|span| span["callId"] == "compact")
        .unwrap();
    assert_eq!(
        operation["endTime"].as_f64().unwrap() - operation["startTime"].as_f64().unwrap(),
        170_000.0
    );
    let marker = spans
        .iter()
        .find(|span| span["name"] == "Context compacted")
        .unwrap();
    assert_eq!(marker["startTime"], marker["endTime"]);
}
