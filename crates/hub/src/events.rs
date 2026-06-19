use axum::extract::{Extension, State};
use axum::response::sse::{Event, Sse};
use futures_util::stream::Stream;
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::broadcast;

use crate::state::{AppState, AuthenticatedSession};

pub async fn sse_handler(
    State(state): State<AppState>,
    Extension(session): Extension<AuthenticatedSession>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = {
        let inner = state.inner.read().await;
        inner.sse_tx.subscribe()
    };

    let stream = async_stream::stream! {
        let mut session_check = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = session_check.tick() => {
                    if !session_still_valid(&state, &session.id).await {
                        break;
                    }
                }
                msg = rx.recv() => {
                    match msg {
                        Ok(evt) => {
                            if !session_still_valid(&state, &session.id).await {
                                break;
                            }
                            let data = serde_json::to_string(&evt.data).unwrap_or_default();
                            let event = Event::default().event(&evt.event).data(data);
                            yield Ok(event);
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            if !session_still_valid(&state, &session.id).await {
                                break;
                            }
                            tracing::warn!("SSE client lagged by {} events; requesting full sync", skipped);
                            let event = Event::default()
                                .event("sync_required")
                                .data("{}");
                            yield Ok(event);
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    };

    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    )
}

async fn session_still_valid(state: &AppState, session_id: &str) -> bool {
    let inner = state.inner.read().await;
    inner.sessions.get_session(session_id).is_some()
}
