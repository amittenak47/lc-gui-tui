//! Pad library, snapshots, document bytes, and per-device prefs.

use axum::body::Bytes;
use axum::extract::Path as UrlPath;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum::extract::Query;
use serde::{Deserialize, Serialize};

use super::{blocking, AppError};
use crate::pads::{
    self, AnnotatePad, ApplyAck, DevicePrefs, GoneRow, PadKind, PutOutcome, SnapshotRow,
    WhiteboardPad,
};
use crate::serve::MAX_BODY_BYTES;

fn map_put<T: serde::Serialize>(outcome: PutOutcome<T>) -> Result<Response, AppError> {
    match outcome {
        PutOutcome::Written(row) => Ok((StatusCode::OK, Json(row)).into_response()),
        PutOutcome::Conflict(row) => Ok((StatusCode::CONFLICT, Json(row)).into_response()),
        PutOutcome::Gone { seq } => Ok((
            StatusCode::GONE,
            Json(serde_json::json!({ "gone": true, "seq": seq })),
        )
            .into_response()),
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

#[derive(Debug, Deserialize, Default)]
pub struct SeqBody {
    #[serde(default)]
    pub seq: i64,
}

pub async fn tombstone_whiteboard(
    UrlPath(id): UrlPath<String>,
    Json(body): Json<SeqBody>,
) -> Result<Json<ApplyAck>, AppError> {
    delete_kind(PadKind::Whiteboard, id, body.seq).await
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

pub async fn tombstone_annotate(
    UrlPath(id): UrlPath<String>,
    Json(body): Json<SeqBody>,
) -> Result<Json<ApplyAck>, AppError> {
    delete_kind(PadKind::Annotate, id, body.seq).await
}

pub async fn restore_annotate(UrlPath(id): UrlPath<String>) -> Result<StatusCode, AppError> {
    restore_kind(PadKind::Annotate, id).await
}

async fn delete_kind(kind: PadKind, id: String, seq: i64) -> Result<Json<ApplyAck>, AppError> {
    let (ack, hash) = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        let hash = if kind == PadKind::Annotate {
            pads::get_annotate(&conn, &id)?.map(|row| row.hash)
        } else {
            None
        };
        let ack = if seq > 0 {
            pads::delete_pad(&conn, kind, &id, seq)?
        } else {
            let applied = pads::tombstone(&conn, kind, &id)?;
            pads::ApplyAck {
                applied,
                seq: 1,
            }
        };
        Ok::<_, anyhow::Error>((ack, hash))
    })
    .await?;
    if ack.applied {
        if let Some(hash) = hash {
            let _ = blocking(move || {
                let conn = pads::open(&pads::db_path()?)?;
                if !pads::annotate_hash_in_use(&conn, &hash)? {
                    let dir = pads::blobs_dir()?;
                    let path = pads::blob_path(&dir, &hash)?;
                    let _ = std::fs::remove_file(path);
                }
                Ok::<_, anyhow::Error>(())
            })
            .await;
        }
    }
    Ok(Json(ack))
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
        PutOutcome::Gone { .. } => Err(AppError::not_found(anyhow::anyhow!("pad not found"))),
        PutOutcome::LiveCap { kind, limit } => Err(AppError::status(
            StatusCode::FORBIDDEN,
            anyhow::anyhow!("live {kind} library is full ({limit})"),
        )),
    }
}

#[derive(Debug, Deserialize)]
pub struct SyncQuery {
    #[serde(default)]
    pub since: i64,
}

#[derive(Debug, Serialize)]
pub struct PadSyncPing {
    pub now: i64,
    pub whiteboard: Vec<WhiteboardPad>,
    pub annotate: Vec<AnnotatePad>,
    pub snapshots: Vec<SnapshotRow>,
    pub gone: Vec<GoneRow>,
}

/// Periodic ping: saved whiteboards, annotated files, and rolling snapshots
/// whose `updated_at` / `written_at` / tombstone is newer than `since`.
pub async fn sync_pads(Query(query): Query<SyncQuery>) -> Result<Json<PadSyncPing>, AppError> {
    let since = query.since;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (whiteboard, annotate, snapshots, gone) = blocking(move || {
        let conn = pads::open(&pads::db_path()?)?;
        Ok((
            pads::list_changed_whiteboard(&conn, since)?,
            pads::list_changed_annotate(&conn, since)?,
            pads::list_changed_snapshots(&conn, since)?,
            pads::list_changed_gone(&conn, since)?,
        ))
    })
    .await?;
    Ok(Json(PadSyncPing {
        now,
        whiteboard,
        annotate,
        snapshots,
        gone,
    }))
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
