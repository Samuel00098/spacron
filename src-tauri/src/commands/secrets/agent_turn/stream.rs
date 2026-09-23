//! Streamed agent turns.
//!
//! A streamed reply is a DISPLAY channel only. Text deltas go to the UI as
//! they arrive, and the events are folded back into exactly the JSON payload
//! the same request would have returned unstreamed, so `parse_response`, the
//! native tool loop and every recovery gate downstream see no difference.
//! Anything the fold gets wrong breaks tool calling for every provider, which
//! is why each dialect has a fixture test below.
use serde_json::{json, Map, Value};

/// Server-sent events: split on blank lines, join each event's `data:` lines.
#[derive(Default)]
pub(super) struct SseParser {
    buffer: String,
}

impl SseParser {
    /// Feed raw bytes; returns the `data` payload of every event completed by them.
    pub(super) fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        while let Some(end) = self.buffer.find("\n\n") {
            let raw: String = self.buffer.drain(..end + 2).collect();
            let data = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|line| line.strip_prefix(' ').unwrap_or(line))
                .collect::<Vec<_>>()
                .join("\n");
            if !data.is_empty() { events.push(data); }
        }
        events
    }

    /// A final event the provider did not terminate with a blank line.
    pub(super) fn finish(&mut self) -> Vec<String> {
        if self.buffer.trim().is_empty() { return Vec::new(); }
        self.push("\n\n")
    }
}

/// Keys that repeat, whole, in every chunk that carries them. Concatenating
/// them would turn "assistant" into "assistantassistant" or corrupt an id.
const SET_ONCE: &[&str] = &["id", "type", "name", "role", "index", "format", "call_id"];

/// Fold one streamed delta object into the accumulated message.
fn merge_delta(target: &mut Map<String, Value>, delta: &Map<String, Value>) {
    for (key, value) in delta {
        if value.is_null() { continue; }
        match (target.get_mut(key), value) {
            (Some(Value::String(existing)), Value::String(more)) => {
                if SET_ONCE.contains(&key.as_str()) {
                    if existing.is_empty() { *existing = more.clone(); }
                } else {
                    existing.push_str(more);
                }
            }
            (Some(Value::Array(existing)), Value::Array(more)) => merge_indexed(existing, more),
            (Some(Value::Object(existing)), Value::Object(more)) => merge_delta(existing, more),
            (Some(_), _) if SET_ONCE.contains(&key.as_str()) => {}
            _ => { target.insert(key.clone(), value.clone()); }
        }
    }
}

/// Arrays of `{index, …}` fragments (tool calls, reasoning details) merge per
/// index; anything else is appended.
fn merge_indexed(existing: &mut Vec<Value>, more: &[Value]) {
    for item in more {
        let slot = item.get("index").and_then(Value::as_u64).and_then(|index| {
            existing.iter_mut().find(|e| e.get("index").and_then(Value::as_u64) == Some(index))
        });
        match (slot, item) {
            (Some(Value::Object(target)), Value::Object(fragment)) => merge_delta(target, fragment),
            _ => existing.push(item.clone()),
        }
    }
}

/// An error object inside a stream (providers report mid-stream failures this way).
fn stream_error(event: &Value) -> Option<String> {
    let error = event.get("error").filter(|e| !e.is_null())?;
    Some(error.to_string())
}

/// OpenAI-compatible `chat/completions` chunks → one non-streamed payload.
#[derive(Default)]
pub(super) struct OpenAiFold {
    message: Map<String, Value>,
    finish_reason: Option<String>,
    usage: Value,
}

impl OpenAiFold {
    /// Returns the visible text this event added.
    pub(super) fn push(&mut self, event: &Value) -> Result<String, String> {
        if let Some(error) = stream_error(event) { return Err(error); }
        if !event["usage"].is_null() { self.usage = event["usage"].clone(); }
        let choice = &event["choices"][0];
        if let Some(reason) = choice["finish_reason"].as_str() { self.finish_reason = Some(reason.to_string()); }
        let Some(delta) = choice["delta"].as_object() else { return Ok(String::new()) };
        merge_delta(&mut self.message, delta);
        Ok(delta.get("content").and_then(Value::as_str).unwrap_or("").to_string())
    }

