use std::time::Duration;

use filebox_llm::{
    ChatRequest, Effort, LlmClient, Message, ProviderConfig, Protocol, ResponseFormat, Thinking,
    ToolChoice, ToolLoopLimits, ToolSpec,
};
use serde_json::{json, Value};

fn provider(protocol: Protocol, api_key: String) -> ProviderConfig {
    ProviderConfig {
        protocol,
        base_url: "https://api.deepseek.com".into(),
        model: "deepseek-flash".into(),
        api_key: Some(api_key),
        api_key_env: None,
        timeout_secs: 60,
        path: None,
    }
}

#[tokio::test]
#[ignore]
async fn deepseek_all_protocols_support_multiround_tools_json_and_model_listing() {
    let Ok(api_key) = std::env::var("FILEBOX_LLM_LIVE_KEY") else {
        eprintln!("FILEBOX_LLM_LIVE_KEY is unset; skipping live provider checks");
        return;
    };
    for protocol in [
        Protocol::ChatCompletions,
        Protocol::Responses,
        Protocol::Messages,
    ] {
        let mut config = provider(protocol, api_key.clone());
        config.validate().unwrap();
        let client = LlmClient::new(config);
        let tools = vec![
            ToolSpec {
                name: "get_date".into(),
                description: "Return today's date.".into(),
                parameters: json!({"type":"object","properties":{},"required":[]}),
                strict: false,
            },
            ToolSpec {
                name: "get_weather".into(),
                description: "Return the weather for a city and date.".into(),
                parameters: json!({
                    "type":"object",
                    "properties":{
                        "city":{"type":"string"},
                        "date":{"type":"string"}
                    },
                    "required":["city","date"]
                }),
                strict: false,
            },
        ];
        let outcome = client
            .run_tools(
                ChatRequest {
                    messages: vec![
                        Message::System {
                            content: "First call get_date. Then call get_weather using its result and city Hangzhou. Finally summarize both.".into(),
                        },
                        Message::User {
                            content: "Use get_date first and then get_weather.".into(),
                        },
                    ],
                    tools,
                    tool_choice: Some(ToolChoice::Auto),
                    thinking: Thinking::Enabled {
                        effort: Effort::High,
                        budget_tokens: None,
                    },
                    response_format: ResponseFormat::Text,
                    max_tokens: None,
                },
                ToolLoopLimits {
                    max_rounds: 4,
                    deadline: Duration::from_secs(180),
                },
                |call| async move {
                    match call.name.as_str() {
                        "get_date" => "2026-01-15".to_owned(),
                        "get_weather" => {
                            let args: Value = serde_json::from_str(&call.arguments)
                                .unwrap_or_else(|_| json!({}));
                            format!(
                                "Sunny in {} on {}",
                                args["city"].as_str().unwrap_or("Hangzhou"),
                                args["date"].as_str().unwrap_or("2026-01-15")
                            )
                        }
                        _ => "unknown tool".to_owned(),
                    }
                },
            )
            .await
            .unwrap_or_else(|error| panic!("{protocol:?} multi-round tool test failed: {error}"));
        assert!(outcome.rounds >= 2, "{protocol:?} did not use two tool rounds");
        assert!(
            !outcome.response.content.trim().is_empty(),
            "{protocol:?} returned no final content"
        );

        let parsed: Value = client
            .chat_json(
                &ChatRequest {
                    messages: vec![
                        Message::System {
                            content: "Return valid json with one field, ok, set to true.".into(),
                        },
                        Message::User {
                            content: "Answer in json.".into(),
                        },
                    ],
                    thinking: Thinking::Disabled,
                    max_tokens: Some(64),
                    ..ChatRequest::default()
                },
                1,
            )
            .await
            .unwrap_or_else(|error| panic!("{protocol:?} JSON test failed: {error}"));
        assert_eq!(parsed["ok"], true, "{protocol:?}");
        let models = client
            .list_models()
            .await
            .unwrap_or_else(|error| panic!("{protocol:?} model listing failed: {error}"));
        assert!(models.iter().any(|model| model == "deepseek-flash"));
        eprintln!("{protocol:?}: tool loop, chat_json, and list_models passed");
    }
}
