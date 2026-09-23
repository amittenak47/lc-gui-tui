//! Adapt asynchronous response chunks to the existing bounded SSE parser.
//! Dropping an in-flight send/read closes the provider transport on Abort,
//! including providers that stop sending tokens or have not sent headers yet.
use std::{future::Future, io::{self, Cursor, Read}, time::Duration};
use anyhow::{bail, Result};
use crate::llm::coach::EventSink;

async fn wait<T>(future: impl Future<Output = reqwest::Result<T>>, events: &EventSink) -> Result<T> {
    tokio::select! {
        biased;
        _ = async {
            while !events.is_cancelled() { tokio::time::sleep(Duration::from_millis(25)).await; }
        } => bail!("the coach run was cancelled"),
        value = future => Ok(value?),
    }
}

pub(super) struct ResponseReader<'a> {
    // Drop the response before shutting down its runtime.
    response: reqwest::Response,
    chunk: Cursor<Vec<u8>>,
    events: &'a EventSink,
    runtime: tokio::runtime::Runtime,
}

impl<'a> ResponseReader<'a> {
    pub(super) fn post(url: &str, key: Option<&str>, body: &serde_json::Value, events: &'a EventSink) -> Result<Self> {
        if let Some(error) = events.cancelled_error() { return Err(error); }
        // Provider methods run in the daemon's blocking worker.
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let response = runtime.block_on(async {
            let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).build()?;
            let mut request = client.post(url).json(body);
            if let Some(key) = key { request = request.bearer_auth(key); }
            wait(request.send(), events).await
        })?;
        Ok(Self { response, chunk: Cursor::new(Vec::new()), events, runtime })
    }

    pub(super) fn status(&self) -> reqwest::StatusCode { self.response.status() }
    pub(super) fn is_stream(&self) -> bool {
        self.response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream"))
    }
}

impl Read for ResponseReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() { return Ok(0); }
        loop {
            if let Some(error) = self.events.cancelled_error() { return Err(io::Error::other(error.to_string())); }
            let n = self.chunk.read(buf)?;
            if n > 0 { return Ok(n); }
            match self.runtime.block_on(wait(self.response.chunk(), self.events)) {
                Ok(Some(bytes)) => self.chunk = Cursor::new(bytes.to_vec()),
                Ok(None) => return Ok(0),
                Err(error) => return Err(io::Error::other(error.to_string())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, sync::{atomic::Ordering, mpsc}, thread, time::Instant};

    fn stalled_provider(send_headers: bool) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let (connected, received) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut bytes = [0; 8192]; socket.read(&mut bytes).unwrap();
            if send_headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            }
            connected.send(()).unwrap();
            // No tokens and no finished response. Abort must close this socket.
            loop { match socket.read(&mut bytes) { Ok(0) => return true, Ok(_) => {}, Err(_) => return false } }
        });
        let events = EventSink::new(|_| {});
        let cancel = events.cancel_handle().unwrap();
        let worker = thread::spawn(move || {
            let mut response = ResponseReader::post(&url, None, &serde_json::json!({"stream":true}), &events)?;
            let mut bytes = [0; 1]; response.read(&mut bytes)?;
            anyhow::Ok(())
        });
        received.recv_timeout(Duration::from_secs(3)).unwrap();
        let start = Instant::now(); cancel.store(true, Ordering::Relaxed);
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("cancelled"), "{error}");
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(server.join().unwrap(), "provider connection stayed open");
    }

    #[test] fn abort_interrupts_waiting_for_headers() { stalled_provider(false); }
    #[test] fn abort_interrupts_a_stalled_token_stream() { stalled_provider(true); }
}