    pub(super) fn finish(mut self) -> Value {
        self.message.entry("role").or_insert_with(|| json!("assistant"));
        if !self.message.contains_key("content") { self.message.insert("content".into(), Value::Null); }
        // Streaming-only bookkeeping: a replayed assistant message must look
        // like the unstreamed one, and strict providers reject unknown fields.
        if let Some(Value::Array(calls)) = self.message.get_mut("tool_calls") {
            for call in calls.iter_mut() {
                if let Some(call) = call.as_object_mut() {
                    call.remove("index");
                    call.entry("type").or_insert_with(|| json!("function"));
                }
            }
        }
        json!({
            "choices": [{"message": Value::Object(self.message), "finish_reason": self.finish_reason}],
            "usage": self.usage,
        })
    }
}

/// Anthropic Messages events → one non-streamed payload.
#[derive(Default)]
pub(super) struct AnthropicFold {
    content: Vec<Value>,
    /// `input_json_delta` fragments per block, parsed when the block stops.
    partial_json: Vec<String>,
    stop_reason: Option<String>,
    usage: Map<String, Value>,
}

impl AnthropicFold {
    pub(super) fn push(&mut self, event: &Value) -> Result<String, String> {
        match event["type"].as_str().unwrap_or("") {
            "error" => return Err(event["error"].to_string()),
            "message_start" => {
                if let Some(usage) = event["message"]["usage"].as_object() { merge_delta(&mut self.usage, usage); }
            }
            "content_block_start" => {
                let index = event["index"].as_u64().unwrap_or(self.content.len() as u64) as usize;
                while self.content.len() <= index { self.content.push(Value::Null); self.partial_json.push(String::new()); }
                self.content[index] = event["content_block"].clone();
            }
            "content_block_delta" => {
                let index = event["index"].as_u64().unwrap_or(0) as usize;
                let delta = &event["delta"];
                let Some(block) = self.content.get_mut(index) else { return Ok(String::new()) };
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let text = delta["text"].as_str().unwrap_or("");
                        let existing = block["text"].as_str().unwrap_or("").to_string();
                        block["text"] = json!(existing + text);
                        return Ok(text.to_string());
                    }
                    "input_json_delta" => self.partial_json[index].push_str(delta["partial_json"].as_str().unwrap_or("")),
                    "thinking_delta" => {
                        let existing = block["thinking"].as_str().unwrap_or("").to_string();
                        block["thinking"] = json!(existing + delta["thinking"].as_str().unwrap_or(""));
                    }
                    "signature_delta" => block["signature"] = delta["signature"].clone(),
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = event["index"].as_u64().unwrap_or(0) as usize;
                if let (Some(block), Some(json)) = (self.content.get_mut(index), self.partial_json.get(index)) {
                    if block["type"] == "tool_use" && !json.trim().is_empty() {
                        block["input"] = serde_json::from_str(json).map_err(|_| "protocol: invalid tool arguments (possibly truncated)".to_string())?;
                    }
                }
            }
            "message_delta" => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() { self.stop_reason = Some(reason.to_string()); }
                if let Some(usage) = event["usage"].as_object() {
                    for (key, value) in usage { self.usage.insert(key.clone(), value.clone()); }
                }
            }
            _ => {}
        }
        Ok(String::new())
    }

    pub(super) fn finish(self) -> Value {
        let content: Vec<Value> = self.content.into_iter().filter(|block| !block.is_null()).collect();
        json!({"role": "assistant", "content": content, "stop_reason": self.stop_reason, "usage": Value::Object(self.usage)})
    }
}

/// Gemini `streamGenerateContent?alt=sse` chunks → one non-streamed payload.
#[derive(Default)]
pub(super) struct GoogleFold {
    parts: Vec<Value>,
    role: Option<Value>,
    finish_reason: Option<String>,
    usage: Value,
}

