//! Local document index: chunked page text, embeddings, cosine retrieval.
//!
//! Lives next to `problems.db` (`docs.db`). Keyed by the same content hash the
//! tablet already uses. A missing embed model falls back to a hashed bag-of-words
//! vector so Ask still retrieves without a second GPU slot.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::config::{config_dir, Config};

/// ~500–800 tokens at ~4 chars/token, with ~80-token overlap.
const CHUNK_CHARS: usize = 2400;
const OVERLAP_CHARS: usize = 320;
const HASH_DIM: usize = 64;
const PREFETCH_K: usize = 4;
const RETRIEVAL_CHAR_CAP: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexPage {
    pub page: u32,
    pub text: String,
    #[serde(default)]
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexBody {
    pub name: String,
    pub doc_type: String,
    pub pages: Vec<IndexPage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexStatus {
    pub hash: String,
    pub indexed: bool,
    pub page_count: u32,
    pub chunk_count: u32,
    pub embedded: bool,
    /// The model that produced these vectors, or empty if none did.
    ///
    /// A fact, not an interpretation: whether it is *stale* depends on what is
    /// configured right now, which is the caller's to know and say.
    pub embed_model: String,
}

/// One scored chunk. `Serialize` because `/docs/:hash/retrieve` returns these
/// to the client; the coach used them in-process and never needed it.
#[derive(Debug, Clone, Serialize)]
pub struct RetrievedChunk {
    pub page: u32,
    pub heading: Option<String>,
    pub text: String,
    pub score: f32,
}

pub fn db_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("docs.db"))
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("cannot open document index {}", path.display()))?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS documents (
            hash TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            doc_type TEXT NOT NULL,
            page_count INTEGER NOT NULL,
            embedded INTEGER NOT NULL DEFAULT 0,
            -- The model that produced this document's vectors, or empty. See
            -- `migrate`: dimension was standing in for provenance and is a poor
            -- proxy, since two models can share one and still be incomparable.
            embed_model TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            page INTEGER NOT NULL,
            heading TEXT,
            text TEXT NOT NULL,
            embedding BLOB,
            -- What this chunk's vector is made of: 1 a model's, 0 word-counts.
            -- See `migrate` for why it is per chunk rather than per document.
            embedded INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(hash) REFERENCES documents(hash) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
        CREATE INDEX IF NOT EXISTS idx_chunks_hash_page ON chunks(hash, page);
        "#,
    )?;
    migrate(&conn)?;
    Ok(conn)
}

/// Schema version of the newest migration below.
const SCHEMA_VERSION: i64 = 2;

/*
 * Migrations, because `CREATE TABLE IF NOT EXISTS` cannot add a column.
 *
 * `PRAGMA user_version` is SQLite's own four bytes of file header set aside for
 * exactly this, so it costs no table and cannot itself need migrating. Each step
 * is written to be safe on a database that already has what it adds, since the
 * cheapest way to be wrong here is to assume the version is accurate.
 */
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 && !has_column(conn, "chunks", "embedded")? {
        /*
         * What a chunk's vector is made of, per chunk.
         *
         * `documents.embedded` was one boolean for a whole document, which could
         * not tell "no model configured" from "too long to try" from "half done"
         * — three different situations wanting three different things done.
         *
         * Existing rows default to 0, which is true of them: they hold
         * word-counts unless something embedded them, and treating an embedded
         * one as unembedded costs a re-embed and never lies. The other direction
         * would.
         */
        conn.execute_batch(
            "ALTER TABLE chunks ADD COLUMN embedded INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if version < 2 && !has_column(conn, "documents", "embed_model")? {
        /*
         * Which model made these vectors.
         *
         * Without it, changing model degrades retrieval in silence: the query
         * comes back at a new dimension, `comparable` says no, and every
         * document quietly drops to word matching with nothing said. Dimension
         * was standing in for provenance and is a poor proxy — two models can
         * share one and still be incomparable.
         *
         * Empty for existing rows, which is honest: nothing recorded what made
         * them, so nothing can claim to know.
         */
        conn.execute_batch(
            "ALTER TABLE documents ADD COLUMN embed_model TEXT NOT NULL DEFAULT '';",
        )?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// How many of a document's chunks carry a model's vector.
///
/// Its own query because progress is asked for far more often than the rest of
/// the status, and because this *is* the progress: the unit is a row, so there
/// is nothing else to keep in step with it.
pub fn embedded_chunk_count(conn: &Connection, hash: &str) -> Result<u32> {
    let count: i64 = conn.query_row(
        "SELECT COALESCE(SUM(embedded), 0) FROM chunks WHERE hash = ?1",
        params![hash],
        |row| row.get(0),
    )?;
    Ok(count as u32)
}

pub fn status(conn: &Connection, hash: &str) -> Result<IndexStatus> {
    let head = conn
        .query_row(
            "SELECT page_count, embed_model FROM documents WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    /*
     * Derived, never stored.
     *
     * A `documents.embedded` boolean can drift: crash between the last chunk's
     * write and the flag's update and the document claims to be embedded
     * forever, because nothing re-checks. Counting the chunks cannot drift —
     * the worst it can say is "not finished yet", which is true and
     * self-correcting. The column stays in the schema (dropping one in SQLite is
     * awkward) but nothing reads it, so the chunks win by construction.
     */
    let (chunk_count, embedded_count) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(embedded), 0) FROM chunks WHERE hash = ?1",
        params![hash],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    match head {
        Some((page_count, embed_model)) => Ok(IndexStatus {
            hash: hash.to_string(),
            indexed: true,
            page_count: page_count as u32,
            chunk_count: chunk_count as u32,
            // An empty document is not embedded; `all` over nothing would say yes.
            embedded: chunk_count > 0 && embedded_count == chunk_count,
            embed_model,
        }),
        None => Ok(IndexStatus {
            hash: hash.to_string(),
            indexed: false,
            page_count: 0,
            chunk_count: 0,
            embedded: false,
            embed_model: String::new(),
        }),
    }
}

/// Idempotent upsert. Same hash + same page count → no rewrite.
///
/// `force` rewrites anyway. Turning an embedding model on does not change a
/// document's page count, so without it the one case that most needs redoing —
/// vectors written as word-counts, now that real ones are available — is
/// exactly the case the guard skips.
pub fn upsert(
    conn: &mut Connection,
    hash: &str,
    body: &IndexBody,
    // Unused since indexing stopped embedding — kept because every caller has
    // one, and `embed_pending`, which does need it, is the natural next call.
    _cfg: &Config,
    force: bool,
) -> Result<IndexStatus> {
    let existing = status(conn, hash)?;
    if !force && existing.indexed && existing.page_count == body.pages.len() as u32 {
        return Ok(existing);
    }

    /*
     * Chunk and write. No model, no network, no waiting.
     *
     * Embedding used to happen *inside* this call, which tied "is this document
     * retrievable at all" to "is an embedding server up and fast" — so a slow or
     * missing model made indexing slow or silently worse, when the two have
     * nothing to do with each other. Now indexing is always fast and always
     * finishes, storing word-count vectors and marking every chunk unembedded;
     * `embed_pending` upgrades them afterwards, in its own time, resumably.
     */
    let chunks = chunk_pages(&body.pages);
    let embeddings: Vec<Vec<f32>> = chunks.iter().map(|c| hashed_embedding(&c.text)).collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let used_http = false;

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM chunks WHERE hash = ?1", params![hash])?;
    tx.execute("DELETE FROM documents WHERE hash = ?1", params![hash])?;
    tx.execute(
        "INSERT INTO documents (hash, name, doc_type, page_count, embedded, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            hash,
            body.name,
            body.doc_type,
            body.pages.len() as i64,
            if used_http { 1 } else { 0 },
            now
        ],
    )?;
    for (chunk, vector) in chunks.iter().zip(embeddings.iter()) {
        let blob = encode_f32(vector);
        tx.execute(
            "INSERT INTO chunks (hash, page, heading, text, embedding, embedded)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                hash,
                chunk.page as i64,
                chunk.heading,
                chunk.text,
                blob,
                if used_http { 1 } else { 0 }
            ],
        )?;
    }
    tx.commit()?;
    status(conn, hash)
}

