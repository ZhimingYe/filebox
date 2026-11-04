use std::future::Future;
use std::time::Duration;

use reqwest::header::CONTENT_TYPE;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::wire;
use crate::{
    ChatRequest, ChatResponse, ErrorKind, LlmError, Message, Protocol, ProviderConfig,
    ResponseFormat, ToolCall,
};

const DEFAULT_RESPONSE_LIMIT: usize = 1024 * 1024;

pub struct LlmClient {
    config: ProviderConfig,
    client: reqwest::Client,
    response_limit: usize,
}

pub struct ToolLoopLimits {
    pub max_rounds: u32,
    pub deadline: Duration,
}

#[derive(Debug)]
pub struct ToolLoopOutcome {
    pub response: ChatResponse,
    pub messages: Vec<Message>,
    pub rounds: u32,
}

impl LlmClient {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("LLM HTTP client"),
            response_limit: DEFAULT_RESPONSE_LIMIT,
        }
    }

    pub fn with_response_limit(mut self, bytes: usize) -> Self {
        self.response_limit = bytes;
        self
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub fn model(&self) -> &str {
        &self.config.model
    }

    pub async fn chat(&self, request: &ChatRequest) -> Result<ChatResponse, LlmError> {
        let body = wire::build_body(&self.config, request)?;
        let response = tokio::time::timeout(
            Duration::from_secs(self.config.timeout_secs.clamp(1, 300)),
            self.post_json(&self.config.endpoint_url(), &body),
        )
        .await
        .map_err(|_| LlmError::new(ErrorKind::Timeout, "LLM request timed out"))??;
        wire::parse_response(self.config.protocol, response)
    }

    pub async fn chat_json<T: DeserializeOwned>(
        &self,
        request: &ChatRequest,
        empty_retries: u8,
    ) -> Result<T, LlmError> {
        let mut request = request.clone();
        request.response_format = ResponseFormat::JsonObject;
        for attempt in 0..=empty_retries {
            let response = self.chat(&request).await?;
            if response.content.trim().is_empty() {
                if attempt == empty_retries {
                    return Err(LlmError::new(
                        ErrorKind::EmptyJson,
                        "LLM returned empty JSON content",
                    ));
                }
                continue;
            }
            return serde_json::from_str(&response.content)
                .map_err(|_| LlmError::new(ErrorKind::Malformed, "LLM returned invalid JSON"));
        }
        unreachable!("chat_json loop returns a result")
    }

    pub async fn run_tools<H, F>(
        &self,
        mut request: ChatRequest,
        limits: ToolLoopLimits,
        mut handler: H,
    ) -> Result<ToolLoopOutcome, LlmError>
    where
        H: FnMut(ToolCall) -> F,
        F: Future<Output = String>,
    {
        let deadline = async {
            let mut rounds = 0;
            loop {
                let response = self.chat(&request).await?;
                request.messages.push(response.clone().into_message());
                if response.tool_calls.is_empty() {
                    return Ok(ToolLoopOutcome {
                        response,
                        messages: request.messages,
                        rounds,
                    });
                }
                rounds += 1;
                if rounds > limits.max_rounds {
                    return Err(LlmError::new(
                        ErrorKind::ToolRounds,
                        "LLM exceeded the tool round limit",
                    ));
                }
                for call in response.tool_calls.iter().cloned() {
                    let tool_call_id = call.id.clone();
                    let content = handler(call.clone()).await;
                    request.messages.push(Message::Tool {
                        tool_call_id,
                        content,
                    });
                }
            }
        };
        tokio::time::timeout(limits.deadline, deadline)
            .await
            .map_err(|_| LlmError::new(ErrorKind::Timeout, "LLM tool loop timed out"))?
    }

    pub async fn list_models(&self) -> Result<Vec<String>, LlmError> {
        let url = if self.config.protocol == Protocol::Messages {
            let endpoint = self.config.endpoint_url();
            if let Some(prefix) = endpoint.strip_suffix("/messages") {
                format!("{prefix}/models")
            } else {
                format!(
                    "{}/models",
                    self.config.base_url.trim_end_matches('/')
                )
            }
        } else {
            format!("{}/models", self.config.base_url.trim_end_matches('/'))
        };
        let result = tokio::time::timeout(
            Duration::from_secs(self.config.timeout_secs.clamp(1, 300)),
            self.get_json(&url),
        )
        .await
        .map_err(|_| LlmError::new(ErrorKind::Timeout, "LLM request timed out"))?;
        let value = match result {
            Ok(value) => value,
            Err(first_error) if self.config.protocol == Protocol::Messages => {
                let fallback =
                    format!("{}/models", self.config.base_url.trim_end_matches('/'));
                if fallback == url {
                    return Err(first_error);
                }
                tokio::time::timeout(
                    Duration::from_secs(self.config.timeout_secs.clamp(1, 300)),
                    self.get_json(&fallback),
                )
                .await
                .map_err(|_| LlmError::new(ErrorKind::Timeout, "LLM request timed out"))??
            }
            Err(error) => return Err(error),
        };
        let models = value["data"]
            .as_array()
            .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid model list"))?;
        models
            .iter()
            .map(|model| {
                model["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| LlmError::new(ErrorKind::Malformed, "invalid model id"))
            })
            .collect()
    }

    async fn post_json(&self, url: &str, body: &Value) -> Result<Value, LlmError> {
        let mut request = self
            .client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .json(body);
        request = match self.config.protocol {
            Protocol::Messages => request
                .header(
                    "x-api-key",
                    self.config.api_key.as_deref().unwrap_or_default(),
                )
                .header("anthropic-version", "2023-06-01"),
            _ => request.bearer_auth(self.config.api_key.as_deref().unwrap_or_default()),
        };
        let response = request.send().await.map_err(transport_error)?;
        self.read_json(response).await
    }

    async fn get_json(&self, url: &str) -> Result<Value, LlmError> {
        let mut request = self.client.get(url);
        request = match self.config.protocol {
            Protocol::Messages => request
                .header(
                    "x-api-key",
                    self.config.api_key.as_deref().unwrap_or_default(),
                )
                .header("anthropic-version", "2023-06-01"),
            _ => request.bearer_auth(self.config.api_key.as_deref().unwrap_or_default()),
        };
        let response = request.send().await.map_err(transport_error)?;
        self.read_json(response).await
    }

    async fn read_json(&self, mut response: reqwest::Response) -> Result<Value, LlmError> {
        if !response.status().is_success() {
            return Err(LlmError::new(
                ErrorKind::Http(response.status().as_u16()),
                format!("LLM HTTP status {}", response.status().as_u16()),
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            if bytes.len().saturating_add(chunk.len()) > self.response_limit {
                return Err(LlmError::new(
                    ErrorKind::TooLarge,
                    "LLM response exceeded the configured size limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| LlmError::new(ErrorKind::Malformed, "LLM returned malformed JSON"))
    }
}

fn transport_error(error: reqwest::Error) -> LlmError {
    if error.is_timeout() {
        LlmError::new(ErrorKind::Timeout, "LLM request timed out")
    } else {
        LlmError::new(ErrorKind::Transport, "LLM transport failed")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    };
    use serde_json::{json, Value};

    use super::*;

    type CapturedMessageHeaders = Arc<Mutex<Option<(String, String, String)>>>;
    use crate::{Effort, Thinking, ToolChoice, ToolLoopLimits, ToolSpec};

    fn provider(protocol: Protocol, base_url: String, path: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            protocol,
            base_url,
            model: "deepseek-flash".into(),
            api_key: Some("test-secret".into()),
            api_key_env: None,
            timeout_secs: 5,
            path: path.map(str::to_owned),
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
    async fn chat_sends_auth_headers_and_uses_messages_endpoint_path() {
        let captured = Arc::new(Mutex::new(None));
        async fn messages(
            State(captured): State<CapturedMessageHeaders>,
            headers: HeaderMap,
            Json(_body): Json<Value>,
        ) -> Json<Value> {
            *captured.lock().unwrap() = Some((
                headers
                    .get("x-api-key")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .into(),
                headers
                    .get("anthropic-version")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .into(),
                headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .into(),
            ));
            Json(json!({
                "content":[{"type":"text","text":"ok"}],
                "stop_reason":"end_turn"
            }))
        }
        let app = Router::new()
            .route("/v1/messages", post(messages))
            .with_state(captured.clone());
        let (base, server) = serve(app).await;
        let client = LlmClient::new(provider(
            Protocol::Messages,
            base,
            Some("/v1/messages"),
        ));
        let result = client
            .chat(&ChatRequest {
                messages: vec![Message::User {
                    content: "hello".into(),
                }],
                ..ChatRequest::default()
            })
            .await
            .unwrap();
        assert_eq!(result.content, "ok");
        assert_eq!(
            captured.lock().unwrap().as_ref().unwrap(),
            &(
                "test-secret".into(),
                "2023-06-01".into(),
                String::new()
            )
        );
        server.abort();
    }

    #[tokio::test]
    async fn response_limit_and_redirect_policy_are_enforced() {
        async fn large() -> Json<Value> {
            Json(json!({"choices":[{"message":{"content":"x".repeat(256)}}]}))
        }
        let (base, server) = serve(Router::new().route("/chat/completions", post(large))).await;
        let client =
            LlmClient::new(provider(Protocol::ChatCompletions, base, None)).with_response_limit(32);
        let error = client
            .chat(&ChatRequest {
                messages: vec![Message::User {
                    content: "hi".into(),
                }],
                ..ChatRequest::default()
            })
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::TooLarge);
        server.abort();

        let followed = Arc::new(AtomicUsize::new(0));
        async fn redirect() -> (StatusCode, [(axum::http::header::HeaderName, &'static str); 1]) {
            (
                StatusCode::TEMPORARY_REDIRECT,
                [(axum::http::header::LOCATION, "/target")],
            )
        }
        async fn target(State(followed): State<Arc<AtomicUsize>>) -> Json<Value> {
            followed.fetch_add(1, Ordering::SeqCst);
            Json(json!({"choices":[{"message":{"content":"followed"}}]}))
        }
        let app = Router::new()
            .route("/chat/completions", post(redirect))
            .route("/target", post(target))
            .with_state(followed.clone());
        let (base, server) = serve(app).await;
        let client = LlmClient::new(provider(Protocol::ChatCompletions, base, None));
        let error = client
            .chat(&ChatRequest::default())
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Http(307));
        assert_eq!(followed.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn run_tools_preserves_reasoning_and_enforces_round_limit() {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let handler_bodies = bodies.clone();
        async fn respond(
            State(bodies): State<Arc<Mutex<Vec<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            let mut bodies = bodies.lock().unwrap();
            bodies.push(body);
            match bodies.len() {
                1 => Json(json!({"choices":[{"message":{
                    "role":"assistant",
                    "content":"",
                    "reasoning_content":"date reasoning",
                    "tool_calls":[{"id":"date-call","type":"function","function":{"name":"get_date","arguments":"{}"}}]
                },"finish_reason":"tool_calls"}]})),
                2 => Json(json!({"choices":[{"message":{
                    "role":"assistant",
                    "content":"",
                    "reasoning_content":"weather reasoning",
                    "tool_calls":[{"id":"weather-call","type":"function","function":{"name":"get_weather","arguments":"{\"date\":\"today\"}"} }]
                },"finish_reason":"tool_calls"}]})),
                _ => Json(json!({"choices":[{"message":{
                    "role":"assistant",
                    "content":"It is sunny today.",
                    "reasoning_content":"final thought"
                },"finish_reason":"stop"}]})),
            }
        }
        let (base, server) = serve(
            Router::new()
                .route("/chat/completions", post(respond))
                .with_state(handler_bodies),
        )
        .await;
        let client = LlmClient::new(provider(Protocol::ChatCompletions, base, None));
        let outcome = client
            .run_tools(
                ChatRequest {
                    messages: vec![Message::User {
                        content: "get date and weather".into(),
                    }],
                    tools: vec![
                        ToolSpec {
                            name: "get_date".into(),
                            description: "today".into(),
                            parameters: json!({"type":"object","properties":{}}),
                            strict: false,
                        },
                        ToolSpec {
                            name: "get_weather".into(),
                            description: "weather".into(),
                            parameters: json!({"type":"object","properties":{}}),
                            strict: false,
                        },
                    ],
                    tool_choice: Some(ToolChoice::Auto),
                    thinking: Thinking::Enabled {
                        effort: Effort::High,
                        budget_tokens: None,
                    },
                    ..ChatRequest::default()
                },
                ToolLoopLimits {
                    max_rounds: 3,
                    deadline: Duration::from_secs(5),
                },
                |call| async move { format!("result for {}", call.name) },
            )
            .await
            .unwrap();
        assert_eq!(outcome.rounds, 2);
        assert_eq!(outcome.response.content, "It is sunny today.");
        {
            let requests = bodies.lock().unwrap();
            assert_eq!(
                requests[1]["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|message| {
                        message["role"] == "assistant"
                            && message["reasoning_content"] == "date reasoning"
                    })
                    .unwrap()["reasoning_content"],
                "date reasoning"
            );
        }
        server.abort();

        let app = Router::new().route(
            "/chat/completions",
            post(|| async {
                Json(json!({"choices":[{"message":{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{"id":"call","type":"function","function":{"name":"get_date","arguments":"{}"}}]
                },"finish_reason":"tool_calls"}]}))
            }),
        );
        let (base, server) = serve(app).await;
        let client = LlmClient::new(provider(Protocol::ChatCompletions, base, None));
        let error = client
            .run_tools(
                ChatRequest {
                    tools: vec![ToolSpec {
                        name: "get_date".into(),
                        description: "today".into(),
                        parameters: json!({"type":"object"}),
                        strict: false,
                    }],
                    ..ChatRequest::default()
                },
                ToolLoopLimits {
                    max_rounds: 0,
                    deadline: Duration::from_secs(5),
                },
                |_| async { "today".into() },
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::ToolRounds);
        server.abort();
    }

    #[tokio::test]
    async fn chat_json_retries_whitespace_and_then_returns_empty_json() {
        let count = Arc::new(AtomicUsize::new(0));
        async fn json_response(
            State(count): State<Arc<AtomicUsize>>,
            Json(_body): Json<Value>,
        ) -> Json<Value> {
            let index = count.fetch_add(1, Ordering::SeqCst);
            let content = if index == 0 { " \n " } else { "{\"ok\":true}" };
            Json(json!({"choices":[{"message":{"role":"assistant","content":content}}]}))
        }
        let (base, server) = serve(
            Router::new()
                .route("/chat/completions", post(json_response))
                .with_state(count.clone()),
        )
        .await;
        let client = LlmClient::new(provider(Protocol::ChatCompletions, base, None));
        let parsed: Value = client
            .chat_json(
                &ChatRequest {
                    messages: vec![Message::System {
                        content: "Return json.".into(),
                    }],
                    ..ChatRequest::default()
                },
                1,
            )
            .await
            .unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        server.abort();

        let app = Router::new().route(
            "/chat/completions",
            post(|| async {
                Json(json!({"choices":[{"message":{"role":"assistant","content":" "}}]}))
            }),
        );
        let (base, server) = serve(app).await;
        let client = LlmClient::new(provider(Protocol::ChatCompletions, base, None));
        let error = client
            .chat_json::<Value>(
                &ChatRequest {
                    messages: vec![Message::User {
                        content: "json please".into(),
                    }],
                    ..ChatRequest::default()
                },
                0,
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::EmptyJson);
        server.abort();
    }

    #[tokio::test]
    async fn list_models_uses_custom_messages_path_then_fallback() {
        let hit = Arc::new(AtomicUsize::new(0));
        async fn models(State(hit): State<Arc<AtomicUsize>>) -> Json<Value> {
            hit.fetch_add(1, Ordering::SeqCst);
            Json(json!({"data":[{"id":"model-a"}]}))
        }
        let (base, server) = serve(
            Router::new()
                .route("/v1/models", axum::routing::get(models))
                .with_state(hit.clone()),
        )
        .await;
        let client = LlmClient::new(provider(
            Protocol::Messages,
            base,
            Some("/v1/messages"),
        ));
        assert_eq!(client.list_models().await.unwrap(), vec!["model-a"]);
        assert_eq!(hit.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
