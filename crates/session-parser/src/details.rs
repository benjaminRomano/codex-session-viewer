//! Lazy detail reads use physical record positions and retain only selected
//! records. Large JSON strings are accessible in pages without an excerpt marker.
use crate::{classify, parser_error, prompt_content, record_output, s, Engine, ParserError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Selector {
    source_line: Option<usize>,
    output_line: Option<usize>,
    call_id: Option<String>,
    offset: Option<u64>,
    page_size: Option<usize>,
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_offset: Option<u64>,
    warnings: Vec<String>,
}
fn full(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| serde_json::to_string_pretty(v).unwrap())
}
fn capture(result: &mut Details, record: &Value) {
    let payload = record.get("payload").unwrap_or(record);
    let kind = s(payload, "type");
    if matches!(
        kind,
        "function_call" | "custom_tool_call" | "local_shell_call"
    ) {
        let args = payload
            .get("arguments")
            .or_else(|| payload.get("input"))
            .or_else(|| payload.get("action"))
            .map(full)
            .unwrap_or_default();
        let obj = serde_json::from_str::<Value>(&args).unwrap_or(Value::Null);
        let track = classify(s(payload, "name"), &args);
        result.code = Some(if track == "code" {
            obj.get("code")
                .and_then(Value::as_str)
                .unwrap_or(&args)
                .into()
        } else {
            obj.get("cmd")
                .or_else(|| obj.get("command"))
                .map(full)
                .unwrap_or_else(|| args.clone())
        });
        result.language = Some(
            if track == "code" {
                "javascript"
            } else if matches!(track, "shell" | "skills") {
                "bash"
            } else {
                "json"
            }
            .into(),
        );
        result.args = Some(args);
    }
    if matches!(kind, "function_call_output" | "custom_tool_call_output") {
        result.output = payload.get("output").map(full);
    }
    if kind == "user_message" {
        result.prompt = Some(s(payload, "message").into());
    }
    if kind == "agent_message" && payload.get("message").is_some() {
        result.output = Some(s(payload, "message").into());
    }
    if kind == "message" {
        let text = prompt_content(&payload["content"]);
        if s(payload, "role") == "user" {
            result.prompt = Some(text);
        } else {
            result.output = Some(text);
        }
    }
    if kind == "agent_message" && payload.get("content").is_some() {
        result.prompt = Some(prompt_content(&payload["content"]));
        result.output = result.prompt.clone();
        if payload["content"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| s(item, "type") == "encrypted_content")
        }) {
            result.args = Some(full(payload));
            result
                .warnings
                .push("The task payload is encrypted in this session file.".into());
        }
    }
    if s(record, "type") == "inter_agent_communication" {
        result.prompt = Some(s(payload, "content").into());
        result.output = result.prompt.clone();
    }
    if matches!(
        kind,
        "exec_command_begin"
            | "exec_command_end"
            | "mcp_tool_call_begin"
            | "mcp_tool_call_end"
            | "patch_apply_begin"
            | "patch_apply_end"
            | "web_search_begin"
            | "web_search_end"
    ) {
        if kind.ends_with("_begin") || result.args.is_none() {
            result.args = Some(full(payload));
        }
        if let Some(command) = payload.get("command") {
            result.code = Some(
                command
                    .as_array()
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_else(|| full(command)),
            );
            result.language = Some("bash".into());
        } else if let Some(changes) = payload.get("changes") {
            result.code = Some(full(changes));
            result.language = Some("json".into());
        } else if let Some(invocation) = payload.get("invocation") {
            result.code = Some(full(invocation));
            result.language = Some("json".into());
        } else if kind == "web_search_end" {
            let action =
                serde_json::json!({"query":payload.get("query"),"action":payload.get("action")});
            result.args = Some(full(&action));
            result.code = Some(full(&action));
            result.language = Some("json".into());
        }
        if kind.ends_with("_end") {
            result.output = record_output(payload);
        }
    }
    if kind == "item_completed" || kind == "item_started" {
        let item = &payload["item"];
        if s(item, "type") == "UserMessage" {
            result.prompt = Some(prompt_content(&item["content"]));
        }
        if let Some(command) = item.get("command") {
            result.code = Some(
                command
                    .as_array()
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_else(|| full(command)),
            );
            result.language = Some("bash".into());
        }
        if let Some(args) = item.get("arguments") {
            result.args = Some(full(args));
            if result.code.is_none() {
                result.code = result.args.clone();
                result.language = Some("json".into());
            }
        }
        if let Some(changes) = item.get("changes") {
            result.code = Some(full(changes));
            result.language = Some("json".into());
        }
        if let Some(output) = record_output(item) {
            result.output = Some(output);
        } else if item.get("content").is_some() && s(item, "type") != "UserMessage" {
            result.output = Some(prompt_content(&item["content"]));
        }
        if s(item, "type") == "Reasoning" {
            result.output = Some(full(item));
        }
    }
}

#[wasm_bindgen]
pub struct DetailParser {
    engine: Engine,
    offset: u64,
    page_size: usize,
}
#[wasm_bindgen]
impl DetailParser {
    #[wasm_bindgen(constructor)]
    pub fn new(selector_json: &str) -> Result<DetailParser, ParserError> {
        let selector: Selector =
            serde_json::from_str(selector_json).map_err(|e| parser_error(&e.to_string()))?;
        let lines: BTreeSet<usize> = [selector.source_line, selector.output_line]
            .into_iter()
            .flatten()
            .filter(|n| *n > 0)
            .collect();
        if lines.is_empty() && selector.call_id.is_none() {
            return Err(parser_error(
                "A physical sourceLine/outputLine or callId is required to load details.",
            ));
        }
        let page_size = selector
            .page_size
            .unwrap_or(1024 * 1024)
            .clamp(64 * 1024, 2 * 1024 * 1024);
        let offset = selector.offset.unwrap_or(0);
        let mut engine = Engine::new(true);
        engine.capture_mode = true;
        engine.capture_lines = (!lines.is_empty()).then_some(lines);
        engine.capture_call = if engine.capture_lines.is_none() {
            selector.call_id
        } else {
            None
        };
        engine.string_limit = page_size as u64;
        engine.string_offset = offset;
        Ok(Self {
            engine,
            offset,
            page_size,
        })
    }
    pub fn push(&mut self, chunk: &str) {
        self.engine.push(chunk);
    }
    pub fn is_done(&self) -> bool {
        self.engine
            .capture_lines
            .as_ref()
            .and_then(|lines| lines.last())
            .is_some_and(|last| self.engine.line_number > *last)
    }
    pub fn finish(&mut self) -> String {
        self.engine.finish();
        let mut result = Details::default();
        for record in &self.engine.captured {
            capture(&mut result, record);
        }
        result.has_more =
            self.engine.max_string_bytes > self.offset.saturating_add(self.page_size as u64);
        if result.has_more {
            result.next_offset = Some(self.offset.saturating_add(self.page_size as u64));
        }
        if self.engine.parsed.metadata.malformed_lines > 0 {
            result
                .warnings
                .push("A selected record is incomplete or malformed.".into());
        }
        if self.engine.oversized > 0 {
            result.warnings.push("The selected record exceeds the retained structured-record limit; individual large strings are paged, but this record has too many structured values.".into());
        }
        if self.engine.captured.is_empty() {
            result.warnings.push(
                "No matching source record was found; the session may have changed on disk.".into(),
            );
        }
        serde_json::to_string(&result).unwrap()
    }
}
