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

pub async fn get_index(
    State(_state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
) -> Result<Json<IndexStatus>, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    let status = blocking(move || {
        let path = docs_index::db_path()?;
        let conn = docs_index::open(&path)?;
        docs_index::status(&conn, &hash)
    })
    .await?;
    Ok(Json(status))
}

pub async fn put_index(
    State(state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
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
        let after = docs_index::upsert(&mut conn, &hash, &body, &cfg)?;
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
