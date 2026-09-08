//! Codex rollouts are an append-only event log, not a complete profiler trace.
//! Explicit lifecycle timestamps win; gaps are labelled as inferred, never API latency.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use wasm_bindgen::prelude::*;

pub mod analysis;
pub mod details;
pub mod log;

// JsError constructs a JavaScript Error and is unavailable on native targets.
// Keep browser exceptions while making the native API return ordinary errors.
#[cfg(target_arch = "wasm32")]
pub type ParserError = JsError;
#[cfg(not(target_arch = "wasm32"))]
pub type ParserError = String;

fn parser_error(message: &str) -> ParserError {
    #[cfg(target_arch = "wasm32")]
    {
        JsError::new(message)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        message.to_owned()
    }
}

const DETAIL_LIMIT: usize = 16 * 1024;
const LINE_LIMIT: usize = 8 * 1024 * 1024;
const STRING_LIMIT: usize = 64 * 1024;
const SPAN_LIMIT: usize = 100_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub id: String,
    pub title: String,
    pub model: String,
    pub cwd: String,
    pub start_time: f64,
    pub end_time: f64,
    pub turn_count: usize,
    pub child_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_description: Option<String>,
    pub record_count: usize,
    pub malformed_lines: usize,
    #[serde(default)]
    pub oversized_lines: usize,
    #[serde(default)]
    pub oversized_bytes: u64,
    #[serde(default)]
    pub elided_strings: usize,
    #[serde(default)]
    pub elided_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub index: usize,
    pub title: String,
    pub start_time: f64,
    pub end_time: f64,
    pub model: String,
    pub status: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_line: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub track: String,
    pub name: String,
    pub start_time: f64,
    pub end_time: f64,
    pub status: String,
    pub inferred: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_line: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOperation {
    pub span_id: String,
    pub kind: String,
    pub target_ids: Vec<String>,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSession {
    pub metadata: SessionMetadata,
    pub turns: Vec<Turn>,
    pub spans: Vec<Span>,
    pub agent_operations: Vec<AgentOperation>,
    #[serde(default)]
    pub log_entries: Vec<log::LogEntry>,
    pub warnings: Vec<String>,
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn opt(v: &Value, key: &str) -> Option<String> {
    let text = s(v, key);
    (!text.is_empty()).then(|| text.to_string())
}
fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [truncated]", &text[..end])
}
fn detail(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        clip(text, DETAIL_LIMIT)
    } else {
        clip(&v.to_string(), DETAIL_LIMIT)
    }
}
fn text_content(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return clip(text, DETAIL_LIMIT);
    }
    if let Some(items) = v.as_array() {
        let mut text = String::new();
        for item in items {
            if text.len() >= DETAIL_LIMIT {
                break;
            }
            let part = item.get("text").and_then(Value::as_str).unwrap_or("");
            if !part.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&clip(part, DETAIL_LIMIT - text.len()));
            }
        }
        return text;
    }
    String::new()
}
fn prompt_content(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return text.into();
    }
    v.as_array()
        .map(|items| {
            items
                .iter()
                // Typed encrypted blocks are not plaintext prompt material.
                .filter(|item| s(item, "type") != "encrypted_content")
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn record_output(v: &Value) -> Option<String> {
    let material = |value: &Value| {
        if value.is_null() || value.as_str().is_some_and(str::is_empty) {
            None
        } else {
            Some(
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
            )
        }
    };
    let mut output = [
        "aggregated_output",
        "output",
        "result",
        "results",
        "stdout",
        "formatted_output",
    ]
    .iter()
    .find_map(|key| v.get(key).and_then(material));
    for key in ["stderr", "error", "error_message"] {
        if let Some(extra) = v.get(key).and_then(material) {
            if output.as_ref().is_some_and(|text| text.contains(&extra)) {
                continue;
            }
            match &mut output {
                Some(text) => {
                    text.push('\n');
                    text.push_str(&extra);
                }
                None => output = Some(extra),
            }
        }
    }
    output
}
/// Codex injects these context fragments in separate input records. They must
/// not claim the physical source location of the following actual user request.
/// Keep this list explicit: arbitrary XML can itself be a legitimate request.
fn is_context_input(text: &str) -> bool {
    [
        "<recommended_plugins>",
        "<environment_context>",
        "<app-context>",
        "<permissions instructions>",
        "<skills_instructions>",
        "<apps_instructions>",
        "<plugins_instructions>",
        "<environments_instructions>",
        "<collaboration_mode>",
        "<multi_agent_role>",
        "<multi_agent_mode>",
        "<context_window>",
        "<context_window_guidance>",
        "<managed_developer_instructions>",
        "<user_instructions>",
        "# AGENTS.md instructions",
    ]
    .iter()
    .any(|prefix| {
        text.get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
    })
}

/// Strip only the known transport envelope for concise labels. The stored
/// prompt and selected source record remain complete and unchanged.
fn brief_body(text: &str) -> &str {
    let Some(after_prefix) = text.strip_prefix("Message Type: ") else {
        return text;
    };
    let Some((kind, mut rest)) = after_prefix.split_once('\n') else {
        return text;
    };
    if !matches!(kind.trim(), "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER") {
        return text;
    }
    loop {
        let Some((line, following)) = rest.split_once('\n') else {
            return if rest.trim() == "Payload:" { "" } else { text };
        };
        if line.trim() == "Payload:" {
            return following.trim();
        }
        if !line.starts_with("Task name: ")
            && !line.starts_with("Sender: ")
            && !line.trim().is_empty()
        {
            return text;
        }
        rest = following;
    }
}
fn incoming_sender(v: &Value, text: &str) -> Option<String> {
    opt(v, "author").or_else(|| opt(v, "sender")).or_else(|| {
        text.starts_with("Message Type: ")
            .then(|| {
                text.lines()
                    .take_while(|line| line.trim() != "Payload:")
                    .find_map(|line| line.strip_prefix("Sender: ").map(str::trim))
                    .filter(|sender| !sender.is_empty())
                    .map(str::to_owned)
            })
            .flatten()
    })
}

/// Some historical parent tool arguments store the same opaque token that the
/// child explicitly types as `encrypted_content`, without that type annotation.
/// Recognize only the complete, canonically padded URL-safe transport shape:
/// version 0x80, a 2000–2100 timestamp, and a 57-byte header/tag plus 16-byte blocks.
/// This is a label heuristic, not decryption or authentication; raw details stay intact.
fn is_encoded_agent_payload(text: &str) -> bool {
    if !text.starts_with("gAAAA") || text.len() < 100 || !text.len().is_multiple_of(4) {
        return false;
    }
    let body = text.trim_end_matches('=');
    let padding = text.len() - body.len();
    let decoded_len = body.len() * 6 / 8;
    if padding > 2
        || decoded_len < 73
        || !(decoded_len - 57).is_multiple_of(16)
        || padding != (3 - decoded_len % 3) % 3
    {
        return false;
    }
    let mut header = [0_u8; 9];
    let mut decoded = 0;
    let mut bits = 0;
    let mut buffer = 0_u32;
    for byte in body.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return false,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if decoded < header.len() {
                header[decoded] = (buffer >> bits) as u8;
            }
            decoded += 1;
        }
    }
    let timestamp = u64::from_be_bytes(header[1..].try_into().unwrap());
    header[0] == 0x80
        && (946_684_800..=4_102_444_800).contains(&timestamp)
        && buffer & ((1 << bits) - 1) == 0
}
fn timestamp(v: &Value) -> f64 {
    if let Some(n) = v.as_f64() {
        return n;
    }
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis() as f64)
        .unwrap_or(0.0)
}
fn event_time(v: &Value, field: &str, fallback: f64) -> f64 {
    v.get(field)
        .and_then(Value::as_f64)
        .filter(|x| *x > 0.0)
        .unwrap_or(fallback)
}
fn output_failed(v: &Value) -> bool {
    if v.get("isError").and_then(Value::as_bool) == Some(true)
        || ["exit_code", "exitCode"]
            .iter()
            .any(|key| v.get(key).and_then(Value::as_i64).is_some_and(|n| n != 0))
    {
        return true;
    }
    let Some(text) = v.as_str() else {
        return false;
    };
    text.lines()
        .take(8)
        .take_while(|line| !matches!(line.trim(), "Output:" | "Final output:"))
        .any(|line| {
            let line = line.trim();
            line.strip_prefix("Process exited with code ")
                .or_else(|| line.strip_prefix("Exit code:"))
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|token| token.parse::<i64>().ok())
                .is_some_and(|code| code != 0)
        })
}
fn normalized(name: &str) -> String {
    name.rsplit(['.', ':'])
        .next()
        .unwrap_or(name)
        .to_ascii_lowercase()
}
fn op_kind(name: &str) -> Option<&'static str> {
    match normalized(name).as_str() {
        "spawn_agent" | "spawnagent" => Some("spawn"),
        "send_message" | "send_input" | "followup_task" | "sendmessage" | "sendinput"
        | "followuptask" => Some("send"),
        "wait" | "wait_agent" => Some("wait"),
        "resume_agent" | "resumeagent" => Some("resume"),
        "close_agent" | "interrupt_agent" | "closeagent" | "interruptagent" => Some("close"),
        _ => None,
    }
}
fn is_thread_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn classify(name: &str, arguments: &str) -> &'static str {
    let lower = normalized(name);
    if let Some(kind) = op_kind(name) {
        return match kind {
            "wait" => "agent_wait",
            "send" => "agent_messages",
            _ => "agent_dispatch",
        };
    }
    match lower.as_str() {
        "exec" | "js" => "code",
        "exec_command" | "shell" | "shell_command" | "commandexecution" | "write_stdin"
        | "local_shell_call" => {
            if arguments.contains("SKILL.md") && !arguments.contains("apply_patch") {
                "skills"
            } else {
                "shell"
            }
        }
        "apply_patch" | "filechange" => "files",
        "request_user_input" | "request_user_input_async" | "request_permissions" => "approval",
        "web_search_call" | "image_generation_call" | "view_image" | "imageview" | "imagegen" => {
            "web"
        }
        "contextcompaction" | "compacted" => "context",
        _ if name.contains("web") || name.contains("image_gen") => "web",
        _ => "tools",
    }
}
fn targets(v: &Value) -> Vec<String> {
    let mut result = BTreeSet::new();
    for key in [
        "target",
        "id",
        "agent_id",
        "new_thread_id",
        "receiver_thread_id",
        "agent_thread_id",
        "task_name",
    ] {
        if let Some(value) = v.get(key).and_then(Value::as_str) {
            if !value.is_empty() {
                result.insert(value.to_owned());
            }
        }
    }
    for key in ["ids", "targets", "receiver_thread_ids"] {
        if let Some(values) = v.get(key).and_then(Value::as_array) {
            for value in values.iter().filter_map(Value::as_str) {
                result.insert(value.to_owned());
            }
        }
    }
    for key in ["receiver_agents", "agent_statuses"] {
        if let Some(values) = v.get(key).and_then(Value::as_array) {
            for value in values {
                if let Some(id) = value.get("thread_id").and_then(Value::as_str) {
                    result.insert(id.to_owned());
                }
            }
        }
    }
    for key in ["agents_states", "statuses"] {
        if let Some(values) = v.get(key).and_then(Value::as_object) {
            result.extend(values.keys().cloned());
        }
    }
    result.into_iter().collect()
}