impl GoogleFold {
    pub(super) fn push(&mut self, event: &Value) -> Result<String, String> {
        if let Some(error) = stream_error(event) { return Err(error); }
        if !event["usageMetadata"].is_null() { self.usage = event["usageMetadata"].clone(); }
        let candidate = &event["candidates"][0];
        if let Some(reason) = candidate["finishReason"].as_str() { self.finish_reason = Some(reason.to_string()); }
        if self.role.is_none() && !candidate["content"]["role"].is_null() { self.role = Some(candidate["content"]["role"].clone()); }
        let mut visible = String::new();
        for part in candidate["content"]["parts"].as_array().into_iter().flatten() {
            let is_text = part.get("text").is_some() && part.get("functionCall").is_none();
            let thought = part["thought"].as_bool().unwrap_or(false);
            if is_text && !thought { visible.push_str(part["text"].as_str().unwrap_or("")); }
            // Adjacent text of the same kind is one part unstreamed; keep it
            // one part so a replayed history matches what Gemini produced.
            if let Some(last) = self.parts.last_mut() {
                let last_is_text = last.get("text").is_some() && last.get("functionCall").is_none();
                if is_text && last_is_text && last["thought"].as_bool().unwrap_or(false) == thought && last.get("thoughtSignature").is_none() {
                    let text = last["text"].as_str().unwrap_or("").to_string() + part["text"].as_str().unwrap_or("");
                    last["text"] = json!(text);
                    if let Some(signature) = part.get("thoughtSignature") { last["thoughtSignature"] = signature.clone(); }
                    continue;
                }
            }
            self.parts.push(part.clone());
        }
        Ok(visible)
    }

    pub(super) fn finish(self) -> Value {
        json!({
            "candidates": [{
                "content": {"role": self.role.unwrap_or_else(|| json!("model")), "parts": self.parts},
                "finishReason": self.finish_reason,
            }],
            "usageMetadata": self.usage,
        })
    }
}

/// One fold per wire dialect, chosen by provider.
pub(super) enum Fold {
    OpenAi(OpenAiFold),
    Anthropic(AnthropicFold),
    Google(GoogleFold),
}

impl Fold {
    pub(super) fn for_provider(provider: &str) -> Self {
        match provider {
            "anthropic" => Fold::Anthropic(AnthropicFold::default()),
            "google" => Fold::Google(GoogleFold::default()),
            _ => Fold::OpenAi(OpenAiFold::default()),
        }
    }

    /// Fold one event's `data`; returns the visible text it added.
    pub(super) fn push(&mut self, data: &str) -> Result<String, String> {
        if data.trim() == "[DONE]" { return Ok(String::new()); }
        // Keep-alive comments and non-JSON noise are not part of the reply.
        let Ok(event) = serde_json::from_str::<Value>(data) else { return Ok(String::new()) };
        match self {
            Fold::OpenAi(fold) => fold.push(&event),
            Fold::Anthropic(fold) => fold.push(&event),
            Fold::Google(fold) => fold.push(&event),
        }
    }

