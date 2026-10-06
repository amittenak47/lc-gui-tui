//! Modern book protocol. HTTP and Tauri dispatch use these same handlers.
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{blocking, AppError};
use crate::pads::{self, atomic_sync, snapshot_copies};

pub(super) fn protocol_response<T: Serialize>(
    outcome: Result<T, atomic_sync::ProtocolError>,
) -> Response {
    match outcome {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(error.body),
        )
            .into_response(),
    }
}

pub async fn get_book_state(
    Path((kind, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let state = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        atomic_sync::get_book_state(&conn, &kind, &id)
    })
    .await
    .map_err(|error| {
        if error.message().contains("unreadable") {
            error.with_status(StatusCode::UNPROCESSABLE_ENTITY)
        } else {
            error
        }
    })?;
    Ok(Json(state).into_response())
}

#[derive(Deserialize)]
pub struct HeadQuery {
    pub book_rev: i64,
}

pub async fn check_book_head(
    Path((kind, id)): Path<(String, String)>,
    Query(query): Query<HeadQuery>,
) -> Result<Response, AppError> {
    let result = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        atomic_sync::check_book_head(&conn, &kind, &id, query.book_rev)
    })
    .await?;
    Ok(protocol_response(result.map(
        |state| json!({"unchanged":true,"book_rev":state.book_rev}),
    )))
}

#[derive(Deserialize)]
pub struct StageBody {
    pub gz: String,
}

pub async fn stage_ink_page(
    Path((upload_id, kind, key, page_id)): Path<(String, String, String, i64)>,
    Json(body): Json<StageBody>,
) -> Result<Response, AppError> {
    let outcome = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        atomic_sync::stage_ink(&conn, &upload_id, &kind, &key, page_id, &body.gz)
    })
    .await?;
    Ok(protocol_response(
        outcome.map(|hash| json!({"staged":true,"hash":hash})),
    ))
}

pub async fn list_staged_ink(Path(upload_id): Path<String>) -> Result<Json<Value>, AppError> {
    let rows = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        Ok(serde_json::to_value(atomic_sync::list_staged(
            &conn, &upload_id,
        )?)?)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn commit_pad(
    Json(body): Json<atomic_sync::CommitRequest>,
) -> Result<Response, AppError> {
    let result = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        atomic_sync::commit_pad(&conn, &body)
    })
    .await?;
    Ok(protocol_response(result))
}

pub async fn get_pad_commit(Path(upload_id): Path<String>) -> Result<Json<Value>, AppError> {
    let receipt = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        atomic_sync::get_commit(&conn, &upload_id)
    })
    .await?;
    receipt
        .map(Json)
        .ok_or_else(|| AppError::not_found(anyhow::anyhow!("no current commit receipt")))
}

pub async fn put_snapshot_copy(
    Path((kind, key, hash)): Path<(String, String, String)>,
    Json(body): Json<pads::SnapshotRow>,
) -> Result<Response, AppError> {
    let outcome = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        snapshot_copies::put_snapshot_copy(&conn, &kind, &key, &hash, &body)
    })
    .await?;
    Ok(protocol_response(outcome))
}

pub async fn list_snapshot_copies(
    Path((kind, key)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let rows = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        Ok(serde_json::to_value(
            snapshot_copies::list_snapshot_copies(&conn, &kind, &key)?,
        )?)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn get_snapshot_copy(
    Path((kind, key, hash)): Path<(String, String, String)>,
) -> Result<Json<pads::SnapshotRow>, AppError> {
    let copy = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        snapshot_copies::get_snapshot_copy(&conn, &kind, &key, &hash)
    })
    .await?;
    copy.map(Json)
        .ok_or_else(|| AppError::not_found(anyhow::anyhow!("no such snapshot copy")))
}