/// Stateful parser keeps at most one bounded line plus normalized trace state.
pub struct Engine {
    parsed: ParsedSession,
    metadata_only: bool,
    pending_line: String,
    dropping_line: bool,
    turns_by_id: HashMap<String, usize>,
    active_turn: Option<usize>,
    calls: HashMap<String, usize>,
    call_kinds: HashMap<String, String>,
    child_ids: BTreeSet<String>,
    path_to_id: HashMap<String, String>,
    history_start: u64,
    generated: usize,
    oversized: usize,
    span_limit_hit: bool,
    finished: bool,
    untimestamped: usize,
    line_bytes: u64,
    in_string: bool,
    escaped: bool,
    unicode_digits: u8,
    unicode_value: u16,
    force_low_surrogate: bool,
    string_bytes: u64,
    eliding: bool,
    line_number: usize,
    capture_lines: Option<BTreeSet<usize>>,
    captured: Vec<Value>,
    capture_mode: bool,
    string_limit: u64,
    string_offset: u64,
    string_start: usize,
    paged_string: bool,
    max_string_bytes: u64,
    surrogate_keep: bool,
    capture_call: Option<String>,
}

impl Engine {
    pub fn new(metadata_only: bool) -> Self {
        Self {
            parsed: ParsedSession {
                metadata: SessionMetadata {
                    title: "Untitled session".into(),
                    model: "Unknown model".into(),
                    ..Default::default()
                },
                ..Default::default()
            },
            metadata_only,
            pending_line: String::new(),
            dropping_line: false,
            turns_by_id: HashMap::new(),
            active_turn: None,
            calls: HashMap::new(),
            call_kinds: HashMap::new(),
            child_ids: BTreeSet::new(),
            path_to_id: HashMap::new(),
            history_start: 0,
            generated: 0,
            oversized: 0,
            span_limit_hit: false,
            finished: false,
            untimestamped: 0,
            line_bytes: 0,
            in_string: false,
            escaped: false,
            unicode_digits: 0,
            unicode_value: 0,
            force_low_surrogate: false,
            string_bytes: 0,
            eliding: false,
            line_number: 1,
            capture_lines: None,
            captured: Vec::new(),
            capture_mode: false,
            string_limit: STRING_LIMIT as u64,
            string_offset: 0,
            string_start: 0,
            paged_string: false,
            max_string_bytes: 0,
            surrogate_keep: false,
            capture_call: None,
        }
    }

