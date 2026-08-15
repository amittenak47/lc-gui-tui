//! Document index HTTP: PUT/GET `/docs/:hash/index`.

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use super::{blocking, AppError, Shared};
use crate::docs_index::{self, IndexBody, IndexStatus};

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
