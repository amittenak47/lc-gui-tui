//! Document index HTTP: PUT/GET `/docs/:hash/index`, POST `/docs/:hash/retrieve`.

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::{blocking, AppError, Shared};
use crate::docs_index::{self, IndexBody, IndexStatus, RetrievedChunk};

#[derive(Debug, Serialize)]
pub struct IndexResponse {
    #[serde(flatten)]
    pub status: IndexStatus,
    /// True when this call wrote chunks (false = already indexed).
    pub wrote: bool,
}

/// What the reader is told about a document's index.
///
/// `IndexStatus` reports facts; this adds the interpretation, because whether a
/// model is *stale* depends on what is configured right now and the database
/// cannot know that. Kept separate so the two never drift into one another.
#[derive(Debug, Serialize)]
pub struct IndexStatusView {
    #[serde(flatten)]
    pub status: IndexStatus,
    pub chunks_total: u32,
    pub chunks_embedded: u32,
    /// `none`, `partial` or `full`.
    pub embed_state: &'static str,
    /// Why it is not `full`, when it is not. Absent when there is nothing to say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// What is configured now, so the UI can name both sides of a mismatch.
    pub configured_model: String,
}

fn view(status: IndexStatus, embedded: u32, configured: &str) -> IndexStatusView {
    let total = status.chunk_count;
    let stale = !status.embed_model.is_empty()
        && !configured.is_empty()
        && status.embed_model != configured;
    let embed_state = if !status.indexed || total == 0 {
        "none"
    } else if stale {
        // Vectors from another model cannot be ranked against this one's, so a
        // document embedded under a different model is not partly done. It is
        // work to redo.
        "none"
    } else if embedded == 0 {
        "none"
    } else if embedded < total {
        "partial"
    } else {
        "full"
    };
    let reason = if !status.indexed {
        Some("not indexed".to_string())
    } else if stale {
        Some(format!(
            "embedded with {}, now using {}",
            status.embed_model, configured
        ))
    } else if configured.is_empty() && embedded < total {
        Some("no embedding model is configured".to_string())
    } else if embedded < total {
        Some("pending".to_string())
    } else {
        None
    };
    IndexStatusView {
        status,
        chunks_total: total,
        chunks_embedded: embedded,
        embed_state,
        reason,
        configured_model: configured.to_string(),
    }
}

pub async fn get_index(
    State(state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
) -> Result<Json<IndexStatusView>, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    let cfg = state.cfg_snapshot();
    let view = blocking(move || {
        let path = docs_index::db_path()?;
        let conn = docs_index::open(&path)?;
        let status = docs_index::status(&conn, &hash)?;
        let embedded = docs_index::embedded_chunk_count(&conn, &hash)?;
        let configured = cfg.embed_model().unwrap_or("").to_string();
        Ok::<_, anyhow::Error>(view(status, embedded, &configured))
    })
    .await?;
    Ok(Json(view))
}

/// `POST /docs/{hash}/embed` — one budget's worth of the embedding pass.
///
/// Deliberately not a long-lived request that runs to completion: a book is
/// minutes of work, and a caller that can stop between budgets is a caller the
/// reader can close the app on. Call it until `done == total`.
pub async fn embed(
    State(state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
) -> Result<Json<docs_index::EmbedProgress>, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    let cfg = state.cfg_snapshot();
    let progress = blocking(move || {
        let path = docs_index::db_path()?;
        let mut conn = docs_index::open(&path)?;
        docs_index::embed_pending(&mut conn, &hash, &cfg, docs_index::EMBED_BUDGET_CHUNKS)
    })
    .await?;
    Ok(Json(progress))
}

/// Query for `PUT /docs/{hash}/index`.
#[derive(serde::Deserialize, Default)]
pub struct PutIndexQuery {
    /// Rewrite even when the page count is unchanged.
    ///
    /// Turning an embedding model on leaves every page count exactly where it
    /// was, so the idempotence guard skips the one document that most needs
    /// redoing. This is how the reader says "do it anyway".
    #[serde(default)]
    pub force: bool,
}

pub async fn put_index(
    State(state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
    Query(query): Query<PutIndexQuery>,
    Json(body): Json<IndexBody>,
) -> Result<Response, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    if body.pages.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("no pages to index")));
    }
    let cfg = state.cfg_snapshot();
    let result = blocking(move || {
        let path = docs_index::db_path()?;
        let mut conn = docs_index::open(&path)?;
        let before = docs_index::status(&conn, &hash)?;
        let after = docs_index::upsert(&mut conn, &hash, &body, &cfg, query.force)?;
        Ok::<_, anyhow::Error>(IndexResponse {
            wrote: !before.indexed || before.chunk_count != after.chunk_count,
            status: after,
        })
    })
    .await?;
    if !result.wrote {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    Ok((StatusCode::CREATED, Json(result)).into_response())
}

/// `?q=…&k=…` — the query to score chunks against, and how many to return.
#[derive(Debug, Deserialize)]
pub struct RetrieveQuery {
    pub q: String,
    pub k: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct RetrieveResponse {
    pub chunks: Vec<RetrievedChunk>,
}

/// Nearest chunks of one document, for link suggestions and Ask.
///
/// The scoring already existed for the coach; only the client had no way in.
/// Keyed by **file hash**, not by annotation set — two sets of ink over one
/// textbook should suggest from the same text, because it is the same text.
pub async fn retrieve(
    State(state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
    Query(query): Query<RetrieveQuery>,
) -> Result<Json<RetrieveResponse>, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    let text = query.q.trim().to_string();
    if text.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing query")));
    }
    // `retrieve` clamps to 1..=8 itself; this only decides the default.
    let k = query.k.unwrap_or(4);
    let cfg = state.cfg_snapshot();
    let chunks = blocking(move || {
        let path = docs_index::db_path()?;
        let conn = docs_index::open(&path)?;
        docs_index::retrieve(&conn, &hash, &text, k, &cfg)
    })
    .await?;
    Ok(Json(RetrieveResponse { chunks }))
}

pub async fn list_chunk_digests() -> Result<Json<Vec<docs_index::ChunkDigest>>, AppError> {
    let digests = blocking(move || {
        let path = docs_index::db_path()?;
        let conn = docs_index::open(&path)?;
        docs_index::list_chunk_digests(&conn)
    })
    .await?;
    Ok(Json(digests))
}

pub async fn get_chunks(
    UrlPath(hash): UrlPath<String>,
) -> Result<Json<docs_index::ChunkBundle>, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    let bundle = blocking(move || {
        let path = docs_index::db_path()?;
        let conn = docs_index::open(&path)?;
        docs_index::list_chunks(&conn, &hash)
    })
    .await?;
    Ok(Json(bundle))
}

pub async fn put_chunks(
    UrlPath(hash): UrlPath<String>,
    Json(mut body): Json<docs_index::ChunkBundle>,
) -> Result<Response, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    if body.hash.trim().is_empty() {
        body.hash = hash.clone();
    } else if body.hash != hash {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "chunk bundle hash does not match the path"
        )));
    }
    let ack = blocking(move || {
        let path = docs_index::db_path()?;
        let mut conn = docs_index::open(&path)?;
        docs_index::merge_chunks(&mut conn, &body)
    })
    .await?;
    Ok(Json(ack).into_response())
}
