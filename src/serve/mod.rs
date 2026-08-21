//! In-process HTTP router for the Tauri GUI and tests.
//!
//! Almost no business logic lives here: routes call `index`, `loader`,
//! `problem`, `generator`, and `runner` and serialize the results.
//!
//! ## Blocking work
//!
//! `rusqlite`, the Python runner, and `llm::chat_completions` are all blocking.
//! Rather than rewriting `LlmProvider` as async, every handler funnels its work
//! through [`blocking`], which runs it on `tokio`'s blocking pool.

pub mod coach;
pub mod common;
pub mod routes;
pub mod board_session;
pub mod session;
pub mod viz;
pub mod ws;

use std::sync::{Arc, RwLock};

use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use tower::ServiceExt;

use crate::config::Config;
use session::SessionStore;

pub struct AppState {
    pub cfg: RwLock<Config>,
    /// `None` in the embedded GUI — loopback pairing is gone.
    pub token: Option<String>,
    pub sessions: tokio::sync::Mutex<SessionStore>,
    pub board_sessions: tokio::sync::Mutex<board_session::BoardSessionStore>,
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

/// Shared state for the embedded router — no LAN token or pair code.
pub fn new_state(cfg: Config) -> Shared {
    new_state_with_token(cfg, None)
}

/// Same router, with a pairing token — used only by the LAN pad-sync listener.
pub fn new_state_with_token(cfg: Config, token: Option<String>) -> Shared {
    Arc::new(AppState {
        cfg: RwLock::new(cfg),
        token,
        sessions: tokio::sync::Mutex::new(SessionStore::default()),
        board_sessions: tokio::sync::Mutex::new(board_session::BoardSessionStore::default()),
        test_lock: tokio::sync::Mutex::new(()),
    })
}

/// Bind the pad-sync ping (and the rest of the router) on LAN. GUI invoke stays token-free.
pub async fn listen_lan(state: Shared, port: u16) -> Result<()> {
    use tokio::net::TcpListener;
    use tower_http::cors::CorsLayer;

    let app = router(state).layer(CorsLayer::permissive());
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("cannot bind pad-sync listener on 0.0.0.0:{port}"))?;
    axum::serve(listener, app)
        .await
        .context("pad-sync listener stopped")?;
    Ok(())
}

/// Dispatch one HTTP request through the router without binding a port.
///
/// `uri` is path + query, e.g. `/problems/two-sum?dataset=leetcode`.
pub async fn dispatch(
    state: Shared,
    method: &str,
    uri: &str,
    body: Vec<u8>,
    content_type: Option<&str>,
) -> Result<(u16, Vec<u8>, String)> {
    let method = Method::from_bytes(method.as_bytes())
        .map_err(|_| anyhow!("unsupported HTTP method {method}"))?;

    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(ct) = content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    let request = builder
        .body(Body::from(body))
        .context("cannot build the in-process request")?;

    let response = router(state).oneshot(request).await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = axum::body::to_bytes(response.into_body(), MAX_BODY_BYTES)
        .await
        .context("cannot read the in-process response body")?;
    Ok((status, body.to_vec(), content_type))
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/problems", get(routes::list_problems))
        .route("/datasets", get(routes::list_datasets))
        .route("/tags", get(routes::list_tags))
        .route("/random", get(routes::random_problem))
        .route("/session", get(routes::get_session))
        .route("/session/reset", post(routes::reset_session))
        .route("/session/enqueue", post(routes::enqueue_session))
        .route("/session/random", post(routes::random_session))
        .route("/config", get(routes::get_config).put(routes::put_config))
        .route("/llm/status", get(routes::llm_status))
        .route("/llm/models", get(routes::llm_models))
        .route("/llm/start", post(routes::llm_start))
        .route("/llm/stop", post(routes::llm_stop))
        .route("/problems/:id", get(routes::get_problem))
        .route("/problems/:id/adjacent", get(routes::adjacent_problem))
        .route("/problems/:id/load", post(routes::load_problem))
        .route("/workspace/:id/meta", get(routes::workspace_meta))
        .route("/workspace/:id/test", post(routes::run_tests))
        .route("/workspace/:id/open", post(routes::open_workspace))
        .route("/coach/review", post(coach::review))
        .route("/coach/ask", post(coach::ask))
        .route(
            "/docs/:hash/index",
            get(routes::get_docs_index).put(routes::put_docs_index),
        )
        .route("/docs/:hash/embed", post(routes::embed_docs))
        .route("/docs/:hash/retrieve", post(routes::retrieve_docs))
        .route(
            "/docs/:hash/chunks",
            get(routes::get_doc_chunks).put(routes::put_doc_chunks),
        )
        .route(
            "/docs/:hash/bytes",
            get(routes::get_doc_bytes).put(routes::put_doc_bytes),
        )
        .route("/pads/whiteboard", get(routes::list_whiteboard))
        .route("/pads/whiteboard/archive", get(routes::archive_whiteboard))
        .route("/pads/whiteboard/:id", put(routes::put_whiteboard))
        .route(
            "/pads/whiteboard/:id/tombstone",
            post(routes::tombstone_whiteboard),
        )
        .route(
            "/pads/whiteboard/:id/restore",
            post(routes::restore_whiteboard),
        )
        .route("/pads/annotate", get(routes::list_annotate))
        .route("/pads/annotate/archive", get(routes::archive_annotate))
        .route("/pads/annotate/:id", put(routes::put_annotate))
        .route(
            "/pads/annotate/:id/tombstone",
            post(routes::tombstone_annotate),
        )
        .route("/pads/annotate/:id/restore", post(routes::restore_annotate))
        .route(
            "/pads/problem/:dataset/:task_id",
            get(routes::get_problem_pad).put(routes::put_problem),
        )
        .route(
            "/pads/problem/:dataset/:task_id/tombstone",
            post(routes::tombstone_problem),
        )
        .route("/pads/snapshots", put(routes::put_snapshot))
        .route("/pads/snapshots/:kind/:key", get(routes::get_snapshots))
        .route("/pads/sync", get(routes::sync_pads))
        .route("/devices", get(routes::list_devices))
        .route(
            "/devices/:id/prefs",
            get(routes::get_device_prefs).put(routes::put_device_prefs),
        )
        .route("/devices/:id/clone", post(routes::clone_device_prefs))
        .route("/coach/viz", post(viz::viz))
        .route("/coach/draw_review", post(viz::draw_review))
        .route("/coach/reveal", post(coach::reveal))
        .route("/coach/lazy", post(coach::lazy_fill))
        .route("/coach/scaffold", post(coach::scaffold))
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
        .route(
            "/workspace/:id/agent",
            get(routes::get_agent_session).put(routes::put_agent_session),
        )
        .route("/workspace/:id/attempt", post(routes::finish_attempt))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

/// Upper bound on a request body: big enough for a board PNG, small enough that
/// a stray upload cannot exhaust memory.
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

async fn health(State(state): State<Shared>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "whiteboard",
        "version": env!("CARGO_PKG_VERSION"),
        "requires_token": state.token.is_some(),
    }))
}

