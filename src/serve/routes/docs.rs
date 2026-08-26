//! Document index HTTP: PUT/GET `/docs/:hash/index`, POST `/docs/:hash/retrieve`.

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::{blocking, AppError, Shared};
use crate::docs_index::{self, IndexBody, IndexPage, IndexStatus, RetrievedChunk};
use crate::pads;

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

/// Query for `POST /docs/{hash}/index-from-bytes`.
#[derive(Debug, Deserialize, Default)]
pub struct IndexFromBytesBody {
    /// File name as opened; stored with the index for display.
    pub name: String,
    /// `pdf`, `markdown`, `code`. The hub extracts what it can from bytes;
    /// text kinds arrive as text instead of a blob.
    #[serde(default)]
    pub doc_type: Option<String>,
    /// For markdown/code: the pad's source text. These have no bytes on the
    /// hub — the text is small enough to ride in the request.
    #[serde(default)]
    pub source_text: Option<String>,
}

/// Extract a stored blob into the index.
///
/// The tablet never runs pdf.js `getTextContent` for indexing — extraction
/// happens here, against the bytes it already uploaded once, so opening a
/// textbook does not fight the paint worker for its pages. Markdown and code
/// have no blob: their source text rides in the request instead.
pub async fn index_from_bytes(
    State(state): State<Shared>,
    UrlPath(hash): UrlPath<String>,
    Json(body): Json<IndexFromBytesBody>,
) -> Result<Response, AppError> {
    let hash = hash.trim().to_string();
    if hash.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document hash")));
    }
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("missing document name")));
    }
    let doc_type = body.doc_type.as_deref().unwrap_or("pdf").trim().to_string();

    let pages = if doc_type == "markdown" || doc_type == "code" {
        // Text kinds: no blob exists. One page, the whole text.
        let text = body.source_text.unwrap_or_default().trim().to_string();
        if text.is_empty() {
            return Err(AppError::bad_request(anyhow::anyhow!("no source text to index")));
        }
        vec![IndexPage {
            page: 1,
            text,
            heading: None,
        }]
    } else if doc_type == "pdf" {
        let blob_hash = hash.clone();
        let bytes = blocking(move || {
            let dir = pads::blobs_dir()?;
            Ok(pads::get_blob(&dir, &blob_hash)?)
        })
        .await?;
        let Some(bytes) = bytes else {
            return Err(AppError::not_found(anyhow::anyhow!(
                "no bytes stored for this document — PUT /docs/:hash/bytes first"
            )));
        };
        blocking(move || {
            Ok(pdf_extract::extract_text_from_mem_by_pages(&bytes)?)
        })
            .await?
            .into_iter()
            .enumerate()
            .map(|(i, text)| IndexPage {
                page: (i + 1) as u32,
                text,
                heading: None,
            })
            .collect::<Vec<_>>()
    } else {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "doc type {doc_type} cannot be indexed from hub-side bytes"
        )));
    };

    if pages.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "no text could be read from this document"
        )));
    }

    let cfg = state.cfg_snapshot();
    let result = blocking(move || {
        let path = docs_index::db_path()?;
        let mut conn = docs_index::open(&path)?;
        let before = docs_index::status(&conn, &hash)?;
        let body = IndexBody {
            name: name.clone(),
            doc_type: doc_type.clone(),
            pages,
        };
        let after = docs_index::upsert(&mut conn, &hash, &body, &cfg, false)?;
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

#[derive(Debug, Deserialize)]
pub struct LibraryRetrieveBody {
    pub query: String,
    #[serde(default)]
    pub k: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct LibraryRetrieveResponse {
    pub chunks: Vec<docs_index::LibraryChunk>,
    pub scope: docs_index::LibraryScope,
    /// The sentence the UI shows verbatim, so the rule lives in one place.
    pub summary: String,
}

/// Ask the whole library. Explore's home, and the agent's `query_library_vectors`.
pub async fn retrieve_library(
    State(state): State<Shared>,
    Json(body): Json<LibraryRetrieveBody>,
) -> Result<Json<LibraryRetrieveResponse>, AppError> {
    let query = body.query.trim().to_string();
    if query.is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!("query is empty")));
    }
    let k = body.k.unwrap_or(4);
    let cfg = state.cfg_snapshot();
    let (chunks, scope) = blocking(move || {
        let path = docs_index::db_path()?;
        let conn = docs_index::open(&path)?;
        docs_index::retrieve_library(&conn, &query, k, &cfg)
    })
    .await?;
    let summary = docs_index::library_scope_line(&scope);
    Ok(Json(LibraryRetrieveResponse {
        chunks,
        scope,
        summary,
    }))
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
