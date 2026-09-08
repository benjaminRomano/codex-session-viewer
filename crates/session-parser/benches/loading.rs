use serde_json::{json, Value};
use session_parser::Engine;
use std::{fmt::Write, hint::black_box, time::Instant};

const TOOL_CALLS: usize = 10_000;

fn append(text: &mut String, millis: usize, kind: &str, payload: Value) {
    let timestamp = format!(
        "2026-09-07T00:00:{:02}.{:03}Z",
        millis / 1000,
        millis % 1000
    );
    writeln!(
        text,
        "{}",
        json!({"timestamp":timestamp,"type":kind,"payload":payload})
    )
    .unwrap();
}

fn fixture() -> String {
    let mut text = String::with_capacity(5_000_000);
    append(&mut text, 0, "session_meta", json!({"id":"benchmark"}));
    append(
        &mut text,
        0,
        "event_msg",
        json!({"type":"task_started","turn_id":"t"}),
    );
    for index in 0..TOOL_CALLS {
        let call_id = format!("call-{index}");
        append(
            &mut text,
            index * 2 + 1,
            "response_item",
            json!({
                "type":"function_call","name":"exec_command","call_id":call_id,
                "arguments":"{\"cmd\":\"cargo test\"}"
            }),
        );
        append(
            &mut text,
            index * 2 + 2,
            "response_item",
            json!({
                "type":"function_call_output","call_id":call_id,"output":"Completed successfully."
            }),
        );
    }
    append(
        &mut text,
        TOOL_CALLS * 2 + 1,
        "event_msg",
        json!({"type":"task_complete","turn_id":"t"}),
    );
    text
}

fn main() {
    // Build outside the timer. Unique IDs and paired results exercise call-state
    // retention, completion and log projection rather than one overwritten call.
    let text = fixture();
    for metadata in [true, false] {
        let mut samples = Vec::with_capacity(7);
        for _ in 0..7 {
            let start = Instant::now();
            let mut parser = Engine::new(metadata);
            parser.push(&text);
            let parsed = black_box(parser.finish());
            samples.push(start.elapsed().as_secs_f64());
            assert_eq!(parsed.metadata.record_count, TOOL_CALLS * 2 + 3);
            if !metadata {
                assert_eq!(
                    parsed
                        .spans
                        .iter()
                        .filter(|span| span.call_id.is_some() && span.status == "complete")
                        .count(),
                    TOOL_CALLS
                );
            }
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "{}: {} tool pairs, {:.2} MB, median {:.2} ms, {:.1} MB/s",
            if metadata { "metadata" } else { "trace" },
            TOOL_CALLS,
            text.len() as f64 / 1e6,
            samples[3] * 1000.0,
            text.len() as f64 / 1e6 / samples[3]
        );
    }
}