/// Pairing-token check. A no-op when no token is configured.
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
            anyhow::anyhow!("missing or invalid token"),
        )),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

    #[tokio::test]
    async fn dispatch_health_without_binding_a_port() {
        let state = new_state(Config::default());
        let (status, body, _) = dispatch(state, "GET", "/health", vec![], None)
            .await
            .expect("dispatch should succeed");
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_slice(&body).expect("health is JSON");
        assert_eq!(json["ok"], true);
        assert_eq!(json["service"], "whiteboard");
    }

    #[tokio::test]
    async fn live_review_and_draw_review_if_llm_up() {
        if std::env::var("LC_LIVE_COACH").ok().as_deref() != Some("1") {
            return;
        }
        let mut cfg = match Config::load() {
            Ok(cfg) => cfg,
            Err(err) => {
                eprintln!("skip live coach: cannot load config: {err:#}");
                return;
            }
        };
        let probe_url = cfg.llm.local.base_url.clone();
        let reachable = tokio::task::spawn_blocking(move || {
            crate::llm::lifecycle::probe_reachable(&probe_url)
        })
        .await
        .expect("probe join");
        if !reachable {
            eprintln!(
                "skip live coach: {} not reachable",
                cfg.llm.local.base_url
            );
            return;
        }
        cfg.coach.draw_review_enabled = true;
        cfg.llm.local.vision = Some(true);
        let state = new_state(cfg);
        let review_body = serde_json::json!({
            "task_id": "two-sum",
            "dataset": "leetcode",
            "recognized_text": "hash map from value to index",
            "pseudocode": "for i, x in enumerate(nums):\n    if target - x in seen: return\n    seen[x] = i",
        });
        let (status, body, _) = dispatch(
            state.clone(),
            "POST",
            "/coach/review",
            serde_json::to_vec(&review_body).unwrap(),
            Some("application/json"),
        )
        .await
        .expect("review dispatch");
        let review_text = String::from_utf8_lossy(&body);
        eprintln!("POST /coach/review -> {status} {review_text}");
        assert_ne!(status, 500, "review 500: {review_text}");

        let draw_body = serde_json::json!({
            "task_id": "two-sum",
            "dataset": "leetcode",
            "ask": "show nums",
            "program": {
                "viz": "array",
                "id": "p1",
                "title": "nums",
                "frames": [{
                    "label": "start",
                    "cells": [2, 7, 11],
                    "pointers": {},
                    "highlight": [],
                    "entries": [],
                    "note": ""
                }]
            },
            "png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        });
        let (status, body, _) = dispatch(
            state,
            "POST",
            "/coach/draw_review",
            serde_json::to_vec(&draw_body).unwrap(),
            Some("application/json"),
        )
        .await
        .expect("draw_review dispatch");
        let draw_text = String::from_utf8_lossy(&body);
        eprintln!("POST /coach/draw_review -> {status} {draw_text}");
        assert_ne!(status, 500, "draw_review 500: {draw_text}");
    }
}