/// How far the embedding pass has got, and why it stopped if it did.
#[derive(Debug, Clone, Serialize)]
pub struct EmbedProgress {
    pub done: u32,
    pub total: u32,
    /// Absent while work remains and nothing has gone wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Chunks to attempt in one call, so a caller can stay responsive.
pub const EMBED_BUDGET_CHUNKS: usize = 64;

/// Upgrade unembedded chunks to a model's vectors, a budget at a time.
///
/// Separate from `upsert` on purpose. Indexing is chunking — fast, offline, and
/// something that should always finish; embedding is a long conversation with a
/// server that may be slow, missing or halfway through loading a model. Tying
/// them together meant the second could quietly spoil the first.
///
/// **Resumable by construction.** The unit of progress is a row: each batch
/// commits its own transaction, so an interruption loses exactly the batch in
/// flight and leaves the rest marked done. There is no cursor to keep, no job
/// record to reconcile — asking "what is still 0?" is the resume.
///
/// A batch that fails stops the pass and leaves its chunks unembedded rather
/// than writing word-counts over them, so a retry is a retry rather than a
/// second helping of the same fallback.
pub fn embed_pending(
    conn: &mut Connection,
    hash: &str,
    cfg: &Config,
    budget: usize,
) -> Result<EmbedProgress> {
    let counts = |conn: &Connection| -> Result<(u32, u32)> {
        let row = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(embedded), 0) FROM chunks WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        Ok((row.1 as u32, row.0 as u32))
    };

    let (done, total) = counts(conn)?;
    if total == 0 {
        return Ok(EmbedProgress {
            done: 0,
            total: 0,
            reason: Some("nothing is indexed under this hash".into()),
        });
    }
    let configured = cfg
        .embed_model()
        .filter(|m| !m.is_empty())
        .map(str::to_string);

