mod chat_completions;
mod messages;
mod responses;

use serde_json::Value;

use crate::{ChatRequest, ChatResponse, ErrorKind, LlmError, Protocol, ProviderConfig};

pub(crate) fn build_body(
    config: &ProviderConfig,
    request: &ChatRequest,
) -> Result<Value, LlmError> {
    validate_request(config, request)?;
    match config.protocol {
        Protocol::ChatCompletions => chat_completions::build(request, config),
        Protocol::Responses => responses::build(request, config),
        Protocol::Messages => messages::build(request, config),
    }
}

pub(crate) fn parse_response(
    protocol: Protocol,
    value: Value,
) -> Result<ChatResponse, LlmError> {
    match protocol {
        Protocol::ChatCompletions => chat_completions::parse(value),
        Protocol::Responses => responses::parse(value),
        Protocol::Messages => messages::parse(value),
    }
}

fn validate_request(config: &ProviderConfig, request: &ChatRequest) -> Result<(), LlmError> {
    let invalid = |message: &str| LlmError::new(ErrorKind::InvalidRequest, message);
    if request.response_format == crate::ResponseFormat::JsonObject
        && !request.messages.iter().any(|message| match message {
            crate::Message::System { content } | crate::Message::User { content } => {
                content.to_ascii_lowercase().contains("json")
            }
            _ => false,
        })
    {
        return Err(invalid("JSON mode requires a system or user message containing 'json'"));
    }
    if request.tools.iter().any(|tool| tool.strict)
        && request.tools.iter().any(|tool| !tool.strict)
    {
        return Err(invalid("strict and non-strict tools cannot be mixed"));
    }
    if config.protocol == Protocol::ChatCompletions
        && request.messages.iter().any(|message| match message {
            crate::Message::Assistant {
                tool_calls,
                native,
                ..
            } => {
                !tool_calls.is_empty()
                    && native
                        .as_ref()
                        .is_none_or(|native| native.protocol != Protocol::ChatCompletions)
            }
            _ => false,
        })
    {
        return Err(invalid(
            "Chat Completions cannot insert client-made tool calls",
        ));
    }
    if config.protocol == Protocol::Messages {
        let mut non_system_seen = false;
        for message in &request.messages {
            if matches!(message, crate::Message::System { .. }) {
                if non_system_seen {
                    return Err(invalid(
                        "Messages protocol does not support System messages after conversation start",
                    ));
                }
            } else {
                non_system_seen = true;
            }
        }
    }
    let mut answered_ids = std::collections::HashSet::new();
    for message in &request.messages {
        match message {
            crate::Message::Assistant { tool_calls, .. } => {
                answered_ids.extend(tool_calls.iter().map(|call| call.id.as_str()));
            }
            crate::Message::Tool { tool_call_id, .. }
                if !answered_ids.contains(tool_call_id.as_str()) =>
            {
                return Err(invalid("Tool message does not answer an earlier tool call"));
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::{
        ChatRequest, Effort, ErrorKind, Message, Native, Protocol, ProviderConfig, ResponseFormat,
        Thinking, ToolCall, ToolChoice, ToolSpec,
    };

    use super::{build_body, parse_response};

    fn config(protocol: Protocol) -> ProviderConfig {
        ProviderConfig {
            protocol,
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            api_key: Some("test-key".into()),
            api_key_env: None,
            timeout_secs: 20,
            path: None,
        }
    }

    fn tool(strict: bool) -> ToolSpec {
        ToolSpec {
            name: "get_weather".into(),
            description: "Get weather".into(),
            parameters: json!({"type":"object","properties":{"location":{"type":"string"}}}),
            strict,
        }
    }

    #[test]
    fn chat_completions_builds_tools_thinking_json_and_preserves_reasoning() {
        let request = ChatRequest {
            messages: vec![
                Message::System {
                    content: "Use json when asked.".into(),
                },
                Message::Assistant {
                    content: "Checking.".into(),
                    reasoning: Some("think".into()),
                    tool_calls: vec![],
                    native: None,
                },
                Message::Assistant {
                    content: "Reasoning not returned.".into(),
                    reasoning: None,
                    tool_calls: vec![],
                    native: None,
                },
                Message::Assistant {
                    content: String::new(),
                    reasoning: Some("call".into()),
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: "get_weather".into(),
                        arguments: "{\"location\":\"Paris\"}".into(),
                    }],
                    native: Some(Native {
                        protocol: Protocol::ChatCompletions,
                        value: json!({
                            "role":"assistant",
                            "content":"",
                            "reasoning_content":"call",
                            "tool_calls":[{"id":"call-1","type":"function","function":{"name":"get_weather","arguments":"{\"location\":\"Paris\"}"}}]
                        }),
                    }),
                },
                Message::Tool {
                    tool_call_id: "call-1".into(),
                    content: "sunny".into(),
                },
            ],
            tools: vec![tool(true)],
            tool_choice: Some(ToolChoice::Function("get_weather".into())),
            thinking: Thinking::Enabled {
                effort: Effort::High,
                budget_tokens: Some(100),
            },
            response_format: ResponseFormat::JsonObject,
            max_tokens: Some(300),
        };
        let body = build_body(&config(Protocol::ChatCompletions), &request).unwrap();
        assert_eq!(body["messages"][1]["reasoning_content"], "think");
        assert_eq!(body["messages"][2]["reasoning_content"], "");
        assert_eq!(body["messages"][3]["reasoning_content"], "call");
        assert!(body["messages"][4].get("reasoning_content").is_none());
        assert_eq!(body["messages"][3]["tool_calls"][0]["id"], "call-1");
        assert_eq!(body["tools"][0]["function"]["strict"], true);
        assert_eq!(
            body["tool_choice"],
            json!({"type":"function","function":{"name":"get_weather"}})
        );
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["max_tokens"], 300);
        assert_eq!(body["stream"], false);
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn chat_reasoning_content_is_stripped_without_tools_and_client_calls_are_rejected() {
        let request = ChatRequest {
            messages: vec![Message::Assistant {
                content: "hello".into(),
                reasoning: Some("hidden".into()),
                tool_calls: vec![],
                native: Some(Native {
                    protocol: Protocol::ChatCompletions,
                    value: json!({"role":"assistant","content":"hello","reasoning_content":"hidden"}),
                }),
            }],
            ..ChatRequest::default()
        };
        let body = build_body(&config(Protocol::ChatCompletions), &request).unwrap();
        assert!(body["messages"][0].get("reasoning_content").is_none());

        let request = ChatRequest {
            messages: vec![Message::Assistant {
                content: String::new(),
                reasoning: None,
                tool_calls: vec![ToolCall {
                    id: "client".into(),
                    name: "local".into(),
                    arguments: "{}".into(),
                }],
                native: None,
            }],
            ..ChatRequest::default()
        };
        assert_eq!(
            build_body(&config(Protocol::ChatCompletions), &request)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidRequest
        );
    }

    #[test]
    fn responses_builds_leading_instructions_and_later_system_items() {
        let request = ChatRequest {
            messages: vec![
                Message::System {
                    content: "One".into(),
                },
                Message::System {
                    content: "Two".into(),
                },
                Message::User {
                    content: "Hi, return json".into(),
                },
                Message::System {
                    content: "Later".into(),
                },
            ],
            tools: vec![tool(true)],
            tool_choice: Some(ToolChoice::Required),
            thinking: Thinking::Disabled,
            response_format: ResponseFormat::JsonObject,
            max_tokens: Some(70),
        };
        let body = build_body(&config(Protocol::Responses), &request).unwrap();
        assert_eq!(body["instructions"], "One\n\nTwo");
        assert_eq!(
            body["input"][0],
            json!({"role":"user","content":"Hi, return json"})
        );
        assert_eq!(
            body["input"][1],
            json!({"role":"system","content":"Later"})
        );
        assert_eq!(body["tools"][0]["strict"], true);
        assert_eq!(body["tool_choice"], "required");
        assert_eq!(body["reasoning"]["effort"], "none");
        assert_eq!(body["text"]["format"]["type"], "json_object");
        assert_eq!(body["max_output_tokens"], 70);
    }

    #[test]
    fn messages_merges_tool_results_and_maps_thinking_limits() {
        let request = ChatRequest {
            messages: vec![
                Message::System {
                    content: "System one".into(),
                },
                Message::System {
                    content: "System two".into(),
                },
                Message::Assistant {
                    content: String::new(),
                    reasoning: Some("thinking".into()),
                    tool_calls: vec![
                        ToolCall {
                            id: "one".into(),
                            name: "a".into(),
                            arguments: "{}".into(),
                        },
                        ToolCall {
                            id: "two".into(),
                            name: "b".into(),
                            arguments: String::new(),
                        },
                    ],
                    native: None,
                },
                Message::Tool {
                    tool_call_id: "one".into(),
                    content: "one result".into(),
                },
                Message::Tool {
                    tool_call_id: "two".into(),
                    content: "two result".into(),
                },
                Message::User {
                    content: "Return json.".into(),
                },
            ],
            tools: vec![tool(false)],
            tool_choice: Some(ToolChoice::Auto),
            thinking: Thinking::Enabled {
                effort: Effort::High,
                budget_tokens: None,
            },
            response_format: ResponseFormat::JsonObject,
            max_tokens: None,
        };
        let body = build_body(&config(Protocol::Messages), &request).unwrap();
        assert_eq!(body["system"], "System one\n\nSystem two");
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_use");
        assert_eq!(body["messages"][0]["content"][1]["input"], json!({}));
        assert_eq!(body["messages"][1]["content"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][1]["content"][1]["tool_use_id"], "two");
        assert_eq!(body["tools"][0]["input_schema"], tool(false).parameters);
        assert_eq!(body["tool_choice"]["type"], "auto");
        assert_eq!(body["thinking"]["budget_tokens"], 4096);
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["max_tokens"], 8192);
        assert!(body.get("text").is_none());

        let mut too_small = request;
        too_small.max_tokens = Some(4096);
        assert_eq!(
            build_body(&config(Protocol::Messages), &too_small)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidRequest
        );
    }

    #[test]
    fn request_validation_rejects_invalid_json_strict_mix_and_tool_replies() {
        let mut request = ChatRequest {
            messages: vec![Message::User {
                content: "answer now".into(),
            }],
            response_format: ResponseFormat::JsonObject,
            ..ChatRequest::default()
        };
        assert_eq!(
            build_body(&config(Protocol::Responses), &request)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidRequest
        );
        request.messages[0] = Message::User {
            content: "json answer now".into(),
        };
        request.tools = vec![tool(true), tool(false)];
        assert_eq!(
            build_body(&config(Protocol::Responses), &request)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidRequest
        );
        request.tools.clear();
        request.messages.push(Message::Tool {
            tool_call_id: "missing".into(),
            content: "result".into(),
        });
        assert_eq!(
            build_body(&config(Protocol::Responses), &request)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidRequest
        );
    }

    #[test]
    fn messages_rejects_late_system_and_path_override_is_used() {
        let request = ChatRequest {
            messages: vec![
                Message::User {
                    content: "hello".into(),
                },
                Message::System {
                    content: "late".into(),
                },
            ],
            ..ChatRequest::default()
        };
        assert_eq!(
            build_body(&config(Protocol::Messages), &request)
                .unwrap_err()
                .kind,
            ErrorKind::InvalidRequest
        );
        let mut provider = config(Protocol::Messages);
        provider.path = Some("/v1/messages".into());
        assert_eq!(
            format!(
                "{}{}",
                provider.base_url.trim_end_matches('/'),
                provider.endpoint_path()
            ),
            "https://api.deepseek.com/v1/messages"
        );
    }

    #[test]
    fn parses_protocol_fixtures_and_response_errors() {
        let chat = parse_response(
            Protocol::ChatCompletions,
            json!({
                "choices":[{"message":{
                    "role":"assistant",
                    "content":"I'll check today's date.",
                    "reasoning_content":"Need use the date tool.",
                    "tool_calls":[{"id":"date","type":"function","function":{"name":"get_date","arguments":"{}"}}]
                },"finish_reason":"tool_calls"}],
                "usage":{"prompt_tokens":338,"completion_tokens":104,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":69}}
            }),
        )
        .unwrap();
        assert_eq!(chat.content, "I'll check today's date.");
        assert_eq!(chat.reasoning.as_deref(), Some("Need use the date tool."));
        assert_eq!(chat.tool_calls[0].name, "get_date");
        assert_eq!(chat.usage.as_ref().unwrap().reasoning_tokens, Some(69));
        assert_eq!(chat.native.value["role"], "assistant");

        let responses = parse_response(
            Protocol::Responses,
            json!({
                "status":"completed",
                "output":[{"type":"function_call","call_id":"weather","name":"get_weather","arguments":"{\"location\":\"Hangzhou\"}"}],
                "usage":{"input_tokens":295,"input_tokens_details":{"cached_tokens":128},"output_tokens":41,"output_tokens_details":{"reasoning_tokens":0}}
            }),
        )
        .unwrap();
        assert_eq!(responses.tool_calls[0].id, "weather");
        assert_eq!(responses.finish_reason, crate::FinishReason::ToolCalls);
        assert_eq!(responses.usage.as_ref().unwrap().cached_tokens, Some(128));
        assert_eq!(responses.native.value[0]["type"], "function_call");
        assert_eq!(
            parse_response(
                Protocol::Responses,
                json!({"status":"in_progress","output":[]})
            )
            .unwrap_err()
            .kind,
            ErrorKind::Incomplete
        );

        let messages = parse_response(
            Protocol::Messages,
            json!({
                "type":"message",
                "content":[
                    {"type":"thinking","thinking":"Use the weather tool."},
                    {"type":"tool_use","id":"weather","name":"get_weather","input":{"location":"Hangzhou"}}
                ],
                "stop_reason":"tool_use",
                "usage":{"input_tokens":167,"cache_read_input_tokens":128,"output_tokens":56}
            }),
        )
        .unwrap();
        assert_eq!(messages.reasoning.as_deref(), Some("Use the weather tool."));
        assert_eq!(
            serde_json::from_str::<Value>(&messages.tool_calls[0].arguments).unwrap()["location"],
            "Hangzhou"
        );
        assert_eq!(messages.usage.as_ref().unwrap().cached_tokens, Some(128));
        assert_eq!(messages.native.value[0]["type"], "thinking");
    }

    #[test]
    fn parses_all_prompt_review_response_shapes() {
        let responses = [
            (
                Protocol::ChatCompletions,
                json!({"choices":[{"message":{"content":"answer"}}]}),
            ),
            (
                Protocol::Responses,
                json!({"status":"completed","output_text":"answer"}),
            ),
            (
                Protocol::Responses,
                json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}]}),
            ),
            (
                Protocol::Messages,
                json!({"content":[{"type":"text","text":"answer"}]}),
            ),
        ];
        for (protocol, value) in responses {
            assert_eq!(parse_response(protocol, value).unwrap().content, "answer");
        }

        for (protocol, value) in [
            (Protocol::ChatCompletions, json!({})),
            (Protocol::Responses, json!({})),
            (
                Protocol::Responses,
                json!({"status":"incomplete","output_text":"answer"}),
            ),
            (
                Protocol::Responses,
                json!({"content":[],"output":[],"status":"completed","choices":[]}),
            ),
            (Protocol::Messages, json!({})),
        ] {
            assert!(parse_response(protocol, value).is_err());
        }
    }

    #[test]
    fn effort_aliases_and_config_validation() {
        for (name, expected) in [
            ("minimal", Effort::Low),
            ("medium", Effort::High),
            ("xhigh", Effort::High),
            ("ultra", Effort::Max),
        ] {
            assert_eq!(serde_json::from_value::<Effort>(json!(name)).unwrap(), expected);
        }
        for (url, allowed) in [
            ("https://api.deepseek.com", true),
            ("http://localhost:8000", true),
            ("http://127.0.0.1:8000", true),
            ("http://127.255.1.2", true),
            ("http://[::1]:8000", true),
            ("http://api.deepseek.com", false),
            ("http://192.168.1.1", false),
            ("http://128.0.0.1", false),
            ("http://localhost.example.com", false),
            ("http://[::2]", false),
            ("", false),
            ("https://user:password@example.com", false),
        ] {
            let mut provider = config(Protocol::ChatCompletions);
            provider.base_url = url.into();
            assert_eq!(provider.validate().is_ok(), allowed, "{url}");
        }
        let mut provider = config(Protocol::Messages);
        provider.timeout_secs = 999;
        provider.path = Some("/v1/messages".into());
        provider.validate().unwrap();
        assert_eq!(provider.timeout_secs, 300);
        for path in ["messages", "/messages?x=1", "/../messages", "/has whitespace"] {
            provider.path = Some(path.into());
            assert!(provider.validate().is_err(), "{path}");
        }
        assert!(!format!("{provider:?}").contains("test-key"));
        assert!(!serde_json::to_string(&provider).unwrap().contains("test-key"));
        assert!(serde_json::from_value::<ProviderConfig>(json!({
            "protocol":"messages",
            "extra":true
        }))
        .is_err());
    }
}
