//! `lc serve` — a thin HTTP/WebSocket shell over the modules the CLI already
//! uses, so the whiteboard client can run on a tablet while the corpus, the
//! workspaces, and the Python test runner stay on this machine.
//!
//! Almost no business logic lives here: routes call `index`, `loader`,
//! `problem`, `generator`, and `runner` and serialize the results.
//!
//! ## Blocking work
//!
//! `rusqlite`, the Python runner, and `llm::chat_completions` are all blocking.
//! Rather than rewriting `LlmProvider` as async, every handler funnels its work
//! through [`blocking`], which runs it on `tokio`'s blocking pool.
//!
//! ## Security
//!
//! Binds `127.0.0.1` by default. `--lan` binds `0.0.0.0` and requires a pairing
//! token, generated once and shown as a QR code for the tablet to scan.

pub mod coach;
pub mod routes;
pub mod session;
pub mod viz;
pub mod ws;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use colored::Colorize;
use tower_http::cors::CorsLayer;

use crate::config::Config;
use session::SessionStore;

pub struct AppState {
    pub cfg: RwLock<Config>,
    /// `None` on a loopback-only bind, where the OS is the access control.
    pub token: Option<String>,
    pub sessions: tokio::sync::Mutex<SessionStore>,
    /// `runner` records each run to a single `last_run.json`; serialize test
    /// runs so two clients can't interleave and read each other's results.
    pub test_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn cfg_snapshot(&self) -> Config {
        self.cfg
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

pub type Shared = Arc<AppState>;

/// Entry point for the `lc serve` subcommand. Builds its own runtime, so
/// `main` stays synchronous.
pub fn run(mut cfg: Config, port: Option<u16>, lan: bool) -> Result<()> {
    let port = port.unwrap_or(cfg.serve.port);
    let token = if lan {
        Some(cfg.ensure_serve_token()?)
    } else {
        None
    };
    let host = if lan {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };

    let state = Arc::new(AppState {
        cfg: RwLock::new(cfg),
        token,
        sessions: tokio::sync::Mutex::new(SessionStore::default()),
        test_lock: tokio::sync::Mutex::new(()),
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("cannot start the tokio runtime")?;
    runtime.block_on(serve(state, SocketAddr::new(host, port), lan))
}

async fn serve(state: Shared, addr: SocketAddr, lan: bool) -> Result<()> {
    let app = router(state.clone());
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("cannot bind {addr} — is another lc serve already running?"))?;

    print_banner(&state, addr, lan);

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            eprintln!("\nshutting down");
        })
        .await
        .context("the daemon stopped unexpectedly")
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/problems", get(routes::list_problems))
        .route("/tags", get(routes::list_tags))
        .route("/random", get(routes::random_problem))
        .route("/session", get(routes::get_session))
        .route("/session/reset", post(routes::reset_session))
        .route("/session/enqueue", post(routes::enqueue_session))
        .route("/session/random", post(routes::random_session))
        .route("/config", get(routes::get_config).put(routes::put_config))
        .route("/llm/status", get(routes::llm_status))
        .route("/llm/start", post(routes::llm_start))
        .route("/llm/stop", post(routes::llm_stop))
        .route("/problems/:id", get(routes::get_problem))
        .route("/problems/:id/adjacent", get(routes::adjacent_problem))
        .route("/problems/:id/load", post(routes::load_problem))
        .route("/workspace/:id/meta", get(routes::workspace_meta))
        .route("/workspace/:id/test", post(routes::run_tests))
        .route("/workspace/:id/open", post(routes::open_workspace))
        .route("/coach/review", post(coach::review))
        .route("/coach/viz", post(viz::viz))
        .route("/coach/reveal", post(coach::reveal))
        .route("/coach/capabilities", get(coach::capabilities))
        .route("/coach/session", get(ws::session))
        .route(
            "/workspace/:id/solution",
            get(routes::get_solution).put(routes::put_solution),
        )
        .route(
            "/workspace/:id/board",
            get(routes::get_board).put(routes::put_board),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
        // /health stays unauthenticated so the client can find the daemon
        // before it has been paired.
        .route("/health", get(health))
        // Axum's default is ~2MB, which a board PNG from a vision model blows
        // through — the client saw "Failed to buffer the request body: length
        // limit exceeded" on every Share/Send with vision on. 32MB covers a
        // downscaled board image plus the saved scene with room to spare.
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Upper bound on a request body: big enough for a board PNG, small enough that
/// a stray upload cannot exhaust memory.
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

async fn health(State(state): State<Shared>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "lc",
        "version": env!("CARGO_PKG_VERSION"),
        "requires_token": state.token.is_some(),
    }))
}

