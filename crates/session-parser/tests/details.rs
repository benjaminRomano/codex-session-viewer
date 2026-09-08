use serde_json::{json, Value};
use session_parser::{details::DetailParser, parse_session};

fn load(input: &str, selector: Value) -> Value {
    let mut parser = DetailParser::new(&selector.to_string()).unwrap();
    for part in input.split_inclusive('\n') {
        parser.push(part);
        if parser.is_done() {
            break;
        }
    }
    serde_json::from_str(&parser.finish()).unwrap()
}

#[test]
fn invalid_detail_selectors_return_native_errors_without_panicking() {
    assert!(DetailParser::new("{").is_err());
    assert!(DetailParser::new("{}").is_err());
    assert!(DetailParser::new(r#"{"sourceLine":0}"#).is_err());
}

#[test]
fn legacy_tool_begin_end_details_include_source_output_and_pages() {
    let large_output = "legacy result 🦀\n".repeat(12000);
    for (begin, end, language) in [
        (
            json!({"type":"exec_command_begin","call_id":"legacy","command":["printf","synthetic"]}),
            json!({"type":"exec_command_end","call_id":"legacy","exit_code":0,"stdout":large_output}),
            "bash",
        ),
        (
            json!({"type":"mcp_tool_call_begin","call_id":"legacy","invocation":{"server":"synthetic","tool":"inspect","arguments":{"code":"complete arguments"}}}),
            json!({"type":"mcp_tool_call_end","call_id":"legacy","result":{"Err":"Complete MCP failure"}}),
            "json",
        ),
        (
            json!({"type":"patch_apply_begin","call_id":"legacy","changes":{"synthetic.rs":{"type":"update","unified_diff":"complete patch"}}}),
            json!({"type":"patch_apply_end","call_id":"legacy","success":false,"stderr":"Complete patch failure"}),
            "json",
        ),
        (
            json!({"type":"web_search_begin","call_id":"legacy"}),
            json!({"type":"web_search_end","call_id":"legacy","query":"synthetic query","action":{"type":"search","query":"synthetic query"},"results":[{"title":"Complete result","url":"https://example.test"}]}),
            "json",
        ),
    ] {
        let input = [
            json!({"type":"session_meta","payload":{"id":"root"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
            json!({"type":"event_msg","payload":begin}),
            json!({"type":"event_msg","payload":end}),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
            + "\n";
        let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
        let span = parsed["spans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|span| span["callId"] == "legacy")
            .unwrap();
        assert_eq!(span["sourceLine"], 3);
        assert_eq!(span["outputLine"], 4);
        let page = load(
            &input,
            json!({"sourceLine":3,"outputLine":4,"pageSize":65536}),
        );
        assert_eq!(page["language"], language);
        assert!(page["code"].as_str().is_some_and(|code| !code.is_empty()));
        if begin["type"] == "exec_command_begin" {
            let mut offset = 0;
            let mut reconstructed = String::new();
            loop {
                let page = load(
                    &input,
                    json!({"sourceLine":3,"outputLine":4,"pageSize":65536,"offset":offset}),
                );
                assert_eq!(page["code"], "printf synthetic");
                reconstructed.push_str(page["output"].as_str().unwrap());
                if page["hasMore"] == false {
                    break;
                }
                offset = page["nextOffset"].as_u64().unwrap();
            }
            assert_eq!(reconstructed, large_output);
        } else {
            assert!(page["output"]
                .as_str()
                .is_some_and(|output| output.contains("Complete")));
            if begin["type"] != "web_search_begin" {
                assert_eq!(span["status"], "error");
            }
        }
    }
}

#[test]
fn incoming_followups_keep_each_turn_source_after_first_description() {
    let first = "Validate the parser.";
    let second = "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nCheck the follow-up source and preserve this complete prompt.";
    let third = "Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nInspect the legacy message envelope.";
    let records = [
        json!({"type":"session_meta","payload":{"id":"child","parent_thread_id":"root","agent_path":"/root/worker"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}),
        json!({"type":"response_item","payload":{"type":"agent_message","author":"/root","content":[{"type":"input_text","text":first}]}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"two"}}),
        json!({"type":"response_item","payload":{"type":"agent_message","author":"/root","content":[{"type":"input_text","text":second}]}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"two"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"three"}}),
        json!({"type":"inter_agent_communication","payload":{"content":third}}),
    ];
    let input = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["metadata"]["agentDescription"], first);
    for (index, prompt) in [first, second, third].into_iter().enumerate() {
        let line = 3 * (index + 1);
        assert_eq!(parsed["turns"][index]["prompt"], prompt);
        assert_eq!(parsed["turns"][index]["sourceLine"], line);
        let details = load(&input, json!({"sourceLine":line}));
        assert_eq!(details["prompt"], prompt);
        let turn_id = &parsed["turns"][index]["id"];
        let span = parsed["spans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|span| span["track"] == "turns" && &span["turnId"] == turn_id)
            .unwrap();
        assert_eq!(span["sourceLine"], line);
    }
}

#[test]
fn encrypted_message_details_retain_original_structure_and_explain_missing_plaintext() {
    let header = "Message Type: NEW_TASK\nSender: /root\nPayload:\n";
    let payload = json!({"type":"agent_message","author":"/root","content":[{"type":"input_text","text":header},{"type":"encrypted_content","encrypted_content":"synthetic-opaque-content"}]});
    let input = json!({"type":"response_item","payload":payload}).to_string() + "\n";
    let details = load(&input, json!({"sourceLine":1}));
    assert_eq!(details["prompt"], header);
    assert_eq!(
        serde_json::from_str::<Value>(details["args"].as_str().unwrap()).unwrap(),
        payload
    );
    assert_eq!(
        details["warnings"],
        json!(["The task payload is encrypted in this session file."])
    );
}

#[test]
fn inference_label_retains_reasoning_and_failed_command_retains_diagnostics() {
    let reasoning = json!({"type":"Reasoning","id":"reasoning","summary_text":["Recorded summary"],"raw_content":["Recorded detailed reasoning"]});
    let command = json!({"type":"CommandExecution","id":"command","command":["synthetic-command"],"status":"failed","exit_code":1,"aggregated_output":"","stderr":"Recorded stderr diagnostic","error":{"message":"Recorded structured error"}});
    let input = [reasoning.clone(),command].into_iter().map(|item| json!({"type":"event_msg","payload":{"type":"item_completed","started_at_ms":1000,"completed_at_ms":2000,"item":item}}).to_string()).collect::<Vec<_>>().join("\n") + "\n";
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    let spans = parsed["spans"].as_array().unwrap();
    let inference = spans
        .iter()
        .find(|span| span["callId"] == "reasoning")
        .unwrap();
    assert_eq!(inference["name"], "Inference");
    assert_eq!(inference["track"], "inference");
    let details = load(&input, json!({"sourceLine":1}));
    assert_eq!(
        serde_json::from_str::<Value>(details["output"].as_str().unwrap()).unwrap(),
        reasoning
    );
    let command = spans
        .iter()
        .find(|span| span["callId"] == "command")
        .unwrap();
    assert_eq!(command["status"], "error");
    let details = load(&input, json!({"sourceLine":2}));
    let output = details["output"].as_str().unwrap();
    assert!(output.contains("Recorded stderr diagnostic"));
    assert!(output.contains("Recorded structured error"));
    assert_eq!(command["output"], details["output"]);
}
#[test]
fn physical_lines_include_blank_malformed_and_ignored_records() {
    let input="\ninvalid\n".to_owned()+&json!({"timestamp":"2026-09-07T00:00:00Z","type":"session_meta","payload":{"id":"root"}}).to_string()+"\n"+&json!({"timestamp":"2026-09-07T00:00:01Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}).to_string()+"\n"+&json!({"timestamp":"2026-09-07T00:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"Full synthetic prompt"}}).to_string()+"\n";
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["turns"][0]["sourceLine"], 5);
    assert_eq!(parsed["turns"][0]["prompt"], "Full synthetic prompt");
    let turn = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["track"] == "turns")
        .unwrap();
    assert_eq!(turn["name"], "Turn 1");
    assert_eq!(turn["sourceLine"], 5);
    let details = load(&input, json!({"sourceLine":5}));
    assert_eq!(details["prompt"], "Full synthetic prompt");
}
#[test]
fn code_and_output_details_exceed_trace_excerpt_cap_and_stop_early() {
    let source = "// source\n".repeat(5000);
    let output = "result\n".repeat(5000);
    let input=json!({"type":"response_item","payload":{"type":"function_call","name":"exec","call_id":"c","arguments":json!({"code":source}).to_string()}}).to_string()+"\n"+&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":output}}).to_string()+"\nignored\n";
    let mut parser = DetailParser::new("{\"sourceLine\":1,\"outputLine\":2}").unwrap();
    let first = input.split_inclusive('\n').next().unwrap();
    parser.push(first);
    assert!(!parser.is_done());
    parser.push(&input[first.len()..]);
    assert!(parser.is_done());
    let details: Value = serde_json::from_str(&parser.finish()).unwrap();
    assert_eq!(details["code"], source);
    assert_eq!(details["output"], output);
    assert_eq!(details["hasMore"], false);
}
#[test]
fn giant_plain_string_pages_reconstruct_every_character_without_markers() {
    let output = "café🦀".repeat(45_000);
    let input=json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":output}}).to_string()+"\n";
    let mut offset = 0;
    let mut reconstructed = String::new();
    loop {
        let details = load(
            &input,
            json!({"sourceLine":1,"pageSize":65536,"offset":offset}),
        );
        assert_eq!(details["warnings"], json!([]));
        reconstructed.push_str(details["output"].as_str().unwrap());
        if details["hasMore"] == false {
            break;
        }
        offset = details["nextOffset"].as_u64().unwrap();
    }
    assert_eq!(reconstructed, output);
}
#[test]
fn escaped_quote_backslash_and_surrogate_pages_reconstruct_exactly() {
    let raw = "\\uD83D\\uDE00\\\"\\\\".repeat(20000);
    let input=format!("{{\"type\":\"response_item\",\"payload\":{{\"type\":\"function_call_output\",\"call_id\":\"c\",\"output\":\"{raw}\"}}}}\n");
    let expected: Value = serde_json::from_str(&input).unwrap();
    let mut offset = 0;
    let mut reconstructed = String::new();
    loop {
        let mut parser = DetailParser::new(
            &json!({"sourceLine":1,"pageSize":65536,"offset":offset}).to_string(),
        )
        .unwrap();
        for ch in input.chars() {
            parser.push(&ch.to_string());
        }
        let details: Value = serde_json::from_str(&parser.finish()).unwrap();
        assert_eq!(details["warnings"], json!([]));
        reconstructed.push_str(details["output"].as_str().unwrap());
        if details["hasMore"] == false {
            break;
        }
        offset = details["nextOffset"].as_u64().unwrap();
    }
    assert_eq!(
        reconstructed,
        expected["payload"]["output"].as_str().unwrap()
    );
}

#[test]
fn structured_output_pages_keep_valid_wrappers_and_complete_short_source_fields() {
    let code = "const result = await tools.run();";
    let first = "café🦀\n".repeat(20_000);
    let second = "A quoted value: \"example\" and a backslash \\\n".repeat(6000);
    let input = json!({
        "type":"response_item",
        "payload":{"type":"function_call","name":"exec","call_id":"c","arguments":json!({"code":code}).to_string()}
    }).to_string()+"\n"+&json!({
        "type":"response_item",
        "payload":{"type":"function_call_output","call_id":"c","output":{
            "isError":false,"result":{"summary":"Stable header","content":first},"related":[{"text":second}]
        }}
    }).to_string()+"\n";
    let mut offset = 0;
    let mut first_reconstructed = String::new();
    let mut second_reconstructed = String::new();
    let mut pages = 0;
    loop {
        let details = load(
            &input,
            json!({"sourceLine":1,"outputLine":2,"pageSize":65536,"offset":offset}),
        );
        assert_eq!(details["warnings"], json!([]));
        // Source fields repeat intact: render this entire returned page instead
        // of appending code or wrapping JSON documents to earlier fields.
        assert_eq!(details["code"], code);
        assert_eq!(
            serde_json::from_str::<Value>(details["args"].as_str().unwrap()).unwrap(),
            json!({"code":code})
        );
        let output: Value = serde_json::from_str(details["output"].as_str().unwrap()).unwrap();
        assert_eq!(output["isError"], false);
        assert_eq!(output["result"]["summary"], "Stable header");
        first_reconstructed.push_str(output["result"]["content"].as_str().unwrap());
        second_reconstructed.push_str(output["related"][0]["text"].as_str().unwrap());
        pages += 1;
        if details["hasMore"] == false {
            break;
        }
        offset = details["nextOffset"].as_u64().unwrap();
    }
    assert!(pages >= 3);
    assert_eq!(first_reconstructed, first);
    assert_eq!(second_reconstructed, second);
}

#[test]
fn context_records_cannot_pin_the_actual_request_or_its_detail_source() {
    let request="I want you to review this code deeply.\n\nKeep the complete prompt, including <request>XML</request>.";
    let records = [
        json!({"type":"session_meta","payload":{"id":"root"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>Available plugins</recommended_plugins>"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>Local environment</environment_context>"}]}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>Project guidance</INSTRUCTIONS>"}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"turn","item":{"type":"UserMessage","id":"context","content":[{"type":"input_text","text":"<permissions instructions>Sandbox settings</permissions instructions>"}]}}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":request}]}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":request}}),
    ];
    let input = records
        .iter()
        .map(|v| v.to_string() + "\n")
        .collect::<String>();
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["turns"][0]["prompt"], request);
    assert_eq!(parsed["turns"][0]["sourceLine"], 7);
    assert!(parsed["turns"][0]["title"]
        .as_str()
        .unwrap()
        .starts_with("I want you to review this code deeply."));
    let turn_span = parsed["spans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|span| span["track"] == "turns")
        .unwrap();
    assert_eq!(turn_span["sourceLine"], 7);
    let details = load(&input, json!({"sourceLine":turn_span["sourceLine"]}));
    assert_eq!(details["prompt"], request);
}

#[test]
fn genuine_xml_request_is_preserved_after_known_context() {
    let request = "<request><action>Review the parser</action></request>";
    let input=json!({"type":"session_meta","payload":{"id":"root"}}).to_string()+"\n"
        +&json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}).to_string()+"\n"
        +&json!({"type":"event_msg","payload":{"type":"user_message","message":"<app-context>Application context</app-context>"}}).to_string()+"\n"
        +&json!({"type":"event_msg","payload":{"type":"user_message","message":request}}).to_string()+"\n";
    let parsed: Value = serde_json::from_str(&parse_session(&input)).unwrap();
    assert_eq!(parsed["turns"][0]["prompt"], request);
    assert_eq!(parsed["turns"][0]["title"], request);
    assert_eq!(parsed["turns"][0]["sourceLine"], 4);
    assert_eq!(load(&input, json!({"sourceLine":4}))["prompt"], request);
}
