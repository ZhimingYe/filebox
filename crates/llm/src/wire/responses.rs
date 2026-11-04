use serde_json::{json, Value};

use crate::{
    ChatRequest, ChatResponse, ErrorKind, FinishReason, LlmError, Message, Native, Protocol,
    ResponseFormat, ToolCall, ToolChoice, Usage,
};

pub(super) fn build(
    request: &ChatRequest,
    config: &crate::ProviderConfig,
) -> Result<Value, LlmError> {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    let mut leading = true;
    for message in &request.messages {
        match message {
            Message::System { content } if leading => instructions.push(content.as_str()),
            Message::System { content } => {
                leading = false;
                input.push(json!({"role":"system","content":content}));
            }
            Message::User { content } => {
                leading = false;
                input.push(json!({"role":"user","content":content}));
            }
            Message::Assistant {
                content,
                tool_calls,
                native,
                ..
            } => {
                leading = false;
                if let Some(native) = native
                    .as_ref()
                    .filter(|native| native.protocol == Protocol::Responses)
                {
                    if let Some(items) = native.value.as_array() {
                        input.extend(items.iter().cloned());
                    } else {
                        return Err(LlmError::new(
                            ErrorKind::InvalidRequest,
                            "Responses native assistant value must be an output array",
                        ));
                    }
                } else {
                    if !content.is_empty() {
                        input.push(json!({
                            "type":"message",
                            "role":"assistant",
                            "content":[{"type":"output_text","text":content}]
                        }));
                    }
                    for call in tool_calls {
                        input.push(json!({
                            "type":"function_call",
                            "call_id":call.id,
                            "name":call.name,
                            "arguments":call.arguments
                        }));
                    }
                }
            }
            Message::Tool {
                tool_call_id,
                content,
            } => {
                leading = false;
                input.push(json!({
                    "type":"function_call_output",
                    "call_id":tool_call_id,
                    "output":content
                }));
            }
        }
    }
    let mut body = json!({
        "model":config.model,
        "input":input,
        "stream":false
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions.join("\n\n"));
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    let mut value = json!({
                        "type":"function",
                        "name":tool.name,
                        "description":tool.description,
                        "parameters":tool.parameters
                    });
                    if tool.strict {
                        value["strict"] = json!(true);
                    }
                    value
                })
                .collect(),
        );
    }
    if let Some(choice) = &request.tool_choice {
        body["tool_choice"] = match choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Function(name) => json!({"type":"function","name":name}),
        };
    }
    match request.thinking {
        crate::Thinking::Default => {}
        crate::Thinking::Disabled => body["reasoning"] = json!({"effort":"none"}),
        crate::Thinking::Enabled { effort, .. } => {
            body["reasoning"] = json!({"effort":effort.as_str()});
        }
    }
    if request.response_format == ResponseFormat::JsonObject {
        body["text"] = json!({"format":{"type":"json_object"}});
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_output_tokens"] = json!(max_tokens);
    }
    Ok(body)
}

pub(super) fn parse(value: Value) -> Result<ChatResponse, LlmError> {
    if value["status"] != "completed" {
        return Err(LlmError::new(
            ErrorKind::Incomplete,
            "Responses API response was not completed",
        ));
    }
    let output = match value["output"].as_array() {
        Some(output) => output.clone(),
        None if value["output_text"].is_string() => Vec::new(),
        None => {
            return Err(LlmError::new(
                ErrorKind::Malformed,
                "missing Responses output",
            ))
        }
    };
    let content = if let Some(text) = value["output_text"].as_str() {
        text.to_owned()
    } else {
        let mut text = String::new();
        for item in &output {
            if item["type"] == "message" {
                if let Some(blocks) = item["content"].as_array() {
                    for block in blocks {
                        if block["type"] == "output_text" {
                            text.push_str(block["text"].as_str().ok_or_else(|| {
                                LlmError::new(ErrorKind::Malformed, "invalid output text")
                            })?);
                        }
                    }
                }
            }
        }
        text
    };
    let mut reasoning = String::new();
    let mut calls = Vec::new();
    for item in &output {
        match item["type"].as_str().unwrap_or_default() {
            "reasoning" => {
                if let Some(summary) = item["summary"].as_array() {
                    for block in summary {
                        if let Some(text) = block["text"].as_str() {
                            reasoning.push_str(text);
                        }
                    }
                }
                if let Some(blocks) = item["content"].as_array() {
                    for block in blocks {
                        if let Some(text) = block["text"].as_str() {
                            reasoning.push_str(text);
                        }
                    }
                }
            }
            "function_call" => calls.push(ToolCall {
                id: item["call_id"]
                    .as_str()
                    .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid call_id"))?
                    .to_owned(),
                name: item["name"]
                    .as_str()
                    .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid tool name"))?
                    .to_owned(),
                arguments: item["arguments"]
                    .as_str()
                    .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid arguments"))?
                    .to_owned(),
            }),
            _ => {}
        }
    }
    if content.is_empty() && calls.is_empty() && value["output_text"].as_str().is_none() {
        return Err(LlmError::new(
            ErrorKind::Malformed,
            "missing Responses output text",
        ));
    }
    let usage_value = &value["usage"];
    let usage = usage_value.as_object().map(|_| Usage {
        input_tokens: usage_value["input_tokens"].as_u64().unwrap_or_default(),
        output_tokens: usage_value["output_tokens"].as_u64().unwrap_or_default(),
        reasoning_tokens: usage_value["output_tokens_details"]["reasoning_tokens"].as_u64(),
        cached_tokens: usage_value["input_tokens_details"]["cached_tokens"].as_u64(),
    });
    Ok(ChatResponse {
        content,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        finish_reason: if calls.is_empty() {
            FinishReason::Stop
        } else {
            FinishReason::ToolCalls
        },
        tool_calls: calls,
        usage,
        native: Native {
            protocol: Protocol::Responses,
            value: Value::Array(output),
        },
    })
}