    pub fn push(&mut self, chunk: &str) {
        if self.finished {
            return;
        }
        for part in chunk.split_inclusive('\n') {
            let terminated = part.ends_with('\n');
            if self
                .capture_lines
                .as_ref()
                .is_some_and(|lines| !lines.contains(&self.line_number))
            {
                if terminated {
                    self.line_number += 1;
                }
                continue;
            }
            self.line_bytes += part.len() as u64;
            if !self.dropping_line {
                if self.pending_line.is_empty() && terminated && part.len() <= STRING_LIMIT {
                    self.line(part);
                } else {
                    self.retain_json(if terminated {
                        &part[..part.len() - 1]
                    } else {
                        part
                    });
                    if terminated && !self.dropping_line {
                        let line = std::mem::take(&mut self.pending_line);
                        self.line(&line);
                    }
                }
            } else {
                self.parsed.metadata.oversized_bytes += part.len() as u64;
            }
            if terminated {
                self.line_number += 1;
                self.dropping_line = false;
                self.line_bytes = 0;
                self.in_string = false;
                self.escaped = false;
                self.unicode_digits = 0;
                self.unicode_value = 0;
                self.force_low_surrogate = false;
                self.string_bytes = 0;
                self.eliding = false;
                self.paged_string = false;
            }
        }
    }

