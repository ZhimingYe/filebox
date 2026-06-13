use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use futures_util::{SinkExt, StreamExt};

use crate::state::AppState;

pub async fn ws_handler(ws: WebSocketUpgrade, State(_state): State<AppState>) -> impl axum::response::IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    tracing::info!("Agent WebSocket connected");

    while let Some(Ok(msg)) = socket.next().await {
        match msg {
            Message::Text(text) => {
                tracing::debug!("Received text: {}", text);
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            Message::Ping(data) => {
                if socket.send(Message::Pong(data)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    tracing::info!("Agent WebSocket disconnected");
}