/// Pairing-token check. A no-op on a loopback bind.
///
/// The token may arrive as an `X-LC-Token` header or, because the browser
/// WebSocket API cannot set headers, as a `?token=` query parameter.
async fn require_token(
    State(state): State<Shared>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let Some(expected) = state.token.as_deref() else {
        return Ok(next.run(request).await);
    };

    let from_header = request
        .headers()
        .get("x-lc-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let from_query = request.uri().query().and_then(|q| {
        q.split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| *k == "token")
            .map(|(_, v)| v.to_string())
    });

    match from_header.or(from_query) {
        Some(got) if constant_time_eq(got.as_bytes(), expected.as_bytes()) => {
            Ok(next.run(request).await)
        }
        _ => Err(AppError::status(
            StatusCode::UNAUTHORIZED,
            anyhow::anyhow!("pair first — pass the token as the X-LC-Token header or ?token="),
        )),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn print_banner(state: &AppState, addr: SocketAddr, lan: bool) {
    let cfg = state.cfg_snapshot();
    println!("{} listening on http://{addr}", "lc serve".bold());
    println!(
        "  llm modes: ambient={} review={} bridge={} viz={}",
        cfg.llm.modes.ambient,
        cfg.llm.modes.review,
        cfg.llm.modes.bridge,
        cfg.llm.modes.viz,
    );
    if !lan {
        println!(
            "  loopback only — pass {} to let the tablet connect",
            "--lan".bold()
        );
        return;
    }

    let Some(token) = state.token.as_deref() else {
        return;
    };
    let host = local_ip().unwrap_or_else(|| "<this-machine>".to_string());
    let pair_url = format!("http://{host}:{}?token={token}", addr.port());
    println!("\n  Pair the tablet with this URL:\n  {}", pair_url.bold());
    match qr_ascii(&pair_url) {
        Ok(qr) => println!("\n{qr}"),
        Err(err) => eprintln!("  (could not render the QR code: {err})"),
    }
    println!(
        "  {}",
        "anyone on this network who has the token can drive your workspaces".yellow()
    );
}

/// Best-effort LAN address: ask the OS which interface it would use to reach
/// the outside world. No packets are sent — UDP connect just picks a route.
fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

/// Render a QR as half-block characters, using only `qrcode`'s core API.
fn qr_ascii(data: &str) -> Result<String> {
    use qrcode::{Color, QrCode};

    let code = QrCode::new(data.as_bytes())?;
    let width = code.width();
    let modules = code.to_colors();
    let dark = |x: usize, y: usize| -> bool {
        // Treat the quiet zone outside the symbol as light.
        y < width && modules[y * width + x] == Color::Dark
    };

    const QUIET: usize = 2;
    let mut out = String::new();
    // Two module rows per character cell: upper half-block plus background.
    for row in (0..width + QUIET * 2).step_by(2) {
        out.push_str("  ");
        for x in 0..width + QUIET * 2 {
            let sx = x.wrapping_sub(QUIET);
            let top = x >= QUIET && sx < width && row >= QUIET && dark(sx, row - QUIET);
            let bottom =
                x >= QUIET && sx < width && (row + 1) >= QUIET && dark(sx, row + 1 - QUIET);
            out.push(match (top, bottom) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        out.push('\n');
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Any handler failure, rendered as `{"error": "..."}` with a status code.
#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    error: anyhow::Error,
}

impl AppError {
    pub fn status(status: StatusCode, error: anyhow::Error) -> Self {
        Self { status, error }
    }

    pub fn not_found(error: anyhow::Error) -> Self {
        Self::status(StatusCode::NOT_FOUND, error)
    }

    pub fn bad_request(error: anyhow::Error) -> Self {
        Self::status(StatusCode::BAD_REQUEST, error)
    }

    /// Reclassify an error without losing its context chain.
    pub fn with_status(self, status: StatusCode) -> Self {
        Self { status, ..self }
    }

    pub fn message(&self) -> String {
        format!("{:#}", self.error)
    }

    pub fn status_code(&self) -> StatusCode {
        self.status
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(error: E) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error: error.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // `{err:#}` keeps anyhow's context chain, which is where the actionable
        // half of these messages lives ("run `lc load` first", ...).
        let body = Json(serde_json::json!({"error": format!("{:#}", self.error)}));
        (self.status, body).into_response()
    }
}

/// Run blocking work (SQLite, Python, the LLM) off the async runtime.
pub async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let value = tokio::task::spawn_blocking(f)
        .await
        .context("a background task panicked")??;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_rejects_length_mismatch_and_wrong_bytes() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc", b"abc123"));
    }

    #[test]
    fn qr_renders_without_the_image_feature() {
        let qr = qr_ascii("http://192.168.1.20:7878?token=abc").unwrap();
        assert!(qr.lines().count() > 8);
        assert!(qr.contains('█') || qr.contains('▀'));
    }
}