    /// Elide huge JSON string bodies while retaining their quotes and envelope.
    /// Fast scans skip ordinary UTF-8/base64 runs, preserving escaped quote and
    /// Unicode escape state across push boundaries without buffering the body.
    fn retain_json(&mut self, part: &str) {
        let bytes = part.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if self.pending_line.len() > LINE_LIMIT {
                self.parsed.metadata.oversized_bytes += self.line_bytes;
                self.pending_line.clear();
                self.dropping_line = true;
                self.oversized += 1;
                return;
            }
            if !self.in_string {
                let end = memchr::memchr(b'"', &bytes[i..])
                    .map(|n| i + n)
                    .unwrap_or(bytes.len());
                if self.pending_line.len() + end - i > LINE_LIMIT {
                    self.parsed.metadata.oversized_bytes += self.line_bytes;
                    self.pending_line.clear();
                    self.dropping_line = true;
                    self.oversized += 1;
                    return;
                }
                self.pending_line.push_str(&part[i..end]);
                i = end;
                if i < bytes.len() {
                    self.pending_line.push('"');
                    i += 1;
                    self.in_string = true;
                    self.string_bytes = 0;
                    self.eliding = false;
                    self.force_low_surrogate = false;
                    self.string_start = self.pending_line.len();
                    self.paged_string = false;
                }
                continue;
            }
            if self.escaped || self.unicode_digits > 0 {
                // Valid JSON escapes are ASCII, but retain invalid input safely so serde reports it.
                let ch = part[i..].chars().next().unwrap();
                let size = ch.len_utf8();
                if self.eliding {
                    self.parsed.metadata.elided_bytes += size as u64;
                } else {
                    self.pending_line.push(ch);
                }
                self.string_bytes += size as u64;
                i += size;
                if self.unicode_digits > 0 {
                    self.unicode_value = self
                        .unicode_value
                        .wrapping_mul(16)
                        .wrapping_add(ch.to_digit(16).unwrap_or(0) as u16);
                    self.unicode_digits -= 1;
                    if self.unicode_digits == 0 {
                        self.force_low_surrogate = (0xD800..=0xDBFF).contains(&self.unicode_value);
                        if self.force_low_surrogate {
                            self.surrogate_keep = !self.eliding;
                        }
                    }
                } else {
                    self.escaped = false;
                    if ch == 'u' {
                        self.unicode_digits = 4;
                        self.unicode_value = 0;
                    }
                }
                continue;
            }
            let end = memchr::memchr2(b'"', b'\\', &bytes[i..])
                .map(|n| i + n)
                .unwrap_or(bytes.len());
            if end > i {
                if self.capture_mode {
                    if self.string_offset > 0
                        && !self.paged_string
                        && self.string_bytes + (end - i) as u64 > self.string_limit
                    {
                        self.pending_line.truncate(self.string_start);
                        self.paged_string = true;
                    }
                    let offset = if self.paged_string {
                        self.string_offset
                    } else {
                        0
                    };
                    let mut from = offset
                        .saturating_sub(self.string_bytes)
                        .min((end - i) as u64) as usize;
                    let mut until = offset
                        .saturating_add(self.string_limit)
                        .saturating_sub(self.string_bytes)
                        .min((end - i) as u64) as usize;
                    // Assign a UTF-8 scalar to the page containing its first byte.
                    while from < end - i && !part.is_char_boundary(i + from) {
                        from += 1;
                    }
                    while until < end - i && !part.is_char_boundary(i + until) {
                        until += 1;
                    }
                    if until > from {
                        self.pending_line.push_str(&part[i + from..i + until]);
                    }
                    self.string_bytes += (end - i) as u64;
                    i = end;
                } else {
                    let remaining = self.string_limit.saturating_sub(self.string_bytes) as usize;
                    let mut kept = (end - i).min(remaining);
                    while kept > 0 && !part.is_char_boundary(i + kept) {
                        kept -= 1;
                    }
                    if !self.eliding && kept > 0 {
                        self.pending_line.push_str(&part[i..i + kept]);
                    }
                    if self.eliding {
                        self.parsed.metadata.elided_bytes += (end - i) as u64;
                    } else if kept < end - i {
                        self.eliding = true;
                        self.parsed.metadata.elided_strings += 1;
                        self.parsed.metadata.elided_bytes += (end - i - kept) as u64;
                    }
                    self.string_bytes += (end - i) as u64;
                    i = end;
                }
            }
            if i == bytes.len() {
                continue;
            }
            if bytes[i] == b'"' {
                if self.capture_mode
                    && self.string_offset > 0
                    && !self.paged_string
                    && self.string_bytes > self.string_limit
                {
                    self.pending_line.truncate(self.string_start);
                    self.paged_string = true;
                }
                self.max_string_bytes = self.max_string_bytes.max(self.string_bytes);
                if self.eliding && !self.capture_mode {
                    self.pending_line.push_str("… [truncated]");
                }
                self.pending_line.push('"');
                self.in_string = false;
                self.eliding = false;
                i += 1;
            } else {
                // Reserve the entire possible six-byte Unicode escape. Never leave a
                // retained dangling backslash or half of a \uXXXX sequence.
                if self.capture_mode {
                    if self.string_offset > 0
                        && !self.paged_string
                        && self.string_bytes >= self.string_limit
                        && !self.force_low_surrogate
                    {
                        self.pending_line.truncate(self.string_start);
                        self.paged_string = true;
                    }
                    let offset = if self.paged_string {
                        self.string_offset
                    } else {
                        0
                    };
                    self.eliding = if self.force_low_surrogate {
                        !self.surrogate_keep
                    } else {
                        self.string_bytes < offset
                            || self.string_bytes >= offset.saturating_add(self.string_limit)
                    };
                } else if !self.eliding
                    && !self.force_low_surrogate
                    && self.string_bytes + 6 > self.string_limit
                {
                    self.eliding = true;
                    self.parsed.metadata.elided_strings += 1;
                }
                if self.eliding {
                    self.parsed.metadata.elided_bytes += 1;
                } else {
                    self.pending_line.push('\\');
                }
                self.string_bytes += 1;
                self.escaped = true;
                i += 1;
            }
        }
        if self.pending_line.len() > LINE_LIMIT {
            self.parsed.metadata.oversized_bytes += self.line_bytes;
            self.pending_line.clear();
            self.dropping_line = true;
            self.oversized += 1;
        }
    }

    fn line(&mut self, line: &str) {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            return;
        }
        if self.capture_mode {
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    let payload = value.get("payload").unwrap_or(&value);
                    if self.capture_call.as_ref().is_none_or(|id| {
                        s(payload, "call_id") == id || s(&payload["item"], "id") == id
                    }) {
                        self.captured.push(value);
                    }
                }
                Err(_) => self.parsed.metadata.malformed_lines += 1,
            };
            return;
        }
        // Borrowing RawValue avoids allocating discarded image/tool output payloads during indexing.
        #[derive(Deserialize)]
        struct Envelope<'a> {
            #[serde(rename = "type")]
            kind: &'a str,
            #[serde(default)]
            timestamp: Option<&'a str>,
            #[serde(default)]
            ordinal: Option<u64>,
            #[serde(borrow)]
            payload: &'a serde_json::value::RawValue,
        }
        let envelope = match serde_json::from_str::<Envelope<'_>>(line) {
            Ok(value) => value,
            Err(_) => {
                self.legacy_line(line);
                return;
            }
        };
        self.parsed.metadata.record_count += 1;
        if envelope.kind != "session_meta"
            && envelope.ordinal.is_some_and(|n| n < self.history_start)
        {
            return;
        }
        let time = envelope
            .timestamp
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp_millis() as f64)
            .unwrap_or(self.parsed.metadata.end_time);
        if time > 0.0 {
            if self.parsed.metadata.start_time == 0.0 {
                self.parsed.metadata.start_time = time;
            }
            self.parsed.metadata.end_time = self.parsed.metadata.end_time.max(time);
        }
        if self.metadata_only
            && matches!(
                envelope.kind,
                "token_usage_record"
                    | "world_state"
                    | "compacted"
                    | "inter_agent_communication_metadata"
            )
        {
            return;
        }
        let v: Value = match serde_json::from_str(envelope.payload.get()) {
            Ok(v) => v,
            Err(_) => {
                self.parsed.metadata.malformed_lines += 1;
                return;
            }
        };
        match envelope.kind {
            "session_meta" => self.session_meta(&v, time),
            "turn_context" => {
                self.model(&v);
                if let Some(index) = self.active_turn {
                    self.parsed.turns[index]
                        .model
                        .clone_from(&self.parsed.metadata.model);
                }
            }
            "event_msg" => self.event(&v, time),
            "response_item" => self.response(&v, time),
            "inter_agent_communication" => {
                if self.parsed.metadata.parent_id.is_some() {
                    self.title(s(&v, "content"));
                }
                if !self.metadata_only {
                    self.add(Span {
                        track: "agent_messages".into(),
                        name: "Agent message received".into(),
                        start_time: time,
                        end_time: time,
                        status: "complete".into(),
                        output: Some(clip(s(&v, "content"), DETAIL_LIMIT)),
                        target_agent_id: incoming_sender(&v, s(&v, "content")),
                        call_id: opt(&v, "call_id"),
                        ..Default::default()
                    });
                }
            }
            "compacted" if !self.metadata_only => {
                self.instant("context", "Context compacted", time, None);
            }
            _ => (),
        }
    }

    fn legacy_line(&mut self, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            self.parsed.metadata.malformed_lines += 1;
            return;
        };
        if v.get("record_type").is_some() {
            self.parsed.metadata.record_count += 1;
            return;
        }
        if v.get("type").is_none() && v.get("id").is_some() && v.get("timestamp").is_some() {
            self.parsed.metadata.record_count += 1;
            self.session_meta(&v, timestamp(&v["timestamp"]));
            self.parsed.metadata.end_time = self.parsed.metadata.start_time;
            return;
        }
        if matches!(
            s(&v, "type"),
            "message"
                | "reasoning"
                | "function_call"
                | "function_call_output"
                | "custom_tool_call"
                | "custom_tool_call_output"
                | "local_shell_call"
                | "web_search_call"
                | "agent_message"
        ) {
            self.parsed.metadata.record_count += 1;
            self.untimestamped += 1;
            let time = self.parsed.metadata.end_time;
            if s(&v, "type") == "message" && s(&v, "role") == "user" {
                if let Some(index) = self.active_turn {
                    self.parsed.turns[index].status = "unknown".into();
                }
                self.active_turn = None;
                self.ensure_turn("", time);
            }
            self.response(&v, time);
            return;
        }
        self.parsed.metadata.malformed_lines += 1;
    }

    fn session_meta(&mut self, v: &Value, time: f64) {
        // A child/fork file can contain copied SessionMeta records from ancestors.
        // The first physical metadata record owns this file for its whole lifetime.
        if !self.parsed.metadata.id.is_empty() && self.parsed.metadata.id != s(v, "id") {
            return;
        }
        if !s(v, "id").is_empty() {
            self.parsed.metadata.id = s(v, "id").into();
        }
        self.parsed.metadata.cwd = s(v, "cwd").into();
        let source = &v["source"]["subagent"]["thread_spawn"];
        self.parsed.metadata.parent_id =
            opt(v, "parent_thread_id").or_else(|| opt(source, "parent_thread_id"));
        self.parsed.metadata.agent_name =
            opt(v, "agent_nickname").or_else(|| opt(source, "agent_nickname"));
        self.parsed.metadata.agent_path =
            opt(v, "agent_path").or_else(|| opt(source, "agent_path"));
        self.history_start = v["subagent_history_start_ordinal"].as_u64().unwrap_or(0);
        let created = timestamp(&v["timestamp"]);
        if self.parsed.metadata.start_time == 0.0 {
            self.parsed.metadata.start_time = if created > 0.0 { created } else { time };
        }
        self.model(v);
        if self.parsed.metadata.model == "Unknown model" {
            if let Some(model) = v
                .pointer("/base_instructions/provenance/model")
                .and_then(Value::as_str)
            {
                self.parsed.metadata.model = model.into();
            }
        }
    }
    fn model(&mut self, v: &Value) {
        for key in ["model", "model_slug", "to_model"] {
            if !s(v, key).is_empty() {
                self.parsed.metadata.model = s(v, key).into();
                break;
            }
        }
    }
    fn ensure_turn(&mut self, id: &str, time: f64) -> usize {
        if !id.is_empty() {
            if let Some(index) = self.turns_by_id.get(id) {
                self.active_turn = Some(*index);
                return *index;
            }
        } else if let Some(index) = self.active_turn {
            return index;
        }
        let index = self.parsed.turns.len();
        let id = if id.is_empty() {
            format!("turn-{}", index + 1)
        } else {
            id.into()
        };
        self.turns_by_id.insert(id.clone(), index);
        self.parsed.turns.push(Turn {
            id,
            index,
            title: format!("Turn {}", index + 1),
            start_time: time,
            end_time: time,
            model: self.parsed.metadata.model.clone(),
            status: "running".into(),
            prompt: String::new(),
            source_line: None,
        });
        self.active_turn = Some(index);
        index
    }
    fn title(&mut self, text: &str) {
        let original = text;
        let text = text.trim();
        if text.is_empty() || is_context_input(text) {
            return;
        }
        if let Some(index) = self.active_turn {
            if self.parsed.turns[index].prompt.is_empty() {
                self.parsed.turns[index].prompt = original.into();
                self.parsed.turns[index].source_line = Some(self.line_number);
            }
        }
        let text = brief_body(text);
        if text.is_empty() {
            return;
        }
        let text = if self.parsed.metadata.model == "codex-auto-review"
            && text.starts_with(
                "The following is the Codex agent history whose request action you are assessing",
            ) {
            "Review tool request"
        } else {
            text
        };
        let title = clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 160);
        if self.parsed.metadata.agent_description.is_none() {
            self.parsed.metadata.agent_description = Some(title.clone());
        }
        if self.parsed.metadata.title == "Untitled session" {
            self.parsed.metadata.title.clone_from(&title);
        }
        if let Some(index) = self.active_turn {
            if self.parsed.turns[index].title.starts_with("Turn ") {
                self.parsed.turns[index].title = title;
            }
        }
    }
    fn add(&mut self, mut span: Span) -> Option<usize> {
        if self.metadata_only {
            return None;
        }
        if self.parsed.spans.len() >= SPAN_LIMIT {
            self.span_limit_hit = true;
            return None;
        }
        self.generated += 1;
        if span.id.is_empty() {
            span.id = format!("{}:span:{}", self.parsed.metadata.id, self.generated);
        }
        span.session_id.clone_from(&self.parsed.metadata.id);
        if span.source_line.is_none() && !span.inferred && span.track != "turns" {
            span.source_line = Some(self.line_number);
        }
        if span.turn_id.is_none() {
            span.turn_id = self.active_turn.map(|i| self.parsed.turns[i].id.clone());
        }
        span.end_time = span.end_time.max(span.start_time);
        let index = self.parsed.spans.len();
        self.parsed.spans.push(span);
        Some(index)
    }
    fn instant(&mut self, track: &str, name: &str, time: f64, output: Option<String>) {
        self.add(Span {
            track: track.into(),
            name: name.into(),
            start_time: time,
            end_time: time,
            status: "complete".into(),
            output,
            ..Default::default()
        });
    }
    fn operation(&mut self, index: Option<usize>, kind: &str, ids: Vec<String>, time: f64) {
        let ids: Vec<String> = ids
            .into_iter()
            .map(|id| {
                if kind == "spawn" && !is_thread_id(&id) && !id.starts_with('/') {
                    format!(
                        "{}/{}",
                        self.parsed
                            .metadata
                            .agent_path
                            .as_deref()
                            .unwrap_or("/root"),
                        id
                    )
                } else {
                    id
                }
            })
            .collect();
        if kind == "spawn" {
            for id in &ids {
                if is_thread_id(id) && id != &self.parsed.metadata.id {
                    self.child_ids.insert(id.clone());
                }
            }
        }
        let Some(index) = index else {
            return;
        };
        let span_id = self.parsed.spans[index].id.clone();
        self.parsed.spans[index].target_agent_id = ids.first().cloned();
        if let Some(operation) = self
            .parsed
            .agent_operations
            .iter_mut()
            .find(|op| op.span_id == span_id)
        {
            if kind == "spawn" {
                if let Some(id) = ids.iter().find(|id| is_thread_id(id)) {
                    for alias in operation
                        .target_ids
                        .iter()
                        .filter(|alias| alias.starts_with('/'))
                    {
                        self.path_to_id.insert(alias.clone(), id.clone());
                    }
                    operation
                        .target_ids
                        .retain(|target| !target.starts_with('/'));
                }
            }
            let mut all: BTreeSet<String> = operation.target_ids.iter().cloned().collect();
            all.extend(ids);
            operation.target_ids = all.into_iter().collect();
        } else {
            self.parsed.agent_operations.push(AgentOperation {
                span_id,
                kind: kind.into(),
                target_ids: ids,
                timestamp: time,
                description: None,
            });
        }
    }

    fn describe_operation(&mut self, index: Option<usize>, text: &str) {
        let text = brief_body(text.trim());
        if text.is_empty() || is_encoded_agent_payload(text) {
            return;
        }
        let Some(index) = index else {
            return;
        };
        let span_id = &self.parsed.spans[index].id;
        if let Some(operation) = self
            .parsed
            .agent_operations
            .iter_mut()
            .find(|op| &op.span_id == span_id)
        {
            if operation.description.is_none() {
                operation.description = Some(clip(
                    &text.split_whitespace().collect::<Vec<_>>().join(" "),
                    240,
                ));
            }
        }
    }

    fn response(&mut self, v: &Value, time: f64) {
        let kind = s(v, "type");
        if self.metadata_only {
            match kind {
                "function_call" | "custom_tool_call" if op_kind(s(v, "name")).is_some() => (),
                "function_call_output" | "custom_tool_call_output"
                    if self.call_kinds.contains_key(s(v, "call_id")) => {}
                "message" if s(v, "role") == "user" => (),
                "agent_message" if self.parsed.metadata.parent_id.is_some() => (),
                _ => return,
            }
        }
        match kind {
            "function_call" | "custom_tool_call" | "local_shell_call" | "tool_search_call" => {
                let name = if s(v, "name").is_empty() {
                    kind
                } else {
                    s(v, "name")
                };
                let arguments = v
                    .get("arguments")
                    .or_else(|| v.get("input"))
                    .or_else(|| v.get("action"))
                    .unwrap_or(&Value::Null);
                let args = if let Some(s) = arguments.as_str() {
                    s.to_string()
                } else {
                    arguments.to_string()
                };
                let obj = serde_json::from_str::<Value>(&args).unwrap_or(Value::Null);
                let id = s(v, "call_id");
                let code = if classify(name, &args) == "code" {
                    obj.get("code")
                        .and_then(Value::as_str)
                        .unwrap_or(&args)
                        .to_owned()
                } else {
                    obj.get("cmd")
                        .or_else(|| obj.get("command"))
                        .map(detail)
                        .unwrap_or_else(|| args.clone())
                };
                let cell_wait = normalized(name) == "wait" && obj.get("cell_id").is_some();
                let track = if cell_wait {
                    "code"
                } else {
                    classify(name, &args)
                };
                let index = self.add(Span {
                    track: track.into(),
                    name: name.into(),
                    start_time: time,
                    end_time: time,
                    status: "incomplete".into(),
                    call_id: (!id.is_empty()).then(|| id.into()),
                    code: Some(clip(&code, DETAIL_LIMIT)),
                    language: Some(
                        if track == "code" && !cell_wait {
                            "javascript"
                        } else if track == "shell" || track == "skills" {
                            "bash"
                        } else {
                            "json"
                        }
                        .into(),
                    ),
                    args: Some(clip(&args, DETAIL_LIMIT)),
                    ..Default::default()
                });
                if let Some(index) = index {
                    if !id.is_empty() {
                        self.calls.insert(id.into(), index);
                    }
                }
                if let Some(kind) = op_kind(name).filter(|_| !cell_wait) {
                    self.call_kinds.insert(id.into(), kind.into());
                    self.operation(index, kind, targets(&obj), time);
                    self.describe_operation(
                        index,
                        if s(&obj, "message").is_empty() {
                            s(&obj, "prompt")
                        } else {
                            s(&obj, "message")
                        },
                    );
                }
            }
            "function_call_output" | "custom_tool_call_output" | "tool_search_output" => {
                let output = v.get("output").unwrap_or(&Value::Null);
                let id = s(v, "call_id");
                if let Some(&index) = self.calls.get(id) {
                    let span = &mut self.parsed.spans[index];
                    span.end_time = time.max(span.start_time);
                    let decoded = output
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .unwrap_or_else(|| output.clone());
                    span.status = if span.status == "error" || output_failed(&decoded) {
                        "error"
                    } else {
                        "complete"
                    }
                    .into();
                    span.output = Some(detail(output));
                    span.output_line = Some(self.line_number);
                    let name = span.name.clone();
                    if let Some(kind) = op_kind(&name) {
                        let decoded = output
                            .as_str()
                            .and_then(|text| serde_json::from_str::<Value>(text).ok())
                            .unwrap_or_else(|| output.clone());
                        self.operation(Some(index), kind, targets(&decoded), time);
                    }
                } else if let Some(kind) = self.call_kinds.get(id).cloned() {
                    let decoded = output
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .unwrap_or_else(|| output.clone());
                    self.operation(None, &kind, targets(&decoded), time);
                }
            }
            "message" if s(v, "role") == "user" => {
                let text = prompt_content(&v["content"]);
                self.title(&text);
            }
            "message" if s(v, "role") == "assistant" && !self.metadata_only => {
                self.instant(
                    "messages",
                    if s(v, "phase") == "final_answer" {
                        "Final answer"
                    } else {
                        "Assistant message"
                    },
                    time,
                    Some(text_content(&v["content"])),
                );
            }
            "agent_message" => {
                if self.parsed.metadata.parent_id.is_some() {
                    self.title(&prompt_content(&v["content"]));
                }
                if self.metadata_only {
                    return;
                }
                // Reception carries the sender path; do not reverse it into an outgoing flow.
                self.add(Span {
                    track: "agent_messages".into(),
                    name: "Agent message received".into(),
                    start_time: time,
                    end_time: time,
                    status: "complete".into(),
                    output: Some(text_content(&v["content"])),
                    target_agent_id: incoming_sender(v, &prompt_content(&v["content"])),
                    call_id: opt(v, "call_id"),
                    ..Default::default()
                });
            }
            "web_search_call" | "image_generation_call" if !self.metadata_only => {
                self.instant("web", kind, time, v.get("action").map(detail));
            }
            _ => (),
        }
    }

    fn event(&mut self, v: &Value, time: f64) {
        let kind = s(v, "type");
        match kind {
            "task_started" | "turn_started" => {
                self.ensure_turn(s(v, "turn_id"), time);
            }
            "task_complete" | "turn_complete" | "turn_aborted" => {
                let index = if !s(v, "turn_id").is_empty() {
                    self.ensure_turn(s(v, "turn_id"), time)
                } else if let Some(i) = self.active_turn {
                    i
                } else {
                    return;
                };
                self.parsed.turns[index].end_time = time.max(self.parsed.turns[index].start_time);
                self.parsed.turns[index].status = if kind == "turn_aborted" {
                    "aborted"
                } else {
                    "complete"
                }
                .into();
                self.active_turn = None;
            }
            "user_message" => {
                self.ensure_turn("", time);
                self.title(s(v, "message"));
                if !self.metadata_only {
                    self.instant(
                        "messages",
                        "User message",
                        time,
                        Some(clip(s(v, "message"), DETAIL_LIMIT)),
                    );
                }
            }
            "model_reroute" => {
                self.model(v);
            }
            "thread_settings_applied" => {
                self.model(&v["thread_settings"]);
                if let Some(index) = self.active_turn {
                    self.parsed.turns[index]
                        .model
                        .clone_from(&self.parsed.metadata.model);
                }
            }
            "sub_agent_activity" => self.activity(v, time),
            "item_started" | "item_completed" => self.item(v, time),
            _ if kind.starts_with("collab_") => self.legacy_collab(v, time),
            _ if self.metadata_only => (),
            "agent_message" => self.instant(
                "messages",
                if s(v, "phase") == "final_answer" {
                    "Final answer"
                } else {
                    "Assistant message"
                },
                time,
                Some(clip(s(v, "message"), DETAIL_LIMIT)),
            ),
            "context_compacted" => self.instant("context", "Context compacted", time, None),
            "error" | "warning" | "stream_error" => self.instant(
                "system",
                kind,
                time,
                Some(clip(s(v, "message"), DETAIL_LIMIT)),
            ),
            "exec_approval_request"
            | "apply_patch_approval_request"
            | "request_permissions"
            | "request_user_input"
            | "elicitation_request" => self.instant("approval", kind, time, Some(detail(v))),
            "exec_command_begin"
            | "exec_command_end"
            | "mcp_tool_call_begin"
            | "mcp_tool_call_end"
            | "patch_apply_begin"
            | "patch_apply_end"
            | "web_search_begin"
            | "web_search_end" => self.legacy_tool(v, time),
            _ => (),
        }
    }

    fn activity(&mut self, v: &Value, time: f64) {
        let id = s(v, "agent_thread_id");
        let path = s(v, "agent_path");
        if !id.is_empty() {
            if s(v, "kind") == "started" && id != self.parsed.metadata.id {
                self.child_ids.insert(id.into());
            }
            if !path.is_empty() {
                self.path_to_id.insert(path.into(), id.into());
            }
        }
        if !self.metadata_only {
            self.instant(
                "agent_dispatch",
                &format!("Agent {}", s(v, "kind")),
                time,
                Some(path.into()),
            );
        }
    }
    fn item(&mut self, event: &Value, time: f64) {
        let item = &event["item"];
        let kind = s(item, "type");
        if kind == "SubAgentActivity" {
            self.activity(item, time);
            return;
        }
        if kind == "UserMessage" {
            self.ensure_turn(s(event, "turn_id"), time);
            self.title(&prompt_content(&item["content"]));
        }
        if kind == "CollabAgentToolCall" && self.metadata_only {
            if op_kind(s(item, "tool")) == Some("spawn") {
                self.child_ids
                    .extend(targets(item).into_iter().filter(|id| id != s(item, "id")));
            }
            return;
        }
        if self.metadata_only {
            return;
        }
        let id = s(item, "id");
        let end = event_time(event, "completed_at_ms", time);
        let start = event_time(event, "started_at_ms", end);
        let completed = s(event, "type") == "item_completed";
        let name = match kind {
            "CollabAgentToolCall" => s(item, "tool"),
            "McpToolCall" => s(item, "tool"),
            "FunctionCallOutput" => s(item, "name"),
            "Reasoning" => "Inference",
            "AgentMessage" => "Assistant message",
            "UserMessage" => "User message",
            _ => kind,
        };
        let args = item
            .get("arguments")
            .map(detail)
            .unwrap_or_else(|| item.get("command").map(detail).unwrap_or_default());
        let track = match kind {
            "Reasoning" => "inference",
            "AgentMessage" | "UserMessage" => "messages",
            "Extension" => {
                if s(item, "kind").contains("web") {
                    "web"
                } else {
                    "tools"
                }
            }
            _ => classify(name, &args),
        };
        if kind == "FunctionCallOutput" {
            if let Some(&index) = self.calls.get(id) {
                let span = &mut self.parsed.spans[index];
                span.end_time = end.max(span.start_time);
                span.status = "complete".into();
                span.output = item.get("output").map(detail);
                span.output_line = Some(self.line_number);
                return;
            }
        }
        let index = if let Some(&index) = self.calls.get(id) {
            let span = &mut self.parsed.spans[index];
            if start < end {
                span.start_time = start;
            }
            span.end_time = end.max(span.start_time);
            span.status = if span.status == "error"
                || item["exit_code"].as_i64().is_some_and(|c| c != 0)
                || matches!(s(item, "status"), "failed" | "error")
            {
                "error"
            } else if completed {
                "complete"
            } else {
                "running"
            }
            .into();
            Some(index)
        } else {
            let status = if item["exit_code"].as_i64().is_some_and(|c| c != 0)
                || matches!(s(item, "status"), "failed" | "error")
            {
                "error"
            } else if completed {
                "complete"
            } else {
                "running"
            };
            self.add(Span {
                track: track.into(),
                name: name.into(),
                start_time: start,
                end_time: end,
                status: status.into(),
                inferred: start == end && kind == "Reasoning",
                call_id: (!id.is_empty()).then(|| id.into()),
                turn_id: opt(event, "turn_id"),
                args: (!args.is_empty()).then(|| args.clone()),
                ..Default::default()
            })
        };
        if let Some(index) = index {
            if !id.is_empty() {
                self.calls.insert(id.into(), index);
            }
            let span = &mut self.parsed.spans[index];
            span.output = record_output(item)
                .map(|output| clip(&output, DETAIL_LIMIT))
                .or_else(|| {
                    (!text_content(&item["content"]).is_empty())
                        .then(|| text_content(&item["content"]))
                });
            if kind == "Reasoning"
                && ["summary_text", "raw_content"].iter().any(|key| {
                    item.get(key)
                        .and_then(Value::as_array)
                        .is_some_and(|parts| !parts.is_empty())
                })
            {
                span.output = Some(detail(item));
            }
            span.output_line = Some(self.line_number);
            if !args.is_empty() {
                span.code = Some(
                    item["command"]
                        .as_array()
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or(args),
                );
                span.language = Some(
                    if track == "shell" || track == "skills" {
                        "bash"
                    } else {
                        "json"
                    }
                    .into(),
                );
            }
            if kind == "FileChange" {
                span.code = item.get("changes").map(detail);
                span.language = Some("json".into());
            }
        }
        if let Some(kind) = op_kind(name) {
            let ids = targets(item)
                .into_iter()
                .filter(|target| target != id)
                .collect();
            self.operation(index, kind, ids, start);
            self.describe_operation(index, s(item, "prompt"));
        }
    }

    fn legacy_tool(&mut self, event: &Value, time: f64) {
        let kind = s(event, "type");
        let id = s(event, "call_id");
        let begin = kind.ends_with("_begin");
        let failed = event["exit_code"].as_i64().is_some_and(|n| n != 0)
            || event["success"] == false
            || event["result"].get("Err").is_some()
            || output_failed(&event["result"])
            || output_failed(&event["result"]["Ok"]);
        if let Some(&index) = self.calls.get(id) {
            if !begin {
                let span = &mut self.parsed.spans[index];
                span.end_time = time.max(span.start_time);
                span.status = if failed || span.status == "error" {
                    "error"
                } else {
                    "complete"
                }
                .into();
                span.output = record_output(event).map(|text| clip(&text, DETAIL_LIMIT));
                span.output_line = Some(self.line_number);
            }
            return;
        }
        let name = if kind.starts_with("exec") {
            "exec_command"
        } else if kind.starts_with("patch") {
            "apply_patch"
        } else if kind.starts_with("web") {
            "web_search_call"
        } else {
            "MCP tool"
        };
        let args = event
            .get("command")
            .or_else(|| event.get("changes"))
            .or_else(|| event.get("invocation"))
            .or_else(|| event.get("action"))
            .map(detail)
            .unwrap_or_default();
        if let Some(index) = self.add(Span {
            track: classify(name, &args).into(),
            name: name.into(),
            start_time: time,
            end_time: time,
            status: if failed {
                "error"
            } else if begin {
                "incomplete"
            } else {
                "complete"
            }
            .into(),
            inferred: !begin,
            call_id: opt(event, "call_id"),
            code: Some(args),
            language: Some(
                if kind.starts_with("exec") {
                    "bash"
                } else {
                    "json"
                }
                .into(),
            ),
            args: Some(detail(event)),
            output: (!begin)
                .then(|| record_output(event))
                .flatten()
                .map(|text| clip(&text, DETAIL_LIMIT)),
            output_line: (!begin).then_some(self.line_number),
            ..Default::default()
        }) {
            if !id.is_empty() {
                self.calls.insert(id.into(), index);
            }
        }
    }
    fn legacy_collab(&mut self, event: &Value, time: f64) {
        let event_kind = s(event, "type");
        let (name, kind) = if event_kind.contains("spawn") {
            ("spawn_agent", "spawn")
        } else if event_kind.contains("waiting") {
            ("wait", "wait")
        } else if event_kind.contains("resume") {
            ("resume_agent", "resume")
        } else if event_kind.contains("close") {
            ("close_agent", "close")
        } else {
            ("send_input", "send")
        };
        let id = s(event, "call_id");
        let index = if let Some(&index) = self.calls.get(id) {
            if event_kind.ends_with("_end") {
                let span = &mut self.parsed.spans[index];
                span.end_time = event_time(event, "completed_at_ms", time).max(span.start_time);
                span.status = "complete".into();
            }
            Some(index)
        } else {
            let start = event_time(event, "started_at_ms", time);
            self.add(Span {
                track: classify(name, "").into(),
                name: name.into(),
                start_time: start,
                end_time: time,
                status: if event_kind.ends_with("_end") {
                    "complete"
                } else {
                    "incomplete"
                }
                .into(),
                call_id: opt(event, "call_id"),
                args: Some(detail(event)),
                ..Default::default()
            })
        };
        if let Some(index) = index {
            if !id.is_empty() {
                self.calls.insert(id.into(), index);
            }
        }
        self.operation(index, kind, targets(event), time);
        self.describe_operation(index, s(event, "prompt"));
    }

    pub fn finish(&mut self) -> &ParsedSession {
        if self.finished {
            return &self.parsed;
        }
        if !self.pending_line.is_empty() {
            let line = std::mem::take(&mut self.pending_line);
            self.line(&line);
        }
        self.finished = true;
        self.parsed.metadata.turn_count = self.parsed.turns.len();
        self.parsed.metadata.oversized_lines = self.oversized;
        self.parsed.metadata.child_ids = self.child_ids.iter().cloned().collect();
        if self.parsed.metadata.title == "Untitled session"
            && self.parsed.metadata.parent_id.is_some()
        {
            let metadata = &mut self.parsed.metadata;
            let fallback = metadata
                .agent_path
                .as_deref()
                .and_then(|path| path.rsplit('/').find(|part| !part.is_empty()))
                .map(|name| name.replace('_', " "))
                .or_else(|| metadata.agent_name.clone());
            if let Some(title) = fallback.filter(|title| !title.trim().is_empty()) {
                // Keep agent_description absent so a readable parent dispatch
                // can still take precedence over this identity-only fallback.
                metadata.title = clip(&title, 160);
            }
        }
        for turn in &mut self.parsed.turns {
            if turn.status == "running" {
                turn.end_time = self.parsed.metadata.end_time.max(turn.start_time);
            }
        }
        if self.parsed.metadata.malformed_lines > 0 {
            self.parsed.warnings.push(format!(
                "Skipped {} malformed or truncated JSONL records.",
                self.parsed.metadata.malformed_lines
            ));
        }
        if self.untimestamped > 0 {
            self.parsed.warnings.push(format!("{} legacy records have no per-record timestamps; their operation durations are unknown.",self.untimestamped));
        }
        if self.oversized > 0 {
            self.parsed.warnings.push(format!("Skipped {} records exceeding the 8 MiB line limit; these may include large images or tool outputs.",self.oversized));
        }
        if self.parsed.metadata.elided_strings > 0 {
            self.parsed.warnings.push(format!("Truncated {} large JSON strings at 64 KiB while retaining their record envelopes and timestamps.",self.parsed.metadata.elided_strings));
        }
        if self.span_limit_hit {
            self.parsed.warnings.push(
                "Trace capped at 100,000 spans; metadata scan continued to the end of the file."
                    .into(),
            );
        }
        if !self.metadata_only {
            for operation in &mut self.parsed.agent_operations {
                for target in &mut operation.target_ids {
                    if let Some(id) = self.path_to_id.get(target) {
                        target.clone_from(id);
                    }
                }
                operation.target_ids.sort();
                operation.target_ids.dedup();
            }
            let turns = self.parsed.turns.clone();
            for turn in turns {
                self.add(Span {
                    track: "turns".into(),
                    name: format!("Turn {}", turn.index + 1),
                    turn_id: Some(turn.id.clone()),
                    start_time: turn.start_time,
                    end_time: turn.end_time,
                    status: turn.status.clone(),
                    source_line: turn.source_line,
                    ..Default::default()
                });
                // Union occupied intervals before complementing; overlapping code/tool events do not double-count time.
                let mut occupied: Vec<(f64, f64)> = self
                    .parsed
                    .spans
                    .iter()
                    .filter(|s| {
                        s.turn_id.as_deref() == Some(turn.id.as_str())
                            && !matches!(s.track.as_str(), "turns" | "messages" | "system")
                            && s.end_time > s.start_time
                    })
                    .map(|s| {
                        (
                            s.start_time.max(turn.start_time),
                            s.end_time.min(turn.end_time),
                        )
                    })
                    .filter(|(a, b)| b > a)
                    .collect();
                occupied.sort_by(|a, b| a.0.total_cmp(&b.0));
                let mut cursor = turn.start_time;
                for (start, end) in occupied
                    .into_iter()
                    .chain(std::iter::once((turn.end_time, turn.end_time)))
                {
                    if start - cursor >= 1.0 {
                        self.add(Span {
                            track: "inference".into(),
                            name: "Inference".into(),
                            turn_id: Some(turn.id.clone()),
                            start_time: cursor,
                            end_time: start,
                            status: "complete".into(),
                            inferred: true,
                            ..Default::default()
                        });
                    }
                    cursor = cursor.max(end);
                }
            }
            if self
                .parsed
                .spans
                .iter()
                .any(|s| s.inferred && s.track == "inference")
            {
                self.parsed.warnings.push("Inference / unobserved spans are gaps between recorded operations, not measured API request latencies; gaps can include scheduling, user input, or persistence delay.".into());
            }
            self.parsed.spans.sort_by(|a, b| {
                a.start_time
                    .total_cmp(&b.start_time)
                    .then_with(|| a.end_time.total_cmp(&b.end_time))
            });
            self.parsed.log_entries = log::derive(&self.parsed);
        }
        &self.parsed
    }
}

