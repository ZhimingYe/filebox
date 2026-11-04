use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Protocol;

#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: String,
        reasoning: Option<String>,
        tool_calls: Vec<ToolCall>,
        native: Option<Native>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Native {
    pub protocol: Protocol,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub strict: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Function(String),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Thinking {
    #[default]
    Default,
    Disabled,
    Enabled {
        effort: Effort,
        budget_tokens: Option<u32>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    #[serde(alias = "minimal")]
    Low,
    #[serde(alias = "medium", alias = "xhigh")]
    High,
    #[serde(alias = "ultra")]
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::High => "high",
            Self::Max => "max",
        }
    }

    pub(crate) fn messages_budget(self) -> u32 {
        match self {
            Self::Low => 1024,
            Self::High => 4096,
            Self::Max => 16384,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ResponseFormat {
    #[default]
    Text,
    JsonObject,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRequest {
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub tool_choice: Option<ToolChoice>,
    pub thinking: Thinking,
    pub response_format: ResponseFormat,
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatResponse {
    pub content: String,
    pub reasoning: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: FinishReason,
    pub usage: Option<Usage>,
    pub native: Native,
}

impl ChatResponse {
    pub fn into_message(self) -> Message {
        Message::Assistant {
            content: self.content,
            reasoning: self.reasoning,
            tool_calls: self.tool_calls,
            native: Some(self.native),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
}
