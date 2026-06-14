use axum::extract::State;
use axum::response::sse::{Event, Sse};
use futures_util::stream::Stream;
use std::convert::Infallible;
use tokio::sync::broadcast;

use crate::state::AppState;

pub async fn sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = {
        let inner = state.inner.read().await;
        inner.sse_tx.subscribe()
    };

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(evt) => {
                    let data = serde_json::to_string(&evt.data).unwrap_or_default();
                    let event = Event::default().event(&evt.event).data(data);
                    yield Ok(event);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    )
}
