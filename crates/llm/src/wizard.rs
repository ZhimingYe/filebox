use std::time::Duration;

use serde_json::json;

use crate::{
    ChatRequest, Effort, LlmClient, Message, ProviderConfig, Protocol, ResponseFormat, Thinking,
    ToolChoice, ToolLoopLimits, ToolSpec,
};

pub trait Prompter {
    fn line(&mut self, label: &str, default: Option<&str>) -> Result<String, String>;
    fn secret(&mut self, label: &str) -> Result<String, String>;
    fn yes_no(&mut self, label: &str, default: bool) -> Result<bool, String>;
    fn choose(&mut self, label: &str, options: &[String]) -> Result<usize, String>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct Preset {
    pub name: &'static str,
    pub protocol: Protocol,
    pub base_url: &'static str,
    pub path: Option<&'static str>,
    pub model: Option<&'static str>,
    pub provider_name: &'static str,
    pub api_key_env: &'static str,
}

pub fn presets() -> Vec<Preset> {
    vec![
        Preset {
            name: "DeepSeek Chat Completions",
            protocol: Protocol::ChatCompletions,
            base_url: "https://api.deepseek.com",
            path: None,
            model: Some("deepseek-flash"),
            provider_name: "deepseek",
            api_key_env: "DEEPSEEK_API_KEY",
        },
        Preset {
            name: "DeepSeek Responses",
            protocol: Protocol::Responses,
            base_url: "https://api.deepseek.com",
            path: None,
            model: Some("deepseek-flash"),
            provider_name: "deepseek",
            api_key_env: "DEEPSEEK_API_KEY",
        },
        Preset {
            name: "DeepSeek Anthropic Messages",
            protocol: Protocol::Messages,
            base_url: "https://api.deepseek.com",
            path: None,
            model: Some("deepseek-flash"),
            provider_name: "deepseek",
            api_key_env: "DEEPSEEK_API_KEY",
        },
        Preset {
            name: "OpenAI Chat Completions",
            protocol: Protocol::ChatCompletions,
            base_url: "https://api.openai.com/v1",
            path: None,
            model: None,
            provider_name: "openai",
            api_key_env: "OPENAI_API_KEY",
        },
        Preset {
            name: "Anthropic Messages",
            protocol: Protocol::Messages,
            base_url: "https://api.anthropic.com",
            path: Some("/v1/messages"),
            model: None,
            provider_name: "anthropic",
            api_key_env: "ANTHROPIC_API_KEY",
        },
        Preset {
            name: "Custom",
            protocol: Protocol::ChatCompletions,
            base_url: "",
            path: None,
            model: None,
            provider_name: "custom",
            api_key_env: "LLM_API_KEY",
        },
    ]
}

#[derive(Clone, Debug)]
pub struct ProbeReport {
    pub chat: Result<(), String>,
    pub json: Result<(), String>,
    pub tools: Result<(), String>,
}

impl ProbeReport {
    pub fn is_success(&self) -> bool {
        self.chat.is_ok() && self.json.is_ok() && self.tools.is_ok()
    }
}

#[derive(Debug)]
pub struct WizardOutcome {
    pub name: String,
    pub provider: ProviderConfig,
    pub inline_key: Option<String>,
    pub probe: ProbeReport,
}

pub async fn run(
    prompter: &mut dyn Prompter,
    existing_names: &[String],
) -> Result<WizardOutcome, String> {
    let presets = presets();
    let preset_labels: Vec<_> = presets.iter().map(|preset| preset.name.to_owned()).collect();
    let selected = prompter.choose("Provider preset", &preset_labels)?;
    let preset = presets
        .get(selected)
        .ok_or_else(|| "invalid provider preset selection".to_string())?;
    let protocol = if preset.name == "Custom" {
        let protocols = vec![
            "Chat Completions".to_owned(),
            "Responses".to_owned(),
            "Anthropic Messages".to_owned(),
        ];
        match prompter.choose("Protocol", &protocols)? {
            0 => Protocol::ChatCompletions,
            1 => Protocol::Responses,
            2 => Protocol::Messages,
            _ => return Err("invalid protocol selection".into()),
        }
    } else {
        preset.protocol
    };
    let base_url = prompter.line(
        "Base URL",
        (!preset.base_url.is_empty()).then_some(preset.base_url),
    )?;
    let path = if preset.name == "Custom" {
        let path = prompter.line("Optional endpoint path", None)?;
        (!path.trim().is_empty()).then_some(path)
    } else {
        preset.path.map(str::to_owned)
    };
    let name = prompter.line("Provider name", Some(preset.provider_name))?;
    if name.trim().is_empty() {
        return Err("provider name cannot be empty".into());
    }
    if existing_names.iter().any(|existing| existing == &name)
        && !prompter.yes_no(&format!("Overwrite provider '{name}'"), false)?
    {
        return Err("provider overwrite declined".into());
    }

    let storage = prompter.choose(
        "Store API key",
        &[
            "Environment variable (recommended)".to_owned(),
            "Inline in private config file".to_owned(),
        ],
    )?;
    let (api_key_env, api_key, inline_key) = match storage {
        0 => {
            let variable = prompter.line("API key environment variable", Some(preset.api_key_env))?;
            if variable.trim().is_empty() {
                return Err("API key environment variable cannot be empty".into());
            }
            let key = match std::env::var(&variable) {
                Ok(key) if !key.trim().is_empty() => key,
                _ => prompter.secret("API key (testing only; not saved)")?,
            };
            (Some(variable), Some(key), None)
        }
        1 => {
            let key = prompter.secret("API key")?;
            (None, Some(key.clone()), Some(key))
        }
        _ => return Err("invalid API key storage selection".into()),
    };

    let mut provider = ProviderConfig {
        protocol,
        base_url,
        model: preset.model.unwrap_or_default().to_owned(),
        api_key,
        api_key_env,
        timeout_secs: 20,
        path,
    };
    if let Err(error) = provider.validate_before_model_selection() {
        return Err(error.to_owned());
    }
    let client = LlmClient::new(provider.clone());
    let model_list = match client.list_models().await {
        Ok(models) if !models.is_empty() => models,
        Ok(_) => {
            eprintln!("The provider returned no models; enter a model manually.");
            Vec::new()
        }
        Err(error) => {
            eprintln!("Could not list models ({error}); enter a model manually.");
            Vec::new()
        }
    };
    let mut model_options = vec!["Enter model manually".to_owned()];
    model_options.extend(model_list);
    if model_options.len() > 1 {
        let selected_model = prompter.choose("Model", &model_options)?;
        if selected_model == 0 {
            provider.model = prompter.line(
                "Model",
                (!provider.model.is_empty()).then_some(provider.model.as_str()),
            )?;
        } else {
            provider.model = model_options
                .get(selected_model)
                .ok_or_else(|| "invalid model selection".to_string())?
                .clone();
        }
    } else {
        provider.model = prompter.line(
            "Model",
            (!provider.model.is_empty()).then_some(provider.model.as_str()),
        )?;
    }
    provider.validate().map_err(str::to_owned)?;
    let client = LlmClient::new(provider.clone());
    let probe = probe(&client).await;
    print_probe_report(&probe);
    if !probe.is_success() && !prompter.yes_no("Save anyway?", false)? {
        return Err("provider probes failed; configuration was not saved".into());
    }
    Ok(WizardOutcome {
        name,
        provider,
        inline_key,
        probe,
    })
}

fn print_probe_report(probe: &ProbeReport) {
    for (name, result) in [
        ("chat", &probe.chat),
        ("json", &probe.json),
        ("tools", &probe.tools),
    ] {
        match result {
            Ok(()) => eprintln!("Probe {name}: passed"),
            Err(error) => eprintln!("Probe {name}: failed ({error})"),
        }
    }
}

pub async fn probe(client: &LlmClient) -> ProbeReport {
    let chat = client
        .chat(&ChatRequest {
            messages: vec![Message::User {
                content: "Reply with OK".into(),
            }],
            thinking: Thinking::Disabled,
            max_tokens: Some(32),
            ..ChatRequest::default()
        })
        .await
        .and_then(|response| {
            if response.content.trim().is_empty() {
                Err(crate::LlmError::new(
                    crate::ErrorKind::Malformed,
                    "empty chat response",
                ))
            } else {
                Ok(())
            }
        })
        .map_err(|error| error.to_string());

    let json = client
        .chat_json::<serde_json::Value>(
            &ChatRequest {
                messages: vec![
                    Message::System {
                        content: "Reply with a json object with one boolean field named ok set to true.".into(),
                    },
                    Message::User {
                        content: "Answer in json.".into(),
                    },
                ],
                thinking: Thinking::Disabled,
                max_tokens: Some(64),
                ..ChatRequest::default()
            },
            0,
        )
        .await
        .and_then(|response| {
            if response.is_object() {
                Ok(())
            } else {
                Err(crate::LlmError::new(
                    crate::ErrorKind::Malformed,
                    "JSON probe did not return a JSON object",
                ))
            }
        })
        .map_err(|error| error.to_string());

    let request = ChatRequest {
        messages: vec![
            Message::System {
                content: "Call get_time at least once, then give a short final answer.".into(),
            },
            Message::User {
                content: "Use the get_time tool now.".into(),
            },
        ],
        tools: vec![ToolSpec {
            name: "get_time".into(),
            description: "Return the current Unix timestamp.".into(),
            parameters: json!({"type":"object","properties":{},"required":[]}),
            strict: false,
        }],
        tool_choice: Some(ToolChoice::Auto),
        thinking: Thinking::Enabled {
            effort: Effort::High,
            budget_tokens: None,
        },
        response_format: ResponseFormat::Text,
        max_tokens: None,
    };
    let tools = client
        .run_tools(
            request,
            ToolLoopLimits {
                max_rounds: 3,
                deadline: Duration::from_secs(60),
            },
            |_call| async {
                let seconds = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                seconds.to_string()
            },
        )
        .await
        .and_then(|outcome| {
            if outcome.rounds > 0 && !outcome.response.content.trim().is_empty() {
                Ok(())
            } else {
                Err(crate::LlmError::new(
                    crate::ErrorKind::Malformed,
                    "tool probe did not call the tool and return a final answer",
                ))
            }
        })
        .map_err(|error| error.to_string());
    ProbeReport { chat, json, tools }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use axum::{extract::State, routing::{get, post}, Json, Router};
    use serde_json::{json, Value};

    use super::*;

    struct ScriptedPrompter {
        choices: VecDeque<usize>,
        secrets: VecDeque<String>,
        base_url: Option<String>,
        save_anyway: bool,
        stop_at_model: bool,
        model_prompted: bool,
    }

    impl Prompter for ScriptedPrompter {
        fn line(&mut self, label: &str, default: Option<&str>) -> Result<String, String> {
            if label == "Base URL" {
                return Ok(self
                    .base_url
                    .clone()
                    .or_else(|| default.map(str::to_owned))
                    .unwrap_or_default());
            }
            if label == "Model" {
                self.model_prompted = true;
                if self.stop_at_model {
                    return Err("model prompt reached".into());
                }
                return Ok(default.unwrap_or("manual-model").to_owned());
            }
            Ok(default.unwrap_or_default().to_owned())
        }

        fn secret(&mut self, _label: &str) -> Result<String, String> {
            self.secrets
                .pop_front()
                .ok_or_else(|| "unexpected secret prompt".into())
        }

        fn yes_no(&mut self, _label: &str, default: bool) -> Result<bool, String> {
            Ok(if default { true } else { self.save_anyway })
        }

        fn choose(&mut self, _label: &str, _options: &[String]) -> Result<usize, String> {
            self.choices
                .pop_front()
                .ok_or_else(|| "unexpected choice prompt".into())
        }
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn scripted_wizard_discovers_model_and_passes_probe() {
        let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
        async fn models() -> Json<Value> {
            Json(json!({"data":[{"id":"model-a"},{"id":"model-b"}]}))
        }
        async fn chat(
            State(bodies): State<Arc<Mutex<Vec<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            let mut bodies = bodies.lock().unwrap();
            bodies.push(body.clone());
            if !body["tools"].as_array().is_none_or(|tools| tools.is_empty()) {
                if bodies.iter().filter(|body| !body["tools"].as_array().is_none_or(|tools| tools.is_empty())).count() == 1 {
                    Json(json!({"choices":[{"message":{
                        "role":"assistant",
                        "content":"",
                        "reasoning_content":"thinking",
                        "tool_calls":[{"id":"time","type":"function","function":{"name":"get_time","arguments":"{}"}}]
                    },"finish_reason":"tool_calls"}]}))
                } else {
                    Json(json!({"choices":[{"message":{"role":"assistant","content":"Current time recorded."},"finish_reason":"stop"}]}))
                }
            } else if body.get("response_format").is_some() {
                Json(json!({"choices":[{"message":{"role":"assistant","content":"{\"ok\":13}"},"finish_reason":"stop"}]}))
            } else {
                Json(json!({"choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}))
            }
        }
        let (base_url, server) = serve(
            Router::new()
                .route("/models", get(models))
                .route("/chat/completions", post(chat))
                .with_state(bodies.clone()),
        )
        .await;
        let mut prompter = ScriptedPrompter {
            choices: VecDeque::from([0, 1, 2]),
            secrets: VecDeque::from(["test-secret".to_owned()]),
            base_url: Some(base_url),
            save_anyway: false,
            stop_at_model: false,
            model_prompted: false,
        };
        let outcome = run(&mut prompter, &[]).await.unwrap();
        assert_eq!(outcome.name, "deepseek");
        assert_eq!(outcome.provider.model, "model-b");
        assert_eq!(outcome.inline_key.as_deref(), Some("test-secret"));
        assert!(outcome.probe.is_success());
        let bodies = bodies.lock().unwrap();
        let tool_body = bodies
            .iter()
            .find(|body| body["tools"].as_array().is_some_and(|tools| !tools.is_empty()))
            .unwrap();
        assert_eq!(tool_body["thinking"]["type"], "enabled");
        server.abort();
    }

    #[tokio::test]
    async fn failed_probe_and_declining_save_returns_error() {
        async fn fail() -> (axum::http::StatusCode, &'static str) {
            (axum::http::StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
        let (base_url, server) = serve(
            Router::new()
                .route("/models", get(fail))
                .route("/chat/completions", post(fail)),
        )
        .await;
        let mut prompter = ScriptedPrompter {
            choices: VecDeque::from([0, 1]),
            secrets: VecDeque::from(["test-secret".to_owned()]),
            base_url: Some(base_url),
            save_anyway: false,
            stop_at_model: false,
            model_prompted: false,
        };
        let error = run(&mut prompter, &[]).await.unwrap_err();
        assert!(error.contains("probes failed"));
        server.abort();
    }

    #[tokio::test]
    async fn openai_preset_reaches_model_prompt_before_validation_requires_model() {
        async fn models() -> Json<Value> {
            Json(json!({"data": []}))
        }
        let (base_url, server) = serve(Router::new().route("/models", get(models))).await;
        let mut prompter = ScriptedPrompter {
            choices: VecDeque::from([3, 0]),
            secrets: VecDeque::from(["test-secret".to_owned()]),
            base_url: Some(base_url),
            save_anyway: false,
            stop_at_model: true,
            model_prompted: false,
        };
        let error = run(&mut prompter, &[]).await.unwrap_err();
        assert_eq!(error, "model prompt reached");
        assert!(prompter.model_prompted);
        server.abort();
    }

    #[test]
    fn presets_include_official_anthropic_path_override() {
        let presets = presets();
        let anthropic = presets
            .iter()
            .find(|preset| preset.name == "Anthropic Messages")
            .unwrap();
        assert_eq!(anthropic.base_url, "https://api.anthropic.com");
        assert_eq!(anthropic.path, Some("/v1/messages"));
        assert_eq!(anthropic.model, None);
        assert_eq!(presets.len(), 6);
    }
}
