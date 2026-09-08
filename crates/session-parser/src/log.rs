//! Compact chronological projection of normalized trace evidence. Bodies stay
//! on their original spans or in lazy physical-source details.
use crate::{ParsedSession, Span};
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub span_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub role: String,
    pub title: String,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}
fn entry(span: &Span, role: &str, phase: Option<&str>, timestamp: f64) -> LogEntry {
    LogEntry {
        id: format!("log:{}:{}", span.id, phase.unwrap_or("message")),
        span_id: span.id.clone(),
        session_id: span.session_id.clone(),
        turn_id: span.turn_id.clone(),
        role: role.into(),
        title: if phase == Some("result") {
            format!("{} result", span.name)
        } else {
            span.name.clone()
        },
        timestamp,
        phase: phase.map(str::to_owned),
    }
}
pub fn derive(session: &ParsedSession) -> Vec<LogEntry> {
    let mut entries = Vec::new();
    let mut message_keys = HashSet::new();
    let mut represented_turns = HashSet::new();
    let turn_sources: HashMap<_, _> = session
        .turns
        .iter()
        .map(|turn| (turn.id.as_str(), turn))
        .collect();
    for span in &session.spans {
        let role = match span.track.as_str() {
            "turns" => continue,
            "inference"
                if span.call_id.is_some()
                    && span.output.as_ref().is_some_and(|text| !text.is_empty()) =>
            {
                "assistant"
            }
            "inference" => continue,
            "messages" if span.name == "User message" => "user",
            "messages" => "assistant",
            "agent_messages" if span.name == "Agent message received" => "agent",
            "system" | "context" => "system",
            _ => "tool",
        };
        if role == "user"
            && span
                .output
                .as_deref()
                .is_some_and(|text| crate::is_context_input(text.trim()))
        {
            continue;
        }
        if role == "tool" {
            entries.push(entry(span, role, Some("call"), span.start_time));
            if span.output.is_some() {
                entries.push(entry(span, role, Some("result"), span.end_time));
            }
            continue;
        }
        if matches!(role, "user" | "agent") {
            if let Some(turn) = span.turn_id.as_deref() {
                if turn_sources.get(turn).is_some_and(|prompt| {
                    prompt.source_line.is_some() && prompt.source_line == span.source_line
                        || span.output.as_deref()
                            == Some(crate::clip(&prompt.prompt, crate::DETAIL_LIMIT).as_str())
                }) {
                    represented_turns.insert(turn);
                }
            }
        }
        // Only exact timestamp/body duplicates are merged without a shared
        // record ID. The same text at a different time remains a separate entry.
        let mut hash = DefaultHasher::new();
        role.hash(&mut hash);
        span.turn_id.hash(&mut hash);
        span.start_time.to_bits().hash(&mut hash);
        span.output.hash(&mut hash);
        let duplicate = span.output.as_ref().is_some_and(|text| !text.is_empty())
            && !message_keys.insert(hash.finish());
        if !duplicate {
            entries.push(entry(span, role, None, span.start_time));
        }
    }
    for turn in &session.turns {
        if turn.prompt.is_empty() || represented_turns.contains(turn.id.as_str()) {
            continue;
        }
        if let Some(span) = session
            .spans
            .iter()
            .find(|span| span.track == "turns" && span.turn_id.as_deref() == Some(&turn.id))
        {
            let mut prompt = entry(span, "user", None, turn.start_time);
            prompt.title = "User message".into();
            entries.push(prompt);
        }
    }
    entries.sort_by(|a, b| {
        a.timestamp
            .total_cmp(&b.timestamp)
            .then_with(|| a.id.cmp(&b.id))
    });
    entries
}
