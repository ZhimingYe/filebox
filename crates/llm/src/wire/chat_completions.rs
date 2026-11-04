use serde_json::{json, Map, Value};

use crate::{
    ChatRequest, ChatResponse, ErrorKind, FinishReason, LlmError, Message, Native, Protocol,
    ResponseFormat, ToolCall, ToolChoice, Usage,
};

pub(super) fn build(request: &ChatRequest, config: &crate::ProviderConfig) -> Result<Value, LlmError> {
    let has_tools = !request.tools.is_empty();
    let mut messages = Vec::with_capacity(request.messages.len());
    for message in &request.messages {
        let value = match message {
            Message::System { content } => json!({"role":"system","content":content}),
            Message::User { content } => json!({"role":"user","content":content}),
            Message::Tool {
                tool_call_id,
                content,
            } => json!({"role":"tool","tool_call_id":tool_call_id,"content":content}),
            Message::Assistant {
                content,
                reasoning,
                tool_calls,
                native,
            } => {
                if let Some(native) = native
                    .as_ref()
                    .filter(|native| native.protocol == Protocol::ChatCompletions)
                {
                    let mut message = native.value.clone();
                    if let Some(object) = message.as_object_mut() {
                        if has_tools {
                            object.insert(
                                "reasoning_content".into(),
                                json!(reasoning.as_deref().unwrap_or("")),
                            );
                        } else {
                            object.remove("reasoning_content");
                        }
                    }
                    message
                } else {
                    let mut message = json!({"role":"assistant","content":content});
                    if !tool_calls.is_empty() {
                        message["tool_calls"] = Value::Array(
                            tool_calls
                                .iter()
                                .map(|call| {
                                    json!({
                                        "id":call.id,
                                        "type":"function",
                                        "function":{"name":call.name,"arguments":call.arguments}
                                    })
                                })
                                .collect(),
                        );
                    }
                    message
                }
            }
        };
        let mut value = value;
        if let (true, Some(reasoning)) = (has_tools, value.as_object_mut()) {
            if reasoning.get("role").and_then(Value::as_str) == Some("assistant") {
                reasoning.insert(
                    "reasoning_content".into(),
                    json!(match message {
                        Message::Assistant { reasoning, .. } => reasoning.as_deref().unwrap_or(""),
                        _ => "",
                    }),
                );
            }
        }
        messages.push(value);
    }
    let mut body = json!({
        "model":config.model,
        "messages":messages,
        "stream":false
    });
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    let mut function = Map::new();
                    function.insert("name".into(), json!(tool.name));
                    function.insert("description".into(), json!(tool.description));
                    function.insert("parameters".into(), tool.parameters.clone());
                    if tool.strict {
                        function.insert("strict".into(), json!(true));
                    }
                    json!({"type":"function","function":function})
                })
                .collect(),
        );
    }
    if let Some(choice) = &request.tool_choice {
        body["tool_choice"] = match choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Function(name) => {
                json!({"type":"function","function":{"name":name}})
            }
        };
    }
    match request.thinking {
        crate::Thinking::Default => {}
        crate::Thinking::Disabled => body["thinking"] = json!({"type":"disabled"}),
        crate::Thinking::Enabled { effort, .. } => {
            body["thinking"] = json!({"type":"enabled"});
            body["reasoning_effort"] = json!(effort.as_str());
        }
    }
    if request.response_format == ResponseFormat::JsonObject {
        body["response_format"] = json!({"type":"json_object"});
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    Ok(body)
}

pub(super) fn parse(value: Value) -> Result<ChatResponse, LlmError> {
    let message = value["choices"][0]["message"]
        .as_object()
        .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "missing choices[0].message"))?;
    let content = match message.get("content") {
        Some(Value::String(content)) => content.clone(),
        Some(Value::Null) | None => String::new(),
        _ => {
            return Err(LlmError::new(
                ErrorKind::Malformed,
                "invalid Chat Completions message content",
            ))
        }
    };
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|call| {
                    Ok(ToolCall {
                        id: call["id"].as_str().ok_or_else(|| {
                            LlmError::new(ErrorKind::Malformed, "invalid tool call id")
                        })?.to_owned(),
                        name: call["function"]["name"].as_str().ok_or_else(|| {
                            LlmError::new(ErrorKind::Malformed, "invalid tool name")
                        })?.to_owned(),
                        arguments: call["function"]["arguments"]
                            .as_str()
                            .ok_or_else(|| {
                                LlmError::new(ErrorKind::Malformed, "invalid tool arguments")
                            })?
                            .to_owned(),
                    })
                })
                .collect::<Result<Vec<_>, LlmError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let finish_reason = match value["choices"][0]["finish_reason"].as_str().unwrap_or_default() {
        "stop" => FinishReason::Stop,
        "tool_calls" | "function_call" => FinishReason::ToolCalls,
        "length" => FinishReason::Length,
        "content_filter" => FinishReason::ContentFilter,
        other => FinishReason::Other(other.to_owned()),
    };
    let usage_value = &value["usage"];
    let usage = usage_value.as_object().map(|_| Usage {
        input_tokens: usage_value["prompt_tokens"].as_u64().unwrap_or_default(),
        output_tokens: usage_value["completion_tokens"].as_u64().unwrap_or_default(),
        reasoning_tokens: usage_value["completion_tokens_details"]["reasoning_tokens"].as_u64(),
        cached_tokens: usage_value["prompt_tokens_details"]["cached_tokens"].as_u64(),
    });
    let reasoning = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(ChatResponse {
        content,
        reasoning,
        tool_calls,
        finish_reason,
        usage,
        native: Native {
            protocol: Protocol::ChatCompletions,
            value: Value::Object(message.clone()),
        },
    })
}
