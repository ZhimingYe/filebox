use super::*;

#[tokio::test(start_paused = true)]
async fn idle_timer_closes_only_connections_still_in_the_pool() {
    let store = Arc::new(TunnelStore::default());
    let key = ("agent".to_string(), 9001);
    let (io, _peer) = tokio::io::duplex(1024);
    let (sender, driver) = hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(io)).await.unwrap();
    let driver = tokio::spawn(driver);
    let cancel = CancellationToken::new();
    store.put_idle(key.clone(), Connection { sender, cancel: cancel.clone() });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(29)).await;
    assert!(!cancel.is_cancelled());
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(cancel.is_cancelled());
    assert!(store.idle.lock().unwrap().is_empty());
    driver.abort();

    let (io, _peer) = tokio::io::duplex(1024);
    let (sender, driver) = hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(io)).await.unwrap();
    let driver = tokio::spawn(driver);
    let cancel = CancellationToken::new();
    store.put_idle(key.clone(), Connection { sender, cancel: cancel.clone() });
    tokio::task::yield_now().await;
    let connection = store.take_idle(&key).unwrap();
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::task::yield_now().await;
    assert!(!cancel.is_cancelled());
    drop(connection);
    driver.abort();
}