    pub(super) fn finish(self) -> Value {
        match self {
            Fold::OpenAi(fold) => fold.finish(),
            Fold::Anthropic(fold) => fold.finish(),
            Fold::Google(fold) => fold.finish(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold_all(provider: &str, sse: &str) -> (Value, String) {
        let mut parser = SseParser::default();
        let mut fold = Fold::for_provider(provider);
        let mut visible = String::new();
        // Split mid-event on purpose: network chunks never align with events.
        let (a, b) = sse.split_at(sse.len() / 2);
        for chunk in [a, b] {
            for data in parser.push(chunk) { visible.push_str(&fold.push(&data).unwrap()); }
        }
        for data in parser.finish() { visible.push_str(&fold.push(&data).unwrap()); }
        (fold.finish(), visible)
    }

    #[test]
    fn sse_parser_handles_split_chunks_and_crlf() {
        let mut parser = SseParser::default();
        assert!(parser.push("event: x\r\ndata: {\"a\"").is_empty());
        assert_eq!(parser.push(":1}\r\n\r\ndata: [DONE]\n\n"), vec!["{\"a\":1}", "[DONE]"]);
        assert_eq!(parser.push("data: tail"), Vec::<String>::new());
        assert_eq!(parser.finish(), vec!["tail"]);
    }

    #[test]
    fn openai_stream_folds_text_reasoning_and_tool_calls() {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"think \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"more\",\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"total_tokens\":9}}\n\n",
            "data: [DONE]\n\n",
        );
        let (payload, visible) = fold_all("kilocode", sse);
        assert_eq!(visible, "Hello");
        let message = &payload["choices"][0]["message"];
        assert_eq!(message["role"], "assistant");
        assert_eq!(message["content"], "Hello");
        assert_eq!(message["reasoning_content"], "think more");
        assert_eq!(message["tool_calls"][0]["id"], "call_1");
        assert_eq!(message["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(message["tool_calls"][0]["function"]["arguments"], "{\"path\":\"a\"}");
        assert!(message["tool_calls"][0].get("index").is_none());
        assert_eq!(payload["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(payload["usage"]["total_tokens"], 9);
        let parsed = super::super::parse_response("kilocode", payload).unwrap();
        assert_eq!(parsed.calls[0].args["path"], "a");
    }

    #[test]
    fn openai_stream_merges_reasoning_details_by_index() {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"reasoning.text\",\"index\":0,\"text\":\"a\"}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"reasoning.text\",\"index\":0,\"text\":\"b\",\"signature\":\"sig\"}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"reply\\\":\\\"hi\\\"}\"},\"finish_reason\":\"stop\"}]}\n\n",
        );
        let (payload, _) = fold_all("openrouter", sse);
        let details = &payload["choices"][0]["message"]["reasoning_details"];
        assert_eq!(details.as_array().unwrap().len(), 1);
        assert_eq!(details[0]["text"], "ab");
        assert_eq!(details[0]["signature"], "sig");
    }

    #[test]
    fn openai_stream_error_is_reported() {
        let mut fold = Fold::for_provider("openai");
        assert!(fold.push("{\"error\":{\"message\":\"overloaded\"}}").is_err());
    }

    #[test]
    fn anthropic_stream_folds_thinking_text_and_tool_use() {
        let sse = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Rea\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"ding\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"a\\\"}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let (payload, visible) = fold_all("anthropic", sse);
        assert_eq!(visible, "Reading");
        assert_eq!(payload["content"][0]["thinking"], "hmm");
        assert_eq!(payload["content"][0]["signature"], "sig");
        assert_eq!(payload["content"][1]["text"], "Reading");
        assert_eq!(payload["content"][2]["input"]["path"], "a");
        assert_eq!(payload["stop_reason"], "tool_use");
        assert_eq!(payload["usage"]["input_tokens"], 5);
        assert_eq!(payload["usage"]["output_tokens"], 7);
        let parsed = super::super::parse_response("anthropic", payload).unwrap();
        assert_eq!(parsed.text, "Reading");
        assert_eq!(parsed.calls[0].id, "tu_1");
    }

    #[test]
    fn google_stream_folds_text_and_function_calls() {
        let sse = concat!(
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"plan\",\"thought\":true}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Hi \"}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"there\"}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"name\":\"read_file\",\"args\":{\"path\":\"a\"}},\"thoughtSignature\":\"s\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"totalTokenCount\":3}}\n\n",
        );
        let (payload, visible) = fold_all("google", sse);
        assert_eq!(visible, "Hi there");
        let parts = payload["candidates"][0]["content"]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[1]["text"], "Hi there");
        assert_eq!(parts[2]["thoughtSignature"], "s");
        let parsed = super::super::parse_response("google", payload).unwrap();
        assert_eq!(parsed.calls[0].args["path"], "a");
    }
}