    /*
     * A different model means start again, not carry on — and this is settled
     * before asking whether the work is finished.
     *
     * Vectors from two models do not share a space, so half of each is not a
     * document half-done, it is a document that cannot be ranked at all. The
     * case that matters most is one *fully* embedded under the old model: ask
     * about completion first and the answer is yes, the pass returns, and
     * `retrieve` is left to discover the mismatch later and drop to word
     * matching without saying so.
     */
    let (done, total) = match &configured {
        Some(model) => {
            let stored: String = conn
                .query_row(
                    "SELECT embed_model FROM documents WHERE hash = ?1",
                    params![hash],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or_default();
            if !stored.is_empty() && &stored != model {
                conn.execute("UPDATE chunks SET embedded = 0 WHERE hash = ?1", params![hash])?;
                counts(conn)?
            } else {
                (done, total)
            }
        }
        // Nothing configured to compare against, so nothing to invalidate.
        None => (done, total),
    };

    // Finished is finished, whatever is or is not configured now: a document
    // that needs no work does not need a model to say so.
    if done == total {
        return Ok(EmbedProgress { done, total, reason: None });
    }
    let Some(model) = configured else {
        return Ok(EmbedProgress {
            done,
            total,
            reason: Some("no embedding model is configured".into()),
        });
    };
    conn.execute(
        "UPDATE documents SET embed_model = ?1 WHERE hash = ?2",
        params![model, hash],
    )?;

    let pending: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, text FROM chunks WHERE hash = ?1 AND embedded = 0 ORDER BY page, id
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![hash, budget.max(1) as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    let texts: Vec<&str> = pending.iter().map(|(_, text)| text.as_str()).collect();
    let base_url = cfg.embed_base_url().to_string();
    for range in embed_batches(&texts, HTTP_EMBED_MAX_CHARS) {
        let batch = &texts[range.clone()];
        let vectors = match http_embed(&base_url, &model, batch) {
            Ok(vectors) if vectors.len() == batch.len() => vectors,
            Ok(vectors) => {
                let (done, total) = counts(conn)?;
                return Ok(EmbedProgress {
                    done,
                    total,
                    reason: Some(format!(
                        "the endpoint returned {} vectors for {} texts",
                        vectors.len(),
                        batch.len()
                    )),
                });
            }
            Err(err) => {
                let (done, total) = counts(conn)?;
                return Ok(EmbedProgress {
                    done,
                    total,
                    reason: Some(format!("{err:#}")),
                });
            }
        };
        // One transaction per batch: an interruption costs this batch and no more.
        let tx = conn.transaction()?;
        for ((id, _), vector) in pending[range].iter().zip(vectors.iter()) {
            tx.execute(
                "UPDATE chunks SET embedding = ?1, embedded = 1 WHERE id = ?2",
                params![encode_f32(vector), id],
            )?;
        }
        tx.commit()?;
    }

    let (done, total) = counts(conn)?;
    Ok(EmbedProgress { done, total, reason: None })
}

pub fn retrieve(conn: &Connection, hash: &str, query: &str, k: usize, cfg: &Config) -> Result<Vec<RetrievedChunk>> {
    let k = k.clamp(1, 8);
    let mut stmt = conn.prepare(
        "SELECT page, heading, text, embedding, embedded FROM chunks WHERE hash = ?1
         ORDER BY page, id",
    )?;
    let rows = stmt.query_map(params![hash], |row| {
        Ok((
            row.get::<_, i64>(0)? as u32,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<Vec<u8>>>(3)?,
            row.get::<_, i64>(4)? != 0,
        ))
    })?;
    let (query_vecs, query_kind, _) = embed_texts(cfg, &[query])?;
    let query_vec = query_vecs.into_iter().next().unwrap_or_default();
    let loaded: Vec<(u32, Option<String>, String, Vec<f32>, bool)> = rows
        .map(|row| {
            row.map(|(page, heading, text, blob, embedded)| {
                (
                    page,
                    heading,
                    text,
                    blob.as_deref().map(decode_f32).unwrap_or_default(),
                    embedded,
                )
            })
        })
        .collect::<std::result::Result<_, _>>()?;
    /*
     * One scale for the whole list.
     *
     * A document indexed before an embedding model was configured holds 64-dim
     * word-counts; the query now comes back at the model's dimension. Deciding
     * per chunk meant cosine scores and lexical scores were sorted against each
     * other in the same ranking — two different number lines, one ordering, and
     * whichever happened to run larger won regardless of relevance.
     *
     * So the document answers as a whole: comparable vectors, or lexical
     * throughout. Being consistently coarse beats being incomparably mixed.
     */
    /*
     * Provenance, not shape.
     *
     * This used to infer comparability from vector *length*, which worked only
     * because 64-dim word-counts happen to differ from every model's dimension.
     * Two models can share a dimension and still be incomparable, so the flag is
     * asked directly now — and length is kept as a second line of defence, since
     * a document embedded under a different model is the case it still catches.
     */
    let comparable = !query_vec.is_empty()
        && matches!(query_kind, EmbedKind::Http)
        && loaded
            .iter()
            .all(|(_, _, _, vec, embedded)| {
                *embedded && vec.len() == query_vec.len() && !vec.is_empty()
            });
    let mut scored = Vec::new();
    for (page, heading, text, vec, _) in loaded {
        let score = if comparable {
            cosine(&query_vec, &vec)
        } else {
            lexical_score(query, &text)
        };
        scored.push(RetrievedChunk {
            page,
            heading,
            text,
            score,
        });
    }
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k);
    Ok(scored)
}

pub fn format_retrieval(chunks: &[RetrievedChunk]) -> String {
    if chunks.is_empty() {
        return String::new();
    }
    let mut out = String::from("## Retrieved from this document\n\n");
    let mut used = out.len();
    for chunk in chunks {
        let heading = chunk
            .heading
            .as_deref()
            .filter(|h| !h.is_empty())
            .unwrap_or("(untitled)");
        let block = format!("### Page {} — {}\n\n{}\n\n", chunk.page, heading, chunk.text.trim());
        if used + block.len() > RETRIEVAL_CHAR_CAP {
            break;
        }
        out.push_str(&block);
        used += block.len();
    }
    out
}

pub fn section_text(conn: &Connection, hash: &str, section_name: &str) -> Result<String> {
    let needle = section_name.trim().to_ascii_lowercase();
    if needle.is_empty() {
        anyhow::bail!("section_name is empty");
    }
    let mut stmt = conn.prepare(
        "SELECT page, heading, text FROM chunks WHERE hash = ?1 ORDER BY page, id",
    )?;
    let rows = stmt.query_map(params![hash], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut hits = Vec::new();
    for row in rows {
        let (page, heading, text) = row?;
        let head = heading.as_deref().unwrap_or("");
        if head.to_ascii_lowercase().contains(&needle) || text.to_ascii_lowercase().contains(&needle)
        {
            hits.push(format!("[page {page}] {head}\n{text}"));
        }
    }
    if hits.is_empty() {
        anyhow::bail!("no section matching {section_name:?}");
    }
    let mut out = hits.join("\n\n");
    if out.len() > RETRIEVAL_CHAR_CAP {
        out.truncate(RETRIEVAL_CHAR_CAP);
        out.push_str("\n…");
    }
    Ok(out)
}

pub fn lookup_reference(conn: &Connection, hash: &str, n: u32) -> Result<String> {
    let markers = [
        format!("[{n}]"),
        format!("({n})"),
        format!("{n}."),
    ];
    let mut stmt = conn.prepare("SELECT page, text FROM chunks WHERE hash = ?1 ORDER BY page DESC, id DESC")?;
    let rows = stmt.query_map(params![hash], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (page, text) = row?;
        let lower = text.to_ascii_lowercase();
        if !(lower.contains("reference") || lower.contains("bibliograph") || lower.contains("works cited"))
            && page < 2
        {
            continue;
        }
        for marker in &markers {
            if let Some(idx) = text.find(marker) {
                let slice: String = text.chars().skip(idx).take(600).collect();
                return Ok(format!("From page {page}:\n{slice}"));
            }
        }
    }
    anyhow::bail!("no bibliography snippet for [{n}]")
}

struct PreparedChunk {
    page: u32,
    heading: Option<String>,
    text: String,
}

fn chunk_pages(pages: &[IndexPage]) -> Vec<PreparedChunk> {
    let mut out = Vec::new();
    for page in pages {
        let heading = page.heading.clone().or_else(|| first_heading(&page.text));
        let text = page.text.trim();
        if text.is_empty() {
            continue;
        }
        if text.len() <= CHUNK_CHARS {
            out.push(PreparedChunk {
                page: page.page,
                heading: heading.clone(),
                text: text.to_string(),
            });
            continue;
        }
        let mut start = 0;
        while start < text.len() {
            let mut end = (start + CHUNK_CHARS).min(text.len());
            if end < text.len() {
                if let Some(rel) = text[start..end].rfind(|c: char| c == '.' || c == '\n') {
                    end = start + rel + 1;
                }
            }
            if end <= start {
                end = (start + CHUNK_CHARS).min(text.len());
            }
            out.push(PreparedChunk {
                page: page.page,
                heading: heading.clone(),
                text: text[start..end].trim().to_string(),
            });
            if end >= text.len() {
                break;
            }
            start = end.saturating_sub(OVERLAP_CHARS);
        }
    }
    out
}

fn first_heading(text: &str) -> Option<String> {
    for line in text.lines().take(12) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let title = rest.trim_start_matches('#').trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

/// Which scheme actually produced a set of vectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedKind {
    /// A real model answered over HTTP — cosine means what it looks like.
    Http,
    /// The 64-bucket word-count fallback. Cosine here is word overlap.
    Hashed,
}

/// Why a text is carrying word-counts rather than a model's vector.
///
/// The failure used to be discarded (`Err(_) => {}`), which is how a configured
/// model with an unreachable server looked exactly like no model at all. They
/// need different things done about them, so they are told apart here and
/// carried out to whatever is going to say so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedSkip {
    /// Nothing is configured; this is the default state, not a fault.
    NoModel,
    /// A model is configured and the request did not produce usable vectors.
    Failed(String),
}

/// One request's worth of text for the embedding endpoint.
///
/// A ceiling on a *request*, not on how much of a document may be embedded —
/// that distinction is the whole of §1b. Roughly what an endpoint will accept in
/// one call.
pub const HTTP_EMBED_MAX_CHARS: usize = 24_000;

/// Group texts into runs that each fit one request.
///
/// The ceiling bounds a *request*, never a document — mistaking the two is what
/// made every book fall through to word-counts. A text longer than the ceiling
/// on its own still gets a batch of its own rather than being dropped: a chunk
/// cannot be split without splitting its meaning, and an endpoint is far more
/// likely to accept one oversized input than the caller is to want the whole
/// document abandoned over it.
/// Also a batch ceiling, counted in texts rather than characters.
///
/// A batch is the unit progress is reported in, so its size is how coarse the
/// answer to "how far along is this?" can be. Characters alone are not enough:
/// a book chunks into ~2400-character pieces and lands ten to a request, but a
/// web page indexed from its marks can be a hundred short excerpts that all fit
/// in one — a single opaque wait reported as one tick.
///
/// This is also the closest thing available to streaming the vectors back. The
/// endpoints do not offer it — `/embeddings` and Ollama's `/api/embed` are
/// request/response JSON — so the granularity of feedback is chosen here, by
/// how much work is put in one request, rather than by the protocol.
const EMBED_BATCH_MAX_TEXTS: usize = 16;

pub fn embed_batches(texts: &[&str], ceiling: usize) -> Vec<std::ops::Range<usize>> {
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    let mut start = 0usize;
    let mut running = 0usize;
    for (i, text) in texts.iter().enumerate() {
        let len = text.len();
        let full = running + len > ceiling || i - start >= EMBED_BATCH_MAX_TEXTS;
        if i > start && full {
            out.push(start..i);
            start = i;
            running = 0;
        }
        running += len;
    }
    if start < texts.len() {
        out.push(start..texts.len());
    }
    out
}

fn embed_texts(
    cfg: &Config,
    texts: &[&str],
) -> Result<(Vec<Vec<f32>>, EmbedKind, Option<EmbedSkip>)> {
    let hashed = |why: EmbedSkip| {
        (
            texts.iter().map(|t| hashed_embedding(t)).collect::<Vec<_>>(),
            EmbedKind::Hashed,
            Some(why),
        )
    };
    let Some(model) = cfg.embed_model().filter(|m| !m.is_empty()) else {
        return Ok(hashed(EmbedSkip::NoModel));
    };

    /*
     * Several requests, not one refusal.
     *
     * This used to be `if total <= ceiling { …one request… }` with no else, so a
     * document larger than a single request skipped embedding altogether — which
     * is every book, and exactly the documents worth searching by meaning.
     *
     * All or nothing, deliberately: `retrieve` scores a document on one scale,
     * so a half-embedded set of vectors would be worse than none. §1e is where
     * partial progress becomes safe, because there it is recorded per chunk
     * rather than mixed into one answer.
     */
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
    for range in embed_batches(texts, HTTP_EMBED_MAX_CHARS) {
        let batch = &texts[range.clone()];
        match http_embed(cfg.embed_base_url(), model, batch) {
            Ok(vectors) if vectors.len() == batch.len() => out.extend(vectors),
            Ok(vectors) => {
                return Ok(hashed(EmbedSkip::Failed(format!(
                    "the endpoint returned {} vectors for {} texts",
                    vectors.len(),
                    batch.len()
                ))))
            }
            Err(err) => return Ok(hashed(EmbedSkip::Failed(format!("{err:#}")))),
        }
    }
    if out.len() != texts.len() {
        return Ok(hashed(EmbedSkip::Failed(format!(
            "collected {} vectors for {} texts",
            out.len(),
            texts.len()
        ))));
    }
    Ok((out, EmbedKind::Http, None))
}

/*
 * Two questions, two deadlines.
 *
 * "Is anything listening?" and "how long may the work take?" are different
 * questions and deserve different patience. One number for both was the bug:
 * two seconds is far under a local embedding model's cold start — the first
 * request after boot loads weights, and 5-30s is ordinary — so every first
 * request timed out, the error was swallowed below, and the document was stored
 * as word-counts without a word said. It bit hardest on the smallest document,
 * because nothing else had to go wrong.
 *
 * A chat can split this by streaming: the first token proves the server is
 * there, and everything after it is patience. An embedding request returns
 * nothing until the whole batch is done, so there is no such token — but the
 * same split exists one layer down, between opening the connection and getting
 * an answer over it.
 *
 * Connect stays short. A refused port already fails instantly at the TCP level;
 * this is for the host that is firewalled or simply gone, which otherwise hangs
 * for the full request timeout before admitting nothing was ever there.
 */
const EMBED_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// How long the work itself may take: generous while a model may still be
/// loading, less so once one has answered — a long wait on a warm endpoint means
/// stuck rather than starting.
const EMBED_COLD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const EMBED_WARM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Whether any embedding request has succeeded since the process started.
static EMBED_WARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn embed_timeout() -> std::time::Duration {
    if EMBED_WARMED.load(std::sync::atomic::Ordering::Relaxed) {
        EMBED_WARM_TIMEOUT
    } else {
        EMBED_COLD_TIMEOUT
    }
}

fn http_embed(base_url: &str, model: &str, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(EMBED_CONNECT_TIMEOUT)
        .timeout(embed_timeout())
        .build()?;
    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "model": model, "input": texts });
    let value: serde_json::Value = client.post(&url).json(&body).send()?.json()?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .context("embeddings response missing data")?;
    let mut out = Vec::new();
    for item in data {
        let embedding = item
            .get("embedding")
            .and_then(|e| e.as_array())
            .context("embedding missing")?;
        out.push(
            embedding
                .iter()
                .filter_map(|n| n.as_f64().map(|f| f as f32))
                .collect(),
        );
    }
    EMBED_WARMED.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(out)
}

