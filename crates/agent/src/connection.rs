use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::AgentConfig;

pub async fn run_connection_loop(config: &AgentConfig) {
    let ws_url = format!("{}/ws/agent", config.hub_url);
    let mut backoff_secs = 1u64;
    let max_backoff = 60u64;

    loop {
        tracing::info!("Connecting to {}", ws_url);

        match connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                tracing::info!("Connected to Hub");
                backoff_secs = 1;

                let (mut write, mut read) = ws_stream.split();

                // Send auth message
                let auth = filebox_protocol::message::AgentMessage::Auth {
                    token: config.token.clone(),
                };
                let auth_text = serde_json::to_string(&auth).unwrap();
                if write.send(Message::Text(auth_text.into())).await.is_err() {
                    tracing::warn!("Failed to send auth, reconnecting...");
                    continue;
                }

                // Message loop
                while let Some(Ok(msg)) = read.next().await {
                    match msg {
                        Message::Text(text) => {
                            tracing::debug!("Received: {}", text);
                        }
                        Message::Ping(data) => {
                            let _ = write.send(Message::Pong(data)).await;
                        }
                        Message::Close(_) => {
                            tracing::info!("Hub closed connection");
                            break;
                        }
                        _ => {}
                    }
                }

                tracing::info!("Disconnected from Hub");
            }
            Err(e) => {
                tracing::warn!("Connection failed: {}", e);
            }
        }

        tracing::info!("Reconnecting in {}s...", backoff_secs);
        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(max_backoff);
    }
}
