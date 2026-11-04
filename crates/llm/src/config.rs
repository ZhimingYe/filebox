use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    ChatCompletions,
    Responses,
    Messages,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat_completions",
            Self::Responses => "responses",
            Self::Messages => "messages",
        }
    }

    pub fn default_path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "/chat/completions",
            Self::Responses => "/responses",
            Self::Messages => "/anthropic/v1/messages",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub protocol: Protocol,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProviderConfig { credentials: [redacted] }")
    }
}

fn default_base_url() -> String {
    "https://api.deepseek.com".into()
}

fn default_model() -> String {
    "deepseek-flash".into()
}

fn default_timeout() -> u64 {
    20
}

impl ProviderConfig {
    pub fn endpoint_path(&self) -> &str {
        self.path
            .as_deref()
            .unwrap_or_else(|| self.protocol.default_path())
    }

    pub fn endpoint_url(&self) -> String {
        format!(
            "{}{}",
            self.base_url.trim_end_matches('/'),
            self.endpoint_path()
        )
    }

    pub fn validate(&mut self) -> Result<(), &'static str> {
        self.timeout_secs = self.timeout_secs.clamp(1, 300);
        let url = reqwest::Url::parse(&self.base_url).map_err(|_| "invalid base_url")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("base_url must be an HTTP(S) URL without credentials, query or fragment");
        }
        let host = url.host_str().unwrap_or_default();
        let loopback = host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        if url.scheme() == "http" && !loopback {
            return Err("base_url requires HTTPS except for loopback hosts");
        }
        if self.model.trim().is_empty() {
            return Err("model is required");
        }
        if self.path.as_ref().is_some_and(|path| {
            !path.starts_with('/')
                || path.contains(['?', '#'])
                || path.contains("..")
                || path.chars().any(char::is_whitespace)
        }) {
            return Err("path must start with '/' and contain no query, fragment, '..' or whitespace");
        }
        if self.api_key.as_ref().is_none_or(|key| key.trim().is_empty()) {
            self.api_key = self.api_key_env.as_ref().and_then(|name| std::env::var(name).ok());
        }
        let key = self
            .api_key
            .as_ref()
            .filter(|key| !key.trim().is_empty())
            .ok_or("enabled review requires api_key or a populated api_key_env")?;
        reqwest::header::HeaderValue::from_str(key).map_err(|_| "invalid API key header")?;
        Ok(())
    }
}
