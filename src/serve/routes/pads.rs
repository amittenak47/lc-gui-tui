//! Pad library, snapshots, document bytes, and per-device prefs.

use axum::body::Bytes;
use axum::extract::Path as UrlPath;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::{blocking, AppError};
use crate::pads::{self, AnnotatePad, DevicePrefs, PadKind, PutOutcome, SnapshotRow, WhiteboardPad};
use crate::serve::MAX_BODY_BYTES;

fn map_put<T: serde::Serialize>(outcome: PutOutcome<T>) -> Result<Response, AppError> {
    match outcome {
        PutOutcome::Written(row) => Ok((StatusCode::OK, Json(row)).into_response()),
        PutOutcome::Conflict(row) => Ok((StatusCode::CONFLICT, Json(row)).into_response()),
        PutOutcome::LiveCap { kind, limit } => Err(AppError::status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("live {kind} library is full ({limit})"),
        )),
    }
}

pub async fn list_whiteboard() -> Result<Json<Vec<WhiteboardPad>>, AppError> {
    let rows = blocking(|| {
        let conn = pads::open(&pads::db_path()?)?;
        pads::list_whiteboard(&conn, false)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn archive_whiteboard() -> Result<Json<Vec<WhiteboardPad>>, AppError> {
    let rows = blocking(|| {
        let conn = pads::open(&pads::db_path()?)?;
        pads::list_whiteboard(&conn, true)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn put_whiteboard(
    UrlPath(id): UrlPath<String>,
    Json(mut body): Json<WhiteboardPad>,
) -> Result<Response, AppError> {
    body.id = id;
    let outcome = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::put_whiteboard(&conn, &body)
    })
    .await?;
    map_put(outcome)
}

pub async fn tombstone_whiteboard(UrlPath(id): UrlPath<String>) -> Result<StatusCode, AppError> {
    let found = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::tombstone(&conn, PadKind::Whiteboard, &id)
    })
    .await?;
    if !found {
        return Err(AppError::not_found(anyhow::anyhow!("whiteboard pad not found")));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_whiteboard(UrlPath(id): UrlPath<String>) -> Result<StatusCode, AppError> {
    restore_kind(PadKind::Whiteboard, id).await
}

pub async fn list_annotate() -> Result<Json<Vec<AnnotatePad>>, AppError> {
    let rows = blocking(|| {
        let conn = pads::open(&pads::db_path()?)?;
        pads::list_annotate(&conn, false)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn archive_annotate() -> Result<Json<Vec<AnnotatePad>>, AppError> {
    let rows = blocking(|| {
        let conn = pads::open(&pads::db_path()?)?;
        pads::list_annotate(&conn, true)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn put_annotate(
    UrlPath(id): UrlPath<String>,
    Json(mut body): Json<AnnotatePad>,
) -> Result<Response, AppError> {
    body.id = id;
    let outcome = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::put_annotate(&conn, &body)
    })
    .await?;
    map_put(outcome)
}

pub async fn tombstone_annotate(UrlPath(id): UrlPath<String>) -> Result<StatusCode, AppError> {
    let found = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::tombstone(&conn, PadKind::Annotate, &id)
    })
    .await?;
    if !found {
        return Err(AppError::not_found(anyhow::anyhow!("annotate pad not found")));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_annotate(UrlPath(id): UrlPath<String>) -> Result<StatusCode, AppError> {
    restore_kind(PadKind::Annotate, id).await
}

async fn restore_kind(kind: PadKind, id: String) -> Result<StatusCode, AppError> {
    let outcome = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::restore(&conn, kind, &id)
    })
    .await?;
    match outcome {
        PutOutcome::Written(()) => Ok(StatusCode::NO_CONTENT),
        PutOutcome::Conflict(()) => Err(AppError::not_found(anyhow::anyhow!("pad not found"))),
        PutOutcome::LiveCap { kind, limit } => Err(AppError::status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("live {kind} library is full ({limit})"),
        )),
    }
}

pub async fn put_snapshot(Json(body): Json<SnapshotRow>) -> Result<StatusCode, AppError> {
    blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::put_snapshot(&conn, &body)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_snapshots(
    UrlPath((kind, key)): UrlPath<(String, String)>,
) -> Result<Json<Vec<SnapshotRow>>, AppError> {
    let rows = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::get_snapshots(&conn, &kind, &key)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn put_doc_bytes(
    UrlPath(hash): UrlPath<String>,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::status(
            StatusCode::PAYLOAD_TOO_LARGE,
            anyhow::anyhow!("document exceeds {MAX_BODY_BYTES} bytes"),
        ));
    }
    let bytes = body.to_vec();
    blocking(move || {
        let dir = pads::blobs_dir()?;
        pads::put_blob(&dir, &hash, &bytes)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_doc_bytes(UrlPath(hash): UrlPath<String>) -> Result<Response, AppError> {
    let bytes = blocking(move || {
        let dir = pads::blobs_dir()?;
        pads::get_blob(&dir, &hash)
    })
    .await?;
    match bytes {
        Some(bytes) => Ok((
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response()),
        None => Err(AppError::not_found(anyhow::anyhow!(
            "no bytes stored for this document (the text index may still exist)"
        ))),
    }
}

pub async fn list_devices() -> Result<Json<Vec<DevicePrefs>>, AppError> {
    let rows = blocking(|| {
        let conn = pads::open(&pads::db_path()?)?;
        pads::list_devices(&conn)
    })
    .await?;
    Ok(Json(rows))
}

pub async fn get_device_prefs(UrlPath(id): UrlPath<String>) -> Result<Json<DevicePrefs>, AppError> {
    let row = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::get_device(&conn, &id)
    })
    .await?;
    match row {
        Some(row) => Ok(Json(row)),
        None => Err(AppError::not_found(anyhow::anyhow!("no prefs for this device"))),
    }
}

pub async fn put_device_prefs(
    UrlPath(id): UrlPath<String>,
    Json(mut body): Json<DevicePrefs>,
) -> Result<Json<DevicePrefs>, AppError> {
    body.id = id;
    if body.updated_at == 0 {
        body.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
    }
    let row = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::put_device(&conn, &body)
    })
    .await?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct CloneBody {
    #[serde(default)]
    pub role: Option<String>,
}

pub async fn clone_device_prefs(
    UrlPath(id): UrlPath<String>,
    Json(body): Json<CloneBody>,
) -> Result<Response, AppError> {
    let role = body.role.unwrap_or_else(|| "desktop".into());
    let row = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        pads::clone_device(&conn, &id, &role)
    })
    .await?;
    match row {
        Some(row) => Ok((StatusCode::OK, Json(row)).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}
