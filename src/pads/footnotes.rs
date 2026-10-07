//! Inbox of "ask for a footnote" requests.
//!
//! The device is the only writer of the document. A model leaves its answer
//! here, and the next sync ping hands that answer back to the device that asked.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::write_transaction;

pub const LIST_CAP: i64 = 50;
pub const PING_CAP: i64 = 20;

#[derive(Debug)]
pub enum FootnoteFail {
    Invalid(String),
    NotFound,
    Conflict(String),
    Other(anyhow::Error),
}

impl From<rusqlite::Error> for FootnoteFail {
    fn from(err: rusqlite::Error) -> Self {
        Self::Other(err.into())
    }
}

impl From<serde_json::Error> for FootnoteFail {
    fn from(err: serde_json::Error) -> Self {
        Self::Other(err.into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteLink {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteResult {
    pub notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<FootnoteLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteRequest {
    pub id: String,
    pub device_id: String,
    pub doc_id: String,
    pub doc_name: String,
    pub page: Option<i64>,
    pub anchor: Value,
    pub excerpt: String,
    pub context: String,
    pub wide_context: String,
    pub page_footnotes: Value,
    pub prompt: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnoteRequestSummary {
    pub id: String,
    pub doc_name: String,
    pub page: Option<i64>,
    pub excerpt: String,
    pub context: String,
    pub prompt: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FootnotePingResult {
    pub id: String,
    pub doc_id: String,
    pub result: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewFootnoteRequest {
    pub id: String,
    pub device_id: String,
    pub doc_id: String,
    pub doc_name: String,
    #[serde(default)]
    pub page: Option<i64>,
    pub anchor: Value,
    pub excerpt: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub wide_context: String,
    #[serde(default)]
    pub page_footnotes: Value,
    #[serde(default)]
    pub prompt: Option<String>,
}

pub fn validate_request(body: &NewFootnoteRequest) -> Result<Value, String> {
    if !valid_id(&body.id) {
        return Err("id must be 1..=100 characters of [A-Za-z0-9_-]".into());
    }
    if body.device_id.is_empty() || body.device_id.chars().count() > 200 {
        return Err("device_id is required".into());
    }
    if body.doc_id.is_empty() || body.doc_id.chars().count() > 200 {
        return Err("doc_id is required".into());
    }
    let excerpt = body.excerpt.chars().count();
    if !(1..=4000).contains(&excerpt) {
        return Err("excerpt must be 1..=4000 characters".into());
    }
    if body.context.chars().count() > 8000 {
        return Err("context must be at most 8000 characters".into());
    }
    if body.wide_context.chars().count() > 24000 {
        return Err("wide_context must be at most 24000 characters".into());
    }
    if body.prompt.as_ref().map(|text| text.chars().count()).unwrap_or(0) > 1000 {
        return Err("prompt must be at most 1000 characters".into());
    }
    if !body.anchor.is_object() {
        return Err("anchor must be a JSON object".into());
    }
    let pages = if body.page_footnotes.is_null() {
        Value::Array(Vec::new())
    } else {
        body.page_footnotes.clone()
    };
    let Some(entries) = pages.as_array() else {
        return Err("page_footnotes must be a JSON array".into());
    };
    if entries.len() > 20 {
        return Err("page_footnotes must have at most 20 entries".into());
    }
    let bytes = serde_json::to_vec(&pages).map_err(|_| "page_footnotes must be JSON".to_string())?;
    if bytes.len() > 16000 {
        return Err("page_footnotes must be at most 16000 bytes".into());
    }
    Ok(pages)
}

/// Trim notes and links. The hub and the MCP server both call this before a result is stored.
pub fn validate_result(notes: &[String], links: &[FootnoteLink]) -> Result<FootnoteResult, String> {
    if !(1..=8).contains(&notes.len()) {
        return Err("notes must have 1..=8 entries".into());
    }
    let mut cleaned_notes = Vec::with_capacity(notes.len());
    for note in notes {
        let text = note.trim();
        if text.is_empty() {
            return Err("each note must be non-empty".into());
        }
        if text.chars().count() > 4000 {
            return Err("each note must be at most 4000 characters".into());
        }
        cleaned_notes.push(text.to_string());
    }
    if links.len() > 8 {
        return Err("links must have at most 8 entries".into());
    }
    let mut cleaned_links = Vec::with_capacity(links.len());
    for link in links {
        let url = link.url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("link url must start with http:// or https://".into());
        }
        if url.chars().count() > 2000 {
            return Err("link url must be at most 2000 characters".into());
        }
        let title = match link.title.as_deref() {
            Some(raw) => {
                let text = raw.trim();
                if text.is_empty() {
                    None
                } else if text.chars().count() > 200 {
                    return Err("link title must be at most 200 characters".into());
                } else {
                    Some(text.to_string())
                }
            }
            None => None,
        };
        cleaned_links.push(FootnoteLink { title, url: url.to_string() });
    }
    Ok(FootnoteResult { notes: cleaned_notes, links: cleaned_links })
}

pub fn valid_id(id: &str) -> bool {
    let count = id.chars().count();
    (1..=100).contains(&count)
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn transact<T>(conn: &Connection, body: impl FnOnce() -> Result<T, FootnoteFail>) -> Result<T, FootnoteFail> {
    match write_transaction(conn, || match body() {
        Ok(value) => Ok(Ok(value)),
        Err(FootnoteFail::Other(err)) => Err(err),
        Err(err) => Ok(Err(err)),
    }) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(FootnoteFail::Other(err)),
    }
}

pub fn create_request(
    conn: &Connection,
    body: NewFootnoteRequest,
    now: i64,
) -> Result<FootnoteRequest, FootnoteFail> {
    transact(conn, || {
        if let Some(existing) = get_request(conn, &body.id)? {
            return Ok(existing);
        }
        let pages = validate_request(&body).map_err(FootnoteFail::Invalid)?;
        conn.execute(
            "INSERT INTO footnote_requests (
                id, device_id, doc_id, doc_name, page, anchor, excerpt, context, wide_context,
                page_footnotes, prompt, status, result, created_at, done_at, acked_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', NULL, ?12, NULL, NULL)",
            params![
                body.id,
                body.device_id,
                body.doc_id,
                body.doc_name,
                body.page,
                serde_json::to_string(&body.anchor)?,
                body.excerpt,
                body.context,
                body.wide_context,
                serde_json::to_string(&pages)?,
                body.prompt,
                now,
            ],
        )?;
        get_request(conn, &body.id)?.ok_or(FootnoteFail::NotFound)
    })
}

pub fn get_request(conn: &Connection, id: &str) -> Result<Option<FootnoteRequest>, FootnoteFail> {
    let row = conn
        .query_row(
            "SELECT id, device_id, doc_id, doc_name, page, anchor, excerpt, context, wide_context,
                    page_footnotes, prompt, status, result, created_at, done_at, acked_at
             FROM footnote_requests WHERE id = ?1",
            params![id],
            map_request,
        )
        .optional()?;
    match row {
        Some(packed) => Ok(Some(unpack(packed)?)),
        None => Ok(None),
    }
}

pub fn list_pending(conn: &Connection) -> Result<Vec<FootnoteRequestSummary>, FootnoteFail> {
    let mut stmt = conn.prepare(
        "SELECT id, doc_name, page, excerpt, context, prompt, created_at
         FROM footnote_requests WHERE status = 'pending'
         ORDER BY created_at ASC, id ASC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![LIST_CAP], |row| {
        Ok(FootnoteRequestSummary {
            id: row.get(0)?,
            doc_name: row.get(1)?,
            page: row.get(2)?,
            excerpt: row.get(3)?,
            context: row.get(4)?,
            prompt: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(FootnoteFail::from)
}

pub fn submit_result(
    conn: &Connection,
    id: &str,
    notes: &[String],
    links: &[FootnoteLink],
    now: i64,
) -> Result<(), FootnoteFail> {
    let result = validate_result(notes, links).map_err(FootnoteFail::Invalid)?;
    let stored = serde_json::to_string(&result)?;
    transact(conn, || {
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM footnote_requests WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            None => return Err(FootnoteFail::NotFound),
            Some("pending") => {}
            Some(_) => {
                return Err(FootnoteFail::Conflict("footnote request is not pending".into()));
            }
        }
        let changed = conn.execute(
            "UPDATE footnote_requests
             SET status = 'done', result = ?2, done_at = ?3
             WHERE id = ?1 AND status = 'pending'",
            params![id, stored, now],
        )?;
        if changed == 0 {
            return Err(FootnoteFail::Conflict("footnote request is not pending".into()));
        }
        Ok(())
    })
}

pub fn ack_request(conn: &Connection, id: &str, now: i64) -> Result<(), FootnoteFail> {
    transact(conn, || {
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM footnote_requests WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(FootnoteFail::NotFound);
        }
        conn.execute(
            "UPDATE footnote_requests
             SET status = 'acked', acked_at = COALESCE(acked_at, ?2)
             WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    })
}

/// Answers still waiting on the device that asked. Empty when `device` is absent.
pub fn list_results(
    conn: &Connection,
    device: Option<&str>,
) -> Result<Vec<FootnotePingResult>, FootnoteFail> {
    let Some(device) = device.filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, doc_id, result FROM footnote_requests
         WHERE status = 'done' AND device_id = ?1
         ORDER BY done_at ASC, id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![device, PING_CAP], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, doc_id, result) = row?;
        out.push(FootnotePingResult {
            id,
            doc_id,
            result: serde_json::from_str(&result)?,
        });
    }
    Ok(out)
}

struct PackedRequest {
    request: FootnoteRequest,
    anchor: String,
    page_footnotes: String,
    result: Option<String>,
}

fn map_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<PackedRequest> {
    Ok(PackedRequest {
        request: FootnoteRequest {
            id: row.get(0)?,
            device_id: row.get(1)?,
            doc_id: row.get(2)?,
            doc_name: row.get(3)?,
            page: row.get(4)?,
            anchor: Value::Null,
            excerpt: row.get(6)?,
            context: row.get(7)?,
            wide_context: row.get(8)?,
            page_footnotes: Value::Null,
            prompt: row.get(10)?,
            status: row.get(11)?,
            result: None,
            created_at: row.get(13)?,
            done_at: row.get(14)?,
            acked_at: row.get(15)?,
        },
        anchor: row.get(5)?,
        page_footnotes: row.get(9)?,
        result: row.get(12)?,
    })
}

fn unpack(packed: PackedRequest) -> Result<FootnoteRequest, FootnoteFail> {
    let mut request = packed.request;
    request.anchor = serde_json::from_str(&packed.anchor)?;
    request.page_footnotes = serde_json::from_str(&packed.page_footnotes)?;
    request.result = packed.result.as_deref().map(serde_json::from_str).transpose()?;
    Ok(request)
}
