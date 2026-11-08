use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpStream};
use tokio_tungstenite::{tungstenite::{client::IntoClientRequest, Message, protocol::WebSocketConfig}, connect_async_with_config};
use filebox_protocol::tunnel::{self, Frame};

type Error = Box<dyn std::error::Error + Send + Sync>;

pub async fn run(url: String, agent: String, ticket: String, port: u16, compression: bool) -> Result<(), Error> {
    let tcp = tokio::time::timeout(Duration::from_secs(5), dial(port)).await??;
    let mut request = url.into_client_request()?;
    request.headers_mut().insert("x-filebox-ticket", ticket.parse()?);
    request.headers_mut().insert("x-filebox-agent", agent.parse()?);
    let config = WebSocketConfig::default().max_message_size(Some(tunnel::MAX_WS_MESSAGE)).max_frame_size(Some(tunnel::MAX_WS_MESSAGE));
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(300), connect_async_with_config(request, Some(config), true)).await??;
    tokio::time::timeout(Duration::from_secs(10), socket.send(Message::Binary(tunnel::encode_ready().into()))).await??;
    let (sink, mut source) = socket.split();
    let sink = std::sync::Arc::new(tokio::sync::Mutex::new(sink));
    let (mut read, mut write) = tcp.into_split();
    let send = async {
        let mut buffer = vec![0; tunnel::MAX_DATA_CHUNK];
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        loop {
            let count = tokio::select! {
                read = read.read(&mut buffer) => read?,
                _ = heartbeat.tick() => {
                    tokio::time::timeout(Duration::from_secs(10), sink.lock().await.send(Message::Ping(Vec::new().into()))).await??;
                    continue;
                }
            };
            let frame = if count == 0 { tunnel::encode_eof() } else { tunnel::encode_data(&buffer[..count], compression)? };
            tokio::time::timeout(Duration::from_secs(10), sink.lock().await.send(Message::Binary(frame.into()))).await??;
            if count == 0 { return Ok::<_, Error>(()); }
        }
    };
    let receive = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(45), source.next()).await? {
                Some(Ok(Message::Binary(data))) => match tunnel::decode_frame(&data, compression)? {
                    (Frame::Data, bytes) => tokio::time::timeout(Duration::from_secs(10), write.write_all(&bytes)).await??,
                    (Frame::Eof, _) => { write.shutdown().await?; return Ok::<_, Error>(()); }
                    _ => return Err("Unexpected Ready".into()),
                },
                Some(Ok(Message::Ping(data))) => { tokio::time::timeout(Duration::from_secs(10), sink.lock().await.send(Message::Pong(data))).await??; }
                Some(Ok(Message::Pong(_))) => {}
                _ => return Err("Data socket closed".into()),
            }
        }
    };
    tokio::try_join!(send, receive)?;
    Ok(())
}

async fn dial(port: u16) -> std::io::Result<TcpStream> {
    match TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await {
        Ok(stream) => Ok(stream),
        Err(_) => TcpStream::connect((std::net::Ipv6Addr::LOCALHOST, port)).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn loopback_dial_prefers_ipv4_and_falls_back_to_ipv6() {
        let ipv4 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = ipv4.local_addr().unwrap().port();
        let ipv6 = tokio::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)).await.unwrap();
        let stream = dial(port).await.unwrap();
        assert_eq!(stream.peer_addr().unwrap().ip(), std::net::Ipv4Addr::LOCALHOST);
        drop(stream);
        drop(ipv4);
        let stream = dial(port).await.unwrap();
        assert_eq!(stream.peer_addr().unwrap().ip(), std::net::Ipv6Addr::LOCALHOST);
        drop(stream);
        drop(ipv6);
        assert!(dial(port).await.is_err());
    }
}
