#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ErrorKind {
    InvalidRequest,
    Timeout,
    Transport,
    Http(u16),
    TooLarge,
    Malformed,
    Incomplete,
    EmptyJson,
    ToolRounds,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LlmError {
    pub kind: ErrorKind,
    pub message: String,
}

impl LlmError {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::Timeout | ErrorKind::Transport | ErrorKind::EmptyJson
        ) || matches!(self.kind, ErrorKind::Http(429 | 500..=599))
    }
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LlmError {}
