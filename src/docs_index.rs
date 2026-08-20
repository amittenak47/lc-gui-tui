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
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            page INTEGER NOT NULL,
            heading TEXT,
            text TEXT NOT NULL,
            embedding BLOB,
            FOREIGN KEY(hash) REFERENCES documents(hash) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
        CREATE INDEX IF NOT EXISTS idx_chunks_hash_page ON chunks(hash, page);
        "#,
    )?;
    Ok(conn)
}

pub fn status(conn: &Connection, hash: &str) -> Result<IndexStatus> {
    let row = conn
        .query_row(
            "SELECT page_count, embedded FROM documents WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let chunk_count = conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE hash = ?1",
        params![hash],
        |row| row.get::<_, i64>(0),
    )?;
    match row {
        Some((page_count, embedded)) => Ok(IndexStatus {
            hash: hash.to_string(),
            indexed: true,
            page_count: page_count as u32,
            chunk_count: chunk_count as u32,
            embedded: embedded != 0,
        }),
        None => Ok(IndexStatus {
            hash: hash.to_string(),
            indexed: false,
            page_count: 0,
            chunk_count: 0,
            embedded: false,
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
    cfg: &Config,
    force: bool,
) -> Result<IndexStatus> {
    let existing = status(conn, hash)?;
    if !force && existing.indexed && existing.page_count == body.pages.len() as u32 {
        return Ok(existing);
    }

    let chunks = chunk_pages(&body.pages);
    let (embeddings, kind) =
        embed_texts(cfg, &chunks.iter().map(|c| c.text.as_str()).collect::<Vec<_>>())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    /*
     * What happened, not what was configured.
     *
     * This used to read `cfg.embed_model()` — so a configured model with an
     * unreachable server stored hashed word-counts and reported them as
     * embeddings. `embed_texts` swallows the failure by design (an index that
     * exists beats one that errored), which is precisely why the flag has to
     * come back from it rather than be inferred alongside it.
     */
    let used_http = matches!(kind, EmbedKind::Http);

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
            "INSERT INTO chunks (hash, page, heading, text, embedding) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash, chunk.page as i64, chunk.heading, chunk.text, blob],
        )?;
    }
    tx.commit()?;
    status(conn, hash)
}

pub fn retrieve(conn: &Connection, hash: &str, query: &str, k: usize, cfg: &Config) -> Result<Vec<RetrievedChunk>> {
    let k = k.clamp(1, 8);
    let mut stmt = conn.prepare(
        "SELECT page, heading, text, embedding FROM chunks WHERE hash = ?1 ORDER BY page, id",
    )?;
    let rows = stmt.query_map(params![hash], |row| {
        Ok((
            row.get::<_, i64>(0)? as u32,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<Vec<u8>>>(3)?,
        ))
    })?;
    let (query_vecs, _) = embed_texts(cfg, &[query])?;
    let query_vec = query_vecs.into_iter().next().unwrap_or_default();
    let loaded: Vec<(u32, Option<String>, String, Vec<f32>)> = rows
        .map(|row| {
            row.map(|(page, heading, text, blob)| {
                (page, heading, text, blob.as_deref().map(decode_f32).unwrap_or_default())
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
    let comparable = !query_vec.is_empty()
        && loaded
            .iter()
            .all(|(_, _, _, vec)| vec.len() == query_vec.len() && !vec.is_empty());
    let mut scored = Vec::new();
    for (page, heading, text, vec) in loaded {
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

fn embed_texts(cfg: &Config, texts: &[&str]) -> Result<(Vec<Vec<f32>>, EmbedKind)> {
    const HTTP_EMBED_MAX_CHARS: usize = 24_000;
    let total: usize = texts.iter().map(|t| t.len()).sum();
    if total <= HTTP_EMBED_MAX_CHARS {
        if let Some(model) = cfg.embed_model().filter(|m| !m.is_empty()) {
            match http_embed(cfg.embed_base_url(), model, texts) {
                Ok(vectors) if vectors.len() == texts.len() => {
                    return Ok((vectors, EmbedKind::Http))
                }
                Ok(_) => {}
                Err(_) => {}
            }
        }
    }
    Ok((
        texts.iter().map(|t| hashed_embedding(t)).collect(),
        EmbedKind::Hashed,
    ))
}

fn http_embed(base_url: &str, model: &str, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
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
    fn http_embed_failure_falls_back_to_hashed() {
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
        // The flag reports what happened, not what was asked for. A configured
        // model with nothing answering on the other end stores word-counts, and
        // saying otherwise made the UI promise semantic search it did not have.
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
