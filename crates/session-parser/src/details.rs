//! Lazy detail reads use physical record positions and retain only selected
//! records. Large JSON strings are accessible in pages without an excerpt marker.
use crate::{classify, parser_error, prompt_content, record_output, s, Engine, ParserError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
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
// JSON-pointer provenance for strings with another page. Offsets refer to the
// retained JSON, so equal string values in unrelated fields cannot collide.
pub(crate) struct CapturedRecord {
    value: Value,
    paged_paths: Vec<String>,
}
impl CapturedRecord {
    pub(crate) fn new(value: Value, line: &str, base: usize, offsets: &BTreeSet<usize>) -> Self {
        fn visit(
            raw: &serde_json::value::RawValue,
            path: &str,
            base: usize,
            offsets: &BTreeSet<usize>,
            paths: &mut Vec<String>,
        ) {
            let text = raw.get();
            match text.as_bytes().first() {
                Some(b'"') if offsets.contains(&(text.as_ptr() as usize - base)) => {
                    paths.push(path.into())
                }
                Some(b'{') => {
                    if let Ok(fields) =
                        serde_json::from_str::<BTreeMap<String, &serde_json::value::RawValue>>(text)
                    {
                        for (key, child) in fields {
                            let key = key.replace('~', "~0").replace('/', "~1");
                            visit(child, &format!("{path}/{key}"), base, offsets, paths);
                        }
                    }
                }
                Some(b'[') => {
                    if let Ok(items) =
                        serde_json::from_str::<Vec<&serde_json::value::RawValue>>(text)
                    {
                        for (index, child) in items.iter().enumerate() {
                            visit(child, &format!("{path}/{index}"), base, offsets, paths);
                        }
                    }
                }
                _ => {}
            }
        }
        let mut paged_paths = Vec::new();
        if !offsets.is_empty() {
            if let Ok(raw) = serde_json::from_str::<&serde_json::value::RawValue>(line) {
                visit(raw, "", base, offsets, &mut paged_paths);
            }
        }
        Self { value, paged_paths }
    }
}

struct ContentReader<'a> {
    paged: Vec<&'a Value>,
    has_more: Cell<bool>,
}
impl ContentReader<'_> {
    fn mark(&self, value: &Value) {
        if self.paged.iter().any(|paged| std::ptr::eq(*paged, value)) {
            self.has_more.set(true);
        }
        match value {
            Value::Array(items) => items.iter().for_each(|item| self.mark(item)),
            Value::Object(fields) => fields.values().for_each(|item| self.mark(item)),
            _ => {}
        }
    }
    fn full(&self, v: &Value) -> String {
        self.mark(v);
        v.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| serde_json::to_string_pretty(v).unwrap())
    }
    fn text(&self, v: &Value, key: &str) -> String {
        if let Some(value) = v.get(key).filter(|value| value.is_string()) {
            self.mark(value);
        }
        s(v, key).into()
    }
    fn command(&self, v: &Value) -> String {
        v.as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|part| part.is_string())
                    .map(|part| self.full(part))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_else(|| self.full(v))
    }
    fn prompt(&self, v: &Value) -> String {
        if v.is_string() {
            self.mark(v);
        }
        if let Some(items) = v.as_array() {
            for item in items
                .iter()
                .filter(|item| s(item, "type") != "encrypted_content")
            {
                if let Some(text) = item.get("text").filter(|value| value.is_string()) {
                    self.mark(text);
                }
            }
        }
        prompt_content(v)
    }
    fn output(&self, v: &Value) -> Option<String> {
        // Match record_output's primary-field precedence and additional errors.
        let material =
            |value: &&Value| !value.is_null() && !value.as_str().is_some_and(str::is_empty);
        if let Some(value) = [
            "aggregated_output",
            "output",
            "result",
            "results",
            "stdout",
            "formatted_output",
        ]
        .iter()
        .filter_map(|key| v.get(key))
        .find(material)
        {
            self.mark(value);
        }
        for key in ["stderr", "error", "error_message"] {
            if let Some(value) = v.get(key) {
                self.mark(value);
            }
        }
        record_output(v)
    }
}
fn capture(result: &mut Details, captured: &CapturedRecord) {
    let record = &captured.value;
    let reader = ContentReader {
        paged: captured
            .paged_paths
            .iter()
            .filter_map(|path| record.pointer(path))
            .collect(),
        has_more: Cell::new(false),
    };
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
            .map(|value| reader.full(value))
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
                .map(|value| reader.full(value))
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
        result.output = payload.get("output").map(|value| reader.full(value));
    }
    if kind == "user_message" {
        result.prompt = Some(reader.text(payload, "message"));
    }
    if kind == "agent_message" && payload.get("message").is_some() {
        result.output = Some(reader.text(payload, "message"));
    }
    if kind == "message" {
        let text = reader.prompt(&payload["content"]);
        if s(payload, "role") == "user" {
            result.prompt = Some(text);
        } else {
            result.output = Some(text);
        }
    }
    if kind == "agent_message" && payload.get("content").is_some() {
        result.prompt = Some(reader.prompt(&payload["content"]));
        result.output = result.prompt.clone();
        if payload["content"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| s(item, "type") == "encrypted_content")
        }) {
            result.args = Some(reader.full(payload));
            result
                .warnings
                .push("The task payload is encrypted in this session file.".into());
        }
    }
    if s(record, "type") == "inter_agent_communication" {
        result.prompt = Some(reader.text(payload, "content"));
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
        let web_action = kind == "web_search_end"
            && ["command", "changes", "invocation"]
                .iter()
                .all(|key| payload.get(key).is_none());
        if !web_action && (kind.ends_with("_begin") || result.args.is_none()) {
            result.args = Some(reader.full(payload));
        }
        if let Some(command) = payload.get("command") {
            result.code = Some(reader.command(command));
            result.language = Some("bash".into());
        } else if let Some(changes) = payload.get("changes") {
            result.code = Some(reader.full(changes));
            result.language = Some("json".into());
        } else if let Some(invocation) = payload.get("invocation") {
            result.code = Some(reader.full(invocation));
            result.language = Some("json".into());
        } else if web_action {
            for key in ["query", "action"] {
                if let Some(value) = payload.get(key) {
                    reader.mark(value);
                }
            }
            let action =
                serde_json::json!({"query":payload.get("query"),"action":payload.get("action")});
            result.args = Some(reader.full(&action));
            result.code = Some(reader.full(&action));
            result.language = Some("json".into());
        }
        if kind.ends_with("_end") {
            result.output = reader.output(payload);
        }
    }
    if kind == "item_completed" || kind == "item_started" {
        let item = &payload["item"];
        if s(item, "type") == "UserMessage" {
            result.prompt = Some(reader.prompt(&item["content"]));
        }
        if let Some(command) = item.get("command") {
            result.code = Some(reader.command(command));
            result.language = Some("bash".into());
        }
        if let Some(args) = item.get("arguments") {
            result.args = Some(reader.full(args));
            if result.code.is_none() {
                result.code = result.args.clone();
                result.language = Some("json".into());
            }
        }
        if let Some(changes) = item.get("changes") {
            result.code = Some(reader.full(changes));
            result.language = Some("json".into());
        }
        if let Some(output) = reader.output(item) {
            result.output = Some(output);
        } else if item.get("content").is_some() && s(item, "type") != "UserMessage" {
            result.output = Some(reader.prompt(&item["content"]));
        }
        if s(item, "type") == "Reasoning" {
            result.output = Some(reader.full(item));
        }
    }
    result.has_more |= reader.has_more.get();
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
