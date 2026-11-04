use serde_json::{json, Value};

use crate::{
    ChatRequest, ChatResponse, ErrorKind, FinishReason, LlmError, Message, Native, Protocol,
    Thinking, ToolCall, ToolChoice, Usage,
};

pub(super) fn build(
    request: &ChatRequest,
    config: &crate::ProviderConfig,
) -> Result<Value, LlmError> {
    let mut system = Vec::new();
    let mut messages = Vec::new();
    let mut index = 0;
    while index < request.messages.len() {
        match &request.messages[index] {
            Message::System { content } => system.push(content.as_str()),
            Message::User { content } => messages.push(json!({"role":"user","content":content})),
            Message::Assistant {
                content,
                tool_calls,
                native,
                ..
            } => {
                let blocks = if let Some(native) = native
                    .as_ref()
                    .filter(|native| native.protocol == Protocol::Messages)
                {
                    native.value.as_array().cloned().ok_or_else(|| {
                        LlmError::new(
                            ErrorKind::InvalidRequest,
                            "Messages native assistant value must be a content block array",
                        )
                    })?
                } else {
                    let mut blocks = Vec::new();
                    if !content.is_empty() {
                        blocks.push(json!({"type":"text","text":content}));
                    }
                    for call in tool_calls {
                        let input = if call.arguments.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&call.arguments).map_err(|_| {
                                LlmError::new(ErrorKind::InvalidRequest, "tool arguments must be JSON")
                            })?
                        };
                        blocks.push(json!({
                            "type":"tool_use",
                            "id":call.id,
                            "name":call.name,
                            "input":input
                        }));
                    }
                    blocks
                };
                messages.push(json!({"role":"assistant","content":blocks}));
            }
            Message::Tool { .. } => {
                let mut results = Vec::new();
                while let Some(Message::Tool {
                    tool_call_id,
                    content,
                }) = request.messages.get(index)
                {
                    results.push(json!({
                        "type":"tool_result",
                        "tool_use_id":tool_call_id,
                        "content":content
                    }));
                    index += 1;
                }
                messages.push(json!({"role":"user","content":results}));
                continue;
            }
        }
        index += 1;
    }
    let mut body = json!({
        "model":config.model,
        "messages":messages,
        "max_tokens":request.max_tokens.unwrap_or(4096)
    });
    if !system.is_empty() {
        body["system"] = json!(system.join("\n\n"));
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name":tool.name,
                        "description":tool.description,
                        "input_schema":tool.parameters
                    })
                })
                .collect(),
        );
    }
    if let Some(choice) = &request.tool_choice {
        body["tool_choice"] = match choice {
            ToolChoice::Auto => json!({"type":"auto"}),
            ToolChoice::None => json!({"type":"none"}),
            ToolChoice::Required => json!({"type":"any"}),
            ToolChoice::Function(name) => json!({"type":"tool","name":name}),
        };
    }
    match request.thinking {
        Thinking::Default => {}
        Thinking::Disabled => body["thinking"] = json!({"type":"disabled"}),
        Thinking::Enabled {
            effort,
            budget_tokens,
        } => {
            let budget = budget_tokens.unwrap_or_else(|| effort.messages_budget());
            if request.max_tokens.is_some_and(|max_tokens| max_tokens <= budget) {
                return Err(LlmError::new(
                    ErrorKind::InvalidRequest,
                    "max_tokens must exceed the thinking budget",
                ));
            }
            body["thinking"] = json!({"type":"enabled","budget_tokens":budget});
            body["output_config"] = json!({"effort":effort.as_str()});
            if request.max_tokens.is_none() {
                body["max_tokens"] = json!(4096 + budget);
            }
        }
    }
    Ok(body)
}

pub(super) fn parse(value: Value) -> Result<ChatResponse, LlmError> {
    let blocks = value["content"]
        .as_array()
        .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "missing Messages content"))?;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block["type"].as_str().unwrap_or_default() {
            "text" => content.push_str(block["text"].as_str().ok_or_else(|| {
                LlmError::new(ErrorKind::Malformed, "invalid Messages text block")
            })?),
            "thinking" => reasoning.push_str(block["thinking"].as_str().ok_or_else(|| {
                LlmError::new(ErrorKind::Malformed, "invalid Messages thinking block")
            })?),
            "tool_use" => tool_calls.push(ToolCall {
                id: block["id"]
                    .as_str()
                    .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid tool id"))?
                    .to_owned(),
                name: block["name"]
                    .as_str()
                    .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid tool name"))?
                    .to_owned(),
                arguments: serde_json::to_string(&block["input"])
                    .map_err(|_| LlmError::new(ErrorKind::Malformed, "invalid tool input"))?,
            }),
            _ => {}
        }
    }
    let finish_reason = match value["stop_reason"].as_str().unwrap_or_default() {
        "end_turn" | "stop_sequence" => FinishReason::Stop,
        "tool_use" => FinishReason::ToolCalls,
        "max_tokens" => FinishReason::Length,
        other => FinishReason::Other(other.to_owned()),
    };
    let usage_value = &value["usage"];
    let usage = usage_value.as_object().map(|_| Usage {
        input_tokens: usage_value["input_tokens"].as_u64().unwrap_or_default(),
        output_tokens: usage_value["output_tokens"].as_u64().unwrap_or_default(),
        reasoning_tokens: None,
        cached_tokens: usage_value["cache_read_input_tokens"].as_u64(),
    });
    Ok(ChatResponse {
        content,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        tool_calls,
        finish_reason,
        usage,
        native: Native {
            protocol: Protocol::Messages,
            value: Value::Array(blocks.clone()),
        },
    })
}