#[wasm_bindgen]
pub fn parse_session(text: &str) -> String {
    let mut parser = Engine::new(false);
    parser.push(text);
    serde_json::to_string(parser.finish()).unwrap()
}
#[wasm_bindgen]
pub fn scan_metadata(text: &str) -> String {
    let mut parser = Engine::new(true);
    parser.push(text);
    serde_json::to_string(&parser.finish().metadata).unwrap()
}

#[wasm_bindgen]
pub fn analyze_sessions(
    json: &str,
    root_id: &str,
    start: f64,
    end: f64,
) -> Result<String, ParserError> {
    let sessions: Vec<ParsedSession> =
        serde_json::from_str(json).map_err(|e| parser_error(&e.to_string()))?;
    if !start.is_finite() || !end.is_finite() || end < start {
        return Err(parser_error("Invalid analysis time range"));
    }
    Ok(serde_json::to_string(&analysis::analyze(&sessions, root_id, start, end)).unwrap())
}

#[wasm_bindgen]
pub fn aggregate_spans(json: &str) -> Result<String, ParserError> {
    let spans: Vec<Span> = serde_json::from_str(json).map_err(|e| parser_error(&e.to_string()))?;
    Ok(serde_json::to_string(&analysis::aggregate(&spans)).unwrap())
}

#[wasm_bindgen]
pub struct MetadataScanner {
    parser: Engine,
}
#[wasm_bindgen]
impl MetadataScanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            parser: Engine::new(true),
        }
    }
    pub fn push(&mut self, chunk: &str) {
        self.parser.push(chunk);
    }
    pub fn finish(&mut self) -> String {
        serde_json::to_string(&self.parser.finish().metadata).unwrap()
    }
}
impl Default for MetadataScanner {
    fn default() -> Self {
        Self::new()
    }
}
#[wasm_bindgen]
pub struct SessionParser {
    parser: Engine,
}
#[wasm_bindgen]
impl SessionParser {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            parser: Engine::new(false),
        }
    }
    pub fn push(&mut self, chunk: &str) {
        self.parser.push(chunk);
    }
    pub fn finish(&mut self) -> String {
        serde_json::to_string(self.parser.finish()).unwrap()
    }
}
impl Default for SessionParser {
    fn default() -> Self {
        Self::new()
    }
}
