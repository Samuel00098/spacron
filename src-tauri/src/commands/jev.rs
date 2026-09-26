use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Jev's own service. The default, and the only one that is a real
/// probability model; any other provider is prompted to answer in its shape.
const TYPESAFE: &str = "typesafe";

/// A chat model is slower than TypeSafe's classifier, and some Jev calls run
/// before a reply. Past this the decision is dropped and the caller uses its
/// existing path, exactly as when no Jev is configured.
const CHAT_TIMEOUT: Duration = Duration::from_secs(8);

/// One bounded, optional Choice decision. The renderer never receives the key.
///
/// `provider` picks who answers: TypeSafe's Jev (the default), or any chat
/// provider Spacron knows, including custom ones, asked to return the same
/// `{probabilities, confidence}` shape.
#[tauri::command]
pub async fn jev_classify(
    state: String,
    question: String,
    labels: HashMap<String, String>,
    provider: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<Option<Value>, String> {
    if state.trim().is_empty() || question.trim().is_empty() || labels.len() < 2 || labels.len() > 255 {
        return Err("Jev needs state, a question, and 2–255 labels".to_string());
    }
    let provider = provider.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| TYPESAFE.to_string());
    if provider == TYPESAFE {
        return classify_with_typesafe(&state, &question, &labels).await;
    }
    let model = model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let Some(model) = model else {
        // A provider with no model picked is "not configured", not an error.
        return Ok(None);
    };
    classify_with_chat(&provider, &model, base_url, &state, &question, &labels).await
}

async fn classify_with_typesafe(
    state: &str,
    question: &str,
    labels: &HashMap<String, String>,
) -> Result<Option<Value>, String> {
    let Some(api_key) = super::secrets::provider_api_key_get(TYPESAFE.to_string())? else {
        return Ok(None);
    };
    let client = super::secrets::shared_http_client(Duration::from_millis(2_000))?;
    let response = client
        .post("https://api.typesafe.ai/v1/systemone")
        .bearer_auth(api_key)
        .json(&json!({
            "state": state,
            "model": "jev-latest",
            "questions": {
                "classification": {
                    "type": "choice",
                    "instructions": question,
                    "criteria": labels,
                }
            }
        }))
        .send()
        .await
        .map_err(|err| format!("Jev request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Jev returned HTTP {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|err| format!("Invalid Jev response: {err}"))?;
    let answer = body
        .get("answers")
        .and_then(|answers| answers.get("classification"))
        .ok_or_else(|| "Jev response omitted the classification".to_string())?;
    Ok(Some(answer.clone()))
}

const CHAT_SYSTEM_PROMPT: &str = "You are a classifier. Read the STATE, then judge how likely each LABEL is the \
right answer to the QUESTION, using each label's description. Reply with ONLY a JSON object, no prose and no \
code fence, of the form {\"probabilities\": {\"<label>\": <number 0-1>, ...}, \"confidence\": <number 0-1>}. \
Include every label exactly as written. Probabilities must sum to 1. Confidence is how sure you are overall; \
when the state is ambiguous or too short, spread the probabilities and give a low confidence.";

async fn classify_with_chat(
    provider: &str,
    model: &str,
    base_url: Option<String>,
    state: &str,
    question: &str,
    labels: &HashMap<String, String>,
) -> Result<Option<Value>, String> {
    let mut names: Vec<&String> = labels.keys().collect();
    names.sort();
    let label_lines: String = names
        .iter()
        .map(|name| format!("- {name}: {}\n", labels[*name]))
        .collect();
    let user_text = format!("QUESTION: {question}\n\nLABELS:\n{label_lines}\nSTATE:\n{state}");

    let call = super::secrets::ai_complete(
        CHAT_SYSTEM_PROMPT.to_string(),
        user_text,
        provider.to_string(),
        model.to_string(),
        String::new(),
        base_url,
        None,
        Some(400),
    );
    let reply = match tokio::time::timeout(CHAT_TIMEOUT, call).await {
        Ok(result) => result?,
        Err(_) => return Ok(None),
    };
    Ok(parse_chat_answer(&reply, labels))
}

/// Turn a chat model's JSON into Jev's answer shape, or `None` when it is not
/// usable. Missing labels count as 0; the rest is renormalized so small
/// rounding from the model still sums to 1.
fn parse_chat_answer(reply: &str, labels: &HashMap<String, String>) -> Option<Value> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    let parsed: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let raw = parsed.get("probabilities")?.as_object()?;

    let mut probabilities = Map::new();
    let mut total = 0.0;
    for name in labels.keys() {
        let p = raw.get(name).and_then(Value::as_f64).unwrap_or(0.0);
        if !p.is_finite() {
            return None;
        }
        let p = p.clamp(0.0, 1.0);
        total += p;
        probabilities.insert(name.clone(), json!(p));
    }
    if total <= 0.0 {
        return None;
    }
    let mut top: f64 = 0.0;
    for value in probabilities.values_mut() {
        let p = value.as_f64().unwrap_or(0.0) / total;
        top = top.max(p);
        *value = json!(p);
    }
    let confidence = parsed
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|c| c.is_finite())
        .map(|c| c.clamp(0.0, 1.0))
        .unwrap_or(top);
    Some(json!({ "type": "choice", "probabilities": probabilities, "confidence": confidence }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> HashMap<String, String> {
        [("yes", "It is"), ("no", "It is not")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn chat_answers_are_normalized_into_jev_shape() {
        let answer = parse_chat_answer(
            "Sure! {\"probabilities\": {\"yes\": 0.9, \"no\": 0.3}, \"confidence\": 0.8}",
            &labels(),
        )
        .unwrap();
        assert_eq!(answer["type"], "choice");
        let yes = answer["probabilities"]["yes"].as_f64().unwrap();
        let no = answer["probabilities"]["no"].as_f64().unwrap();
        assert!((yes + no - 1.0).abs() < 1e-9);
        assert!(yes > no);
        assert_eq!(answer["confidence"], 0.8);
    }

    #[test]
    fn missing_labels_count_as_zero_and_confidence_defaults_to_top() {
        let answer = parse_chat_answer("{\"probabilities\": {\"yes\": 1}}", &labels()).unwrap();
        assert_eq!(answer["probabilities"]["no"], 0.0);
        assert_eq!(answer["confidence"], 1.0);
    }

    #[test]
    fn unusable_replies_are_dropped() {
        assert!(parse_chat_answer("I think yes.", &labels()).is_none());
        assert!(parse_chat_answer("{\"probabilities\": {\"yes\": 0, \"no\": 0}}", &labels()).is_none());
        assert!(parse_chat_answer("{\"answer\": \"yes\"}", &labels()).is_none());
    }
}
