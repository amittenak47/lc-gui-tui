//! Document transfer is streamed to disk; JSON requests keep their smaller cap.
use std::path::PathBuf;

use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, Request};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{blocking, AppError};
use crate::pads;

fn too_large(limit: usize) -> AppError {
    AppError::status(
        StatusCode::PAYLOAD_TOO_LARGE,
        anyhow::anyhow!(
            "This document exceeds the sync limit of {} MiB",
            limit / (1024 * 1024)
        ),
    )
}

pub async fn put_doc_bytes(
    UrlPath(hash): UrlPath<String>,
    request: Request,
) -> Result<StatusCode, AppError> {
    let destination = pads::blob_path(&pads::blobs_dir()?, &hash).map_err(AppError::bad_request)?;
    receive_document(destination, request, pads::MAX_BLOB_BYTES).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn receive_document(
    destination: PathBuf,
    request: Request,
    limit: usize,
) -> Result<(), AppError> {
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|size| size > limit as u64) {
        return Err(too_large(limit));
    }
    let (file, temporary) = blocking({
        let directory = destination.parent().expect("blob directory").to_path_buf();
        move || {
            std::fs::create_dir_all(&directory)?;
            Ok(tempfile::NamedTempFile::new_in(directory)?.into_parts())
        }
    })
    .await?;
    let mut file = tokio::fs::File::from_std(file);
    let mut stream = request.into_body().into_data_stream();
    let mut received = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AppError::bad_request(anyhow::anyhow!("Document upload interrupted: {error}"))
        })?;
        received += chunk.len() as u64;
        if received > limit as u64 {
            return Err(too_large(limit));
        }
        file.write_all(&chunk).await?;
    }
    if declared.is_some_and(|size| size != received) {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "Document upload incomplete; retry Sync"
        )));
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    // Atomic replacement: failed uploads leave the previous document intact.
    // TempPath also removes unfinished files on an error or cancelled request.
    blocking(move || {
        temporary.persist(destination)?;
        Ok(())
    })
    .await
}

pub async fn get_doc_bytes(UrlPath(hash): UrlPath<String>) -> Result<Response, AppError> {
    document_response(pads::blob_path(&pads::blobs_dir()?, &hash)?, false).await
}

pub async fn head_doc_bytes(UrlPath(hash): UrlPath<String>) -> Result<Response, AppError> {
    document_response(pads::blob_path(&pads::blobs_dir()?, &hash)?, true).await
}

async fn document_response(path: PathBuf, head: bool) -> Result<Response, AppError> {
    let file = tokio::fs::File::open(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::not_found(anyhow::anyhow!(
                "no bytes stored for this document (the text index may still exist)"
            ))
        } else {
            AppError::from(error)
        }
    })?;
    let length = file.metadata().await?.len();
    let body = if head {
        Body::empty()
    } else {
        Body::from_stream(futures_util::stream::try_unfold(
            file,
            |mut file| async move {
                let mut bytes = vec![0u8; 64 * 1024];
                let count = file.read(&mut bytes).await?;
                if count == 0 {
                    return Ok::<_, std::io::Error>(None);
                }
                bytes.truncate(count);
                Ok(Some((Bytes::from(bytes), file)))
            },
        ))
    };
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_LENGTH, &length.to_string()),
        ],
        body,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn large_document_round_trip_and_head_are_streamed() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("large-pdf");
        let chunk = Bytes::from(vec![42; 64 * 1024]);
        let size = chunk.len() * 688; // 43 MiB: above the old JSON/body cap.
        let body = Body::from_stream(futures_util::stream::iter(
            (0..688).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
        ));
        let request = Request::builder()
            .header(header::CONTENT_LENGTH, size)
            .body(body)
            .unwrap();
        receive_document(destination.clone(), request, pads::MAX_BLOB_BYTES)
            .await
            .unwrap();
        let head = document_response(destination.clone(), true).await.unwrap();
        assert_eq!(head.headers()[header::CONTENT_LENGTH], size.to_string());
        assert!(axum::body::to_bytes(head.into_body(), 0)
            .await
            .unwrap()
            .is_empty());
        let mut body = document_response(destination, false)
            .await
            .unwrap()
            .into_body()
            .into_data_stream();
        let mut received = 0;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.unwrap();
            assert!(chunk.len() <= 64 * 1024);
            assert!(chunk.iter().all(|byte| *byte == 42));
            received += chunk.len();
        }
        assert_eq!(received, size);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn rejected_and_interrupted_uploads_preserve_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("existing");
        std::fs::write(&destination, b"original").unwrap();
        let cases = [
            (
                Request::builder()
                    .header(header::CONTENT_LENGTH, 9)
                    .body(Body::from("too large"))
                    .unwrap(),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            // The same limit also applies when Content-Length is absent.
            (
                Request::new(Body::from("too large")),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
            (
                Request::builder()
                    .header(header::CONTENT_LENGTH, 8)
                    .body(Body::from("short"))
                    .unwrap(),
                StatusCode::BAD_REQUEST,
            ),
            (
                Request::new(Body::from_stream(futures_util::stream::iter([
                    Ok(Bytes::from_static(b"part")),
                    Err(std::io::Error::other("connection lost")),
                ]))),
                StatusCode::BAD_REQUEST,
            ),
        ];
        for (request, status) in cases {
            let error = receive_document(destination.clone(), request, 8)
                .await
                .unwrap_err();
            assert_eq!(error.status_code(), status);
            assert_eq!(std::fs::read(&destination).unwrap(), b"original");
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
        receive_document(destination.clone(), Request::new(Body::from("complete")), 8)
            .await
            .unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"complete");
    }
}