fn hashed_embedding(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; HASH_DIM];
    for token in tokenize(text) {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        token.hash(&mut hasher);
        let idx = (hasher.finish() as usize) % HASH_DIM;
        v[idx] += 1.0;
    }
    l2_normalize(&mut v);
    v
}

fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 1)
        .map(|t| t.to_ascii_lowercase())
}

fn lexical_score(query: &str, text: &str) -> f32 {
    let hay = text.to_ascii_lowercase();
    let mut score = 0f32;
    for token in tokenize(query) {
        if hay.contains(&token) {
            score += 1.0;
        }
    }
    score
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0f32;
    let mut na = 0f32;
    let mut nb = 0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

fn l2_normalize(v: &mut [f32]) {
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in v {
            *x /= n;
        }
    }
}

fn encode_f32(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

fn decode_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn prefetch_k() -> usize {
    PREFETCH_K
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config::default()
    }

    fn tmp() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("lc-docs-test-{nanos}.db"))
    }

    /*
     * The failure used to be thrown away.
     *
     * `Err(_) => {}` meant a configured model behind an unreachable server was
     * indistinguishable from no model at all — same word-count vectors, same
     * silence — and the two want completely different things done about them.
     */
    #[test]
    fn no_model_is_reported_as_no_model_rather_than_a_failure() {
        let (vectors, kind, skip) = embed_texts(&cfg(), &["some prose"]).unwrap();
        assert_eq!(vectors[0].len(), HASH_DIM);
        assert!(matches!(kind, EmbedKind::Hashed));
        assert_eq!(skip, Some(EmbedSkip::NoModel));
    }

    #[test]
    fn an_unreachable_endpoint_says_so_and_keeps_the_error() {
        let mut cfg = cfg();
        cfg.llm.local.embed_model = "tiny-embed".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:1".into();
        let (_, kind, skip) = embed_texts(&cfg, &["some prose"]).unwrap();
        assert!(matches!(kind, EmbedKind::Hashed));
        match skip {
            Some(EmbedSkip::Failed(why)) => assert!(!why.is_empty(), "the cause is the point"),
            other => panic!("expected a reported failure, got {other:?}"),
        }
    }

    /*
     * Resume is a query, not a cursor.
     *
     * The unit of progress is a row, so "what is still 0?" *is* the resume —
     * there is no job record to reconcile and nothing to lose track of.
     */
    #[test]
    fn the_pass_resumes_from_whatever_is_still_unembedded() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: (1..=4)
                .map(|n| IndexPage {
                    page: n,
                    text: format!("page {n} of ordinary prose about gradients"),
                    heading: None,
                })
                .collect(),
        };
        upsert(&mut conn, "h", &body, &cfg(), false).unwrap();
        let total = status(&conn, "h").unwrap().chunk_count;
        assert!(total >= 4);

        // Nothing configured: the pass reports why and changes nothing.
        let progress = embed_pending(&mut conn, "h", &cfg(), EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!(progress.done, 0);
        assert_eq!(progress.total, total);
        assert!(progress.reason.as_deref().unwrap().contains("no embedding model"));

        // Stand in for a finished batch, the way an interrupted pass leaves it.
        conn.execute(
            "UPDATE chunks SET embedded = 1 WHERE id IN
             (SELECT id FROM chunks WHERE hash = 'h' ORDER BY id LIMIT 2)",
            [],
        )
        .unwrap();
        let progress = embed_pending(&mut conn, "h", &cfg(), EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!(progress.done, 2, "picks up where it stopped");
        assert_eq!(progress.total, total);
        assert!(!status(&conn, "h").unwrap().embedded);

        conn.execute("UPDATE chunks SET embedded = 1 WHERE hash = 'h'", []).unwrap();
        let progress = embed_pending(&mut conn, "h", &cfg(), EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!(progress.done, progress.total);
        // Finished means finished: no reason, and nothing left to ask a model.
        assert!(progress.reason.is_none());
        assert!(status(&conn, "h").unwrap().embedded);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /*
     * Changing model must not look like nothing happened.
     *
     * The dangerous case is a document *fully* embedded under the old model:
     * ask "is it finished?" before "was it the same model?" and the answer is
     * yes, the pass returns, and `retrieve` is left to discover the mismatch
     * later and drop to word matching without saying so.
     */
    #[test]
    fn a_finished_document_is_redone_when_the_model_changes() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![IndexPage { page: 1, text: "prose about gradients".into(), heading: None }],
        };
        upsert(&mut conn, "h", &body, &cfg(), false).unwrap();

        // Stand in for a completed run under one model.
        conn.execute("UPDATE chunks SET embedded = 1 WHERE hash = 'h'", []).unwrap();
        conn.execute(
            "UPDATE documents SET embed_model = 'old-embed' WHERE hash = 'h'",
            [],
        )
        .unwrap();
        assert!(status(&conn, "h").unwrap().embedded);
        assert_eq!(status(&conn, "h").unwrap().embed_model, "old-embed");

        let mut cfg = cfg();
        cfg.llm.local.embed_model = "new-embed".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:1".into();
        let progress = embed_pending(&mut conn, "h", &cfg, EMBED_BUDGET_CHUNKS).unwrap();

        // Reset rather than reported done: vectors from two models do not share
        // a space, so half of each is not half-done, it is unrankable.
        assert_eq!(progress.done, 0);
        assert!(!status(&conn, "h").unwrap().embedded);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_same_model_carries_on_rather_than_starting_again() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: (1..=3)
                .map(|n| IndexPage { page: n, text: format!("page {n}"), heading: None })
                .collect(),
        };
        upsert(&mut conn, "h", &body, &cfg(), false).unwrap();
        conn.execute(
            "UPDATE chunks SET embedded = 1 WHERE id = (SELECT MIN(id) FROM chunks WHERE hash = 'h')",
            [],
        )
        .unwrap();
        conn.execute("UPDATE documents SET embed_model = 'same' WHERE hash = 'h'", [])
            .unwrap();

        let mut cfg = cfg();
        cfg.llm.local.embed_model = "same".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:1".into();
        let progress = embed_pending(&mut conn, "h", &cfg, EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!(progress.done, 1, "finished work under the same model is kept");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_finished_document_needs_no_model_to_say_so() {
        // Completion is settled before the model is required. Reporting "no
        // model configured" about work that is already done is true and useless.
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![IndexPage { page: 1, text: "prose".into(), heading: None }],
        };
        upsert(&mut conn, "h", &body, &cfg(), false).unwrap();
        conn.execute("UPDATE chunks SET embedded = 1 WHERE hash = 'h'", []).unwrap();

        let progress = embed_pending(&mut conn, "h", &cfg(), EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!(progress.done, progress.total);
        assert!(progress.reason.is_none());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn status_reports_the_model_without_judging_it() {
        // Whether a model is *stale* depends on what is configured right now,
        // which is the caller's to know. This reports the fact only.
        let path = tmp();
        let conn = open(&path).unwrap();
        assert_eq!(status(&conn, "nothing").unwrap().embed_model, "");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_failed_batch_leaves_its_chunks_alone_so_a_retry_is_a_retry() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let mut cfg = cfg();
        cfg.llm.local.embed_model = "tiny-embed".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:1".into();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![IndexPage { page: 1, text: "some prose".into(), heading: None }],
        };
        upsert(&mut conn, "h", &body, &cfg, false).unwrap();

        let progress = embed_pending(&mut conn, "h", &cfg, EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!(progress.done, 0);
        assert!(progress.reason.is_some(), "an unreachable server is worth saying");
        // Crucially not word-counts written over the top: the chunk is still
        // pending, so trying again is trying again rather than a second helping
        // of the same fallback.
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chunks WHERE hash = 'h' AND embedded = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, progress.total as i64);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_hash_with_nothing_indexed_says_so_rather_than_claiming_completion() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let progress = embed_pending(&mut conn, "missing", &cfg(), EMBED_BUDGET_CHUNKS).unwrap();
        assert_eq!((progress.done, progress.total), (0, 0));
        // 0 of 0 is not "done" — it is "there is nothing here".
        assert!(progress.reason.is_some());
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /*
     * An index written before the column existed must still open.
     *
     * There was no migration mechanism at all — only `CREATE TABLE IF NOT
     * EXISTS`, which cannot add a column to a table that already exists. So the
     * first thing to be sure of is that a database from the previous version
     * opens, gains the column, and reports its chunks as unembedded, which is
     * true of them.
     */
    #[test]
    fn an_older_database_gains_the_column_and_claims_nothing() {
        let path = tmp();
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE documents (
                    hash TEXT PRIMARY KEY, name TEXT NOT NULL, doc_type TEXT NOT NULL,
                    page_count INTEGER NOT NULL, embedded INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL,
                    page INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL, embedding BLOB
                );
                INSERT INTO documents VALUES ('h', 'n.pdf', 'pdf', 1, 1, 0);
                INSERT INTO chunks (hash, page, heading, text, embedding)
                VALUES ('h', 1, NULL, 'older text', NULL);
                "#,
            )
            .unwrap();
        }

        let conn = open(&path).unwrap();
        assert!(has_column(&conn, "chunks", "embedded").unwrap());
        let st = status(&conn, "h").unwrap();
        assert!(st.indexed);
        assert_eq!(st.chunk_count, 1);
        // The old row said `documents.embedded = 1`. Nothing reads that any more,
        // and the chunk itself has never been through a model.
        assert!(!st.embedded, "an unembedded chunk must not report otherwise");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn opening_twice_is_not_two_migrations() {
        let path = tmp();
        let first = open(&path).unwrap();
        drop(first);
        // `ALTER TABLE ADD COLUMN` twice is an error; the version guard and the
        // column check each have to be enough on their own.
        let conn = open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /*
     * Derived, so it cannot drift.
     *
     * A stored boolean survives a crash between the last chunk's write and the
     * flag's update as a lie that nothing re-checks. A count degrades to "not
     * finished yet", which is true.
     */
    #[test]
    fn a_document_is_embedded_only_when_every_chunk_is() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![
                IndexPage { page: 1, text: "first page of prose".into(), heading: None },
                IndexPage { page: 2, text: "second page of prose".into(), heading: None },
            ],
        };
        upsert(&mut conn, "h", &body, &cfg(), false).unwrap();
        assert!(!status(&conn, "h").unwrap().embedded);

        // Mark all but one, the way an interrupted pass leaves it.
        conn.execute("UPDATE chunks SET embedded = 1 WHERE hash = 'h'", []).unwrap();
        conn.execute(
            "UPDATE chunks SET embedded = 0 WHERE id = (SELECT MAX(id) FROM chunks WHERE hash = 'h')",
            [],
        )
        .unwrap();
        assert!(
            !status(&conn, "h").unwrap().embedded,
            "one chunk short is not embedded"
        );

        conn.execute("UPDATE chunks SET embedded = 1 WHERE hash = 'h'", []).unwrap();
        assert!(status(&conn, "h").unwrap().embedded);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_document_with_no_chunks_is_not_embedded() {
        // `all` over an empty set is true, which would be the wrong answer here.
        let path = tmp();
        let conn = open(&path).unwrap();
        conn.execute(
            "INSERT INTO documents (hash, name, doc_type, page_count, embedded, updated_at)
             VALUES ('empty', 'n.pdf', 'pdf', 0, 1, 0)",
            [],
        )
        .unwrap();
        let st = status(&conn, "empty").unwrap();
        assert_eq!(st.chunk_count, 0);
        assert!(!st.embedded);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    /*
     * The ceiling bounds a request, never a document.
     *
     * Mistaking the two is the whole bug: `if total <= ceiling { …one request… }`
     * with no else meant every book — the documents most worth searching by
     * meaning — skipped embedding entirely.
     */
    #[test]
    fn a_document_larger_than_one_request_is_split_across_several() {
        let a = "a".repeat(10_000);
        let b = "b".repeat(10_000);
        let c = "c".repeat(10_000);
        let texts = [a.as_str(), b.as_str(), c.as_str()];
        let batches = embed_batches(&texts, HTTP_EMBED_MAX_CHARS);
        assert_eq!(batches, vec![0..2, 2..3]);
        // Every text lands in exactly one batch, in order, none dropped.
        let covered: Vec<usize> = batches.iter().flat_map(|r| r.clone()).collect();
        assert_eq!(covered, vec![0, 1, 2]);
    }

    #[test]
    fn one_text_over_the_ceiling_still_gets_its_own_request() {
        // A chunk cannot be split without splitting its meaning, and an endpoint
        // is likelier to accept one oversized input than the reader is to want
        // the whole document abandoned over it.
        let huge = "x".repeat(HTTP_EMBED_MAX_CHARS + 1);
        let small = "y";
        let batches = embed_batches(&[huge.as_str(), small], HTTP_EMBED_MAX_CHARS);
        assert_eq!(batches, vec![0..1, 1..2]);
    }

    /*
     * Progress is reported per batch, so a batch is how coarse progress can be.
     *
     * A hundred short marks that all fit one request would otherwise be a single
     * opaque wait — the case a web page indexed from its marks produces.
     */
    #[test]
    fn many_small_texts_are_still_split_so_progress_can_move() {
        let texts: Vec<&str> = std::iter::repeat("short").take(100).collect();
        let batches = embed_batches(&texts, HTTP_EMBED_MAX_CHARS);
        assert!(batches.len() >= 6, "one tick for a hundred marks: {batches:?}");
        assert!(batches.iter().all(|r| r.len() <= EMBED_BATCH_MAX_TEXTS));
        let covered: usize = batches.iter().map(|r| r.len()).sum();
        assert_eq!(covered, texts.len());
    }

    #[test]
    fn batching_handles_the_empty_and_single_cases() {
        assert!(embed_batches(&[], HTTP_EMBED_MAX_CHARS).is_empty());
        assert_eq!(embed_batches(&["short"], HTTP_EMBED_MAX_CHARS), vec![0..1]);
    }

    /*
     * All or nothing, on purpose.
     *
     * `retrieve` scores a document on one scale, so vectors from a half-finished
     * run would be worse than none. §1e is where partial progress becomes safe,
     * because there it is recorded per chunk rather than mixed into one answer.
     */
    #[test]
    fn a_failed_batch_takes_the_whole_document_down_to_words() {
        let mut cfg = cfg();
        cfg.llm.local.embed_model = "tiny-embed".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:1".into();
        let long = "x".repeat(HTTP_EMBED_MAX_CHARS + 1);
        let (vectors, kind, skip) = embed_texts(&cfg, &[long.as_str(), "second"]).unwrap();
        assert!(matches!(kind, EmbedKind::Hashed));
        assert!(matches!(skip, Some(EmbedSkip::Failed(_))));
        assert!(vectors.iter().all(|v| v.len() == HASH_DIM));
    }

    /// The old two seconds was under a cold model's start-up time.
    #[test]
    fn the_first_embed_of_a_run_waits_for_a_model_to_wake_up() {
        EMBED_WARMED.store(false, std::sync::atomic::Ordering::Relaxed);
        assert!(embed_timeout() >= std::time::Duration::from_secs(30));
        EMBED_WARMED.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(embed_timeout() >= std::time::Duration::from_secs(10));
        EMBED_WARMED.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    /*
     * Reaching the endpoint and waiting for its answer are separate patiences.
     *
     * A host that is firewalled rather than refusing would otherwise hang for
     * the whole request timeout before admitting nothing was ever there — the
     * one case where being generous about slow work costs you an answer about
     * something that is not running.
     */
    #[test]
    fn a_missing_host_is_not_given_a_model_s_worth_of_patience() {
        assert!(EMBED_CONNECT_TIMEOUT < EMBED_WARM_TIMEOUT);
        assert!(EMBED_CONNECT_TIMEOUT <= std::time::Duration::from_secs(5));
    }

    #[test]
    fn same_hash_and_page_count_is_idempotent() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "paper.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![IndexPage {
                page: 1,
                text: "Gradient descent minimises a loss by stepping opposite the gradient.".into(),
                heading: Some("Method".into()),
            }],
        };
        let first = upsert(&mut conn, "abc", &body, &cfg(), false).unwrap();
        let second = upsert(&mut conn, "abc", &body, &cfg(), false).unwrap();
        assert!(first.indexed);
        assert_eq!(first.chunk_count, second.chunk_count);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn retrieval_prefers_earlier_definition_over_unrelated_page() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "book.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![
                IndexPage {
                    page: 2,
                    text: "We define SGD as stochastic gradient descent: a minibatch estimate of the full gradient.".into(),
                    heading: Some("Preliminaries".into()),
                },
                IndexPage {
                    page: 40,
                    text: "The garden was full of roses and the weather was fine.".into(),
                    heading: Some("Appendix".into()),
                },
            ],
        };
        upsert(&mut conn, "book", &body, &cfg(), false).unwrap();
        let hits = retrieve(&conn, "book", "what is SGD", 2, &cfg()).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].page, 2);
        let query_vec = hashed_embedding("what is SGD");
        let chunk_vec = hashed_embedding(
            "We define SGD as stochastic gradient descent: a minibatch estimate of the full gradient.",
        );
        assert_eq!(query_vec.len(), HASH_DIM);
        assert!(cosine(&query_vec, &chunk_vec) > 0.0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn hashed_embedding_is_64dim_l2_and_stable() {
        let a = hashed_embedding("stochastic gradient descent");
        let b = hashed_embedding("stochastic gradient descent");
        assert_eq!(a.len(), HASH_DIM);
        assert_eq!(a, b);
        let norm: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
        let blob = encode_f32(&a);
        assert_eq!(decode_f32(&blob), a);
    }

    #[test]
    fn empty_embed_model_stores_hashed_vectors_and_is_not_http_embedded() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![IndexPage {
                page: 1,
                text: "alpha beta gamma delta epsilon".into(),
                heading: None,
            }],
        };
        let status = upsert(&mut conn, "h1", &body, &cfg(), false).unwrap();
        assert!(status.indexed);
        assert!(!status.embedded);
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT embedding FROM chunks WHERE hash = ?1",
                rusqlite::params!["h1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(decode_f32(&blob).len(), HASH_DIM);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn indexing_finishes_whatever_the_embed_server_is_doing() {
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let mut cfg = Config::default();
        cfg.llm.local.embed_model = "tiny-embed".into();
        cfg.llm.local.embed_base_url = "http://127.0.0.1:1".into();
        let body = IndexBody {
            name: "n.pdf".into(),
            doc_type: "pdf".into(),
            pages: vec![IndexPage {
                page: 1,
                text: "fallback still indexes when the embed server is down".into(),
                heading: None,
            }],
        };
        let status = upsert(&mut conn, "h2", &body, &cfg, false).unwrap();
        assert!(status.indexed);
        /*
         * Indexing does not depend on the embedding server at all any more.
         *
         * It used to embed inline, which tied "is this document retrievable"
         * to "is a model up and fast" — two questions with nothing to do with
         * each other. Now chunking always finishes and stores word-counts, and
         * `embed_pending` upgrades them separately.
         */
        assert!(!status.embedded);
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT embedding FROM chunks WHERE hash = ?1",
                rusqlite::params!["h2"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(decode_f32(&blob).len(), HASH_DIM);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn force_rewrites_what_idempotence_would_skip() {
        // Turning an embedding model on changes no page count, so the guard
        // would skip the one document that most needs its vectors redone.
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.md".into(),
            doc_type: "markdown".into(),
            pages: vec![IndexPage {
                page: 1,
                text: "alpha beta gamma".into(),
                heading: None,
            }],
        };
        upsert(&mut conn, "h3", &body, &cfg(), false).unwrap();
        let first: i64 = conn
            .query_row(
                "SELECT id FROM chunks WHERE hash = ?1",
                rusqlite::params!["h3"],
                |row| row.get(0),
            )
            .unwrap();

        // Same pages again: skipped, so the row is untouched.
        upsert(&mut conn, "h3", &body, &cfg(), false).unwrap();
        let same: i64 = conn
            .query_row(
                "SELECT id FROM chunks WHERE hash = ?1",
                rusqlite::params!["h3"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first, same);

        // Forced: deleted and rewritten, so the row is a new one.
        upsert(&mut conn, "h3", &body, &cfg(), true).unwrap();
        let rewritten: i64 = conn
            .query_row(
                "SELECT id FROM chunks WHERE hash = ?1",
                rusqlite::params!["h3"],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(first, rewritten);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_document_is_scored_on_one_scale() {
        /*
         * Chunks stored under an old scheme cannot be compared with a query
         * vector from a new one. Scoring per chunk sorted cosine against
         * lexical in the same list — two number lines, one ordering.
         */
        let path = tmp();
        let mut conn = open(&path).unwrap();
        let body = IndexBody {
            name: "n.md".into(),
            doc_type: "markdown".into(),
            pages: vec![
                IndexPage {
                    page: 1,
                    text: "stochastic gradient descent updates weights".into(),
                    heading: None,
                },
                IndexPage {
                    page: 2,
                    text: "unrelated chapter about kitchen plumbing".into(),
                    heading: None,
                },
            ],
        };
        upsert(&mut conn, "h4", &body, &cfg(), false).unwrap();
        // Widen one chunk's vector so the document no longer matches the query's
        // dimension — the shape a stale re-index leaves behind.
        conn.execute(
            "UPDATE chunks SET embedding = ?1 WHERE hash = ?2 AND page = 1",
            rusqlite::params![encode_f32(&vec![0.5f32; 768]), "h4"],
        )
        .unwrap();
        let hits = retrieve(&conn, "h4", "gradient descent", 2, &cfg()).unwrap();
        assert_eq!(hits.len(), 2);
        // Lexical throughout: the page that shares the words wins, and nothing
        // was scored by a cosine it could not be compared with.
        assert_eq!(hits[0].page, 1);
        assert!(hits[0].score > hits[1].score);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn prefetch_k_is_four_and_retrieval_stays_under_char_cap() {
        assert_eq!(prefetch_k(), 4);
        let chunks: Vec<RetrievedChunk> = (0..20)
            .map(|i| RetrievedChunk {
                page: i,
                heading: Some("H".into()),
                text: "x".repeat(500),
                score: 1.0,
            })
            .collect();
        let formatted = format_retrieval(&chunks);
        assert!(formatted.len() <= RETRIEVAL_CHAR_CAP + 80);
        assert!(formatted.starts_with("## Retrieved from this document"));
    }
}
