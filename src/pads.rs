//! Historical copy of device pads: SQLite next to `docs.db`, blobs on disk.
//!
//! The tablet IndexedDB is the working copy. This database is append-friendly
//! history. A missing local row must not delete anything here. Delete with a
//! seq drops the live row and snapshots; gone-ids tell peers. Local trash is
//! not stored here.

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::config::config_dir;

/// Same cap as `serve::MAX_BODY_BYTES` — kept here so this module does not
/// import the HTTP layer.
const MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;

pub const WHITEBOARD_LIVE_CAP: usize = 50;
pub const ANNOTATE_LIVE_CAP: usize = 30;

pub fn db_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("pads.db"))
}

pub fn blobs_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("pad-blobs"))
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("cannot open pads database {}", path.display()))?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS whiteboard (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            page_count INTEGER NOT NULL,
            deleted_at INTEGER,
            board_json TEXT NOT NULL,
            agent_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS annotate (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            hash TEXT NOT NULL,
            doc_type TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            source_text TEXT NOT NULL,
            footnotes_json TEXT NOT NULL,
            board_json TEXT NOT NULL,
            agent_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS problem (
            id TEXT PRIMARY KEY,
            dataset TEXT NOT NULL,
            task_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            board_json TEXT NOT NULL,
            agent_json TEXT NOT NULL,
            sync_seq INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS snapshots (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            tier TEXT NOT NULL,
            written_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (kind, key, tier)
        );
        CREATE TABLE IF NOT EXISTS revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            pad_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            written_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            prefs_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        -- Handwriting, one row per page.
        --
        -- Not a column on the pad row, for the reason `inkPageStore` exists on
        -- the device: a densely inked textbook is megabytes, and putting it in
        -- the row means every title change ships every stroke. Per page is also
        -- what makes the merge rule expressible — newest `updated_at` wins, and
        -- only for the page that actually changed.
        CREATE TABLE IF NOT EXISTS ink_pages (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            page_id INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            gz BLOB NOT NULL,
            PRIMARY KEY (kind, key, page_id)
        );
        -- Graph edges. Stated facts with ids, so the merge is a union.
        --
        -- `gone` carries the tombstone: an edge deleted on one device must not
        -- come back the next time the other device pushes its copy.
        CREATE TABLE IF NOT EXISTS edges (
            id TEXT PRIMARY KEY,
            from_type TEXT NOT NULL,
            from_id TEXT NOT NULL,
            to_type TEXT NOT NULL,
            to_id TEXT NOT NULL,
            edge_kind TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS gone (
            kind TEXT NOT NULL,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            gone_at INTEGER NOT NULL,
            PRIMARY KEY (kind, id)
        );
        CREATE INDEX IF NOT EXISTS idx_whiteboard_live ON whiteboard(deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_annotate_live ON annotate(deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_problem_updated ON problem(updated_at);
        CREATE INDEX IF NOT EXISTS idx_revisions_pad ON revisions(kind, pad_id);
        CREATE INDEX IF NOT EXISTS idx_gone_at ON gone(gone_at);
        CREATE INDEX IF NOT EXISTS idx_ink_pages_pad ON ink_pages(kind, key);
        CREATE INDEX IF NOT EXISTS idx_ink_pages_updated ON ink_pages(updated_at);
        CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_type, from_id);
        CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_type, to_id);
        CREATE INDEX IF NOT EXISTS idx_edges_updated ON edges(updated_at);
        "#,
    )?;
    ensure_column(&conn, "whiteboard", "sync_seq", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "annotate", "sync_seq", "INTEGER NOT NULL DEFAULT 0")?;
    migrate_tombstones_to_gone(&conn)?;
    Ok(conn)
}

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get(0),
    )?;
    if n == 0 {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

/// Old archive rows become gone-ids. Snapshots for those ids drop with them.
fn migrate_tombstones_to_gone(conn: &Connection) -> Result<()> {
    for kind in [PadKind::Whiteboard, PadKind::Annotate] {
        let table = kind.as_str();
        let ids: Vec<(String, i64)> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, ifnull(sync_seq, 0) FROM {table} WHERE deleted_at IS NOT NULL"
            ))?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (id, seq) in ids {
            let gone_seq = seq.max(1);
            conn.execute(
                "INSERT INTO gone (kind, id, seq, gone_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(kind, id) DO UPDATE SET
                    seq = MAX(gone.seq, excluded.seq),
                    gone_at = excluded.gone_at",
                params![kind.as_str(), id, gone_seq, now_ms()],
            )?;
            conn.execute(
                "DELETE FROM snapshots WHERE kind = ?1 AND key = ?2",
                params![kind.as_str(), id],
            )?;
            conn.execute("DELETE FROM revisions WHERE kind = ?1 AND pad_id = ?2", params![kind.as_str(), id])?;
            conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadKind {
    Whiteboard,
    Annotate,
    Problem,
}

impl PadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whiteboard => "whiteboard",
            Self::Annotate => "annotate",
            Self::Problem => "problem",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhiteboardPad {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub page_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "is_zero_seq")]
    pub sync_seq: i64,
    /// Last hub `updated_at` this device ACK'd. CAS: mismatch → 409. Not stored.
    #[serde(default, skip_serializing)]
    pub base_updated_at: Option<i64>,
    pub board: serde_json::Value,
    #[serde(default)]
    pub agent: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotatePad {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub hash: String,
    #[serde(default = "default_doc_type")]
    pub doc_type: String,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "is_zero_seq")]
    pub sync_seq: i64,
    #[serde(default, skip_serializing)]
    pub base_updated_at: Option<i64>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub footnotes: serde_json::Value,
    pub board: serde_json::Value,
    #[serde(default)]
    pub agent: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemPad {
    #[serde(default)]
    pub id: String,
    pub dataset: String,
    pub task_id: String,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "is_zero_seq")]
    pub sync_seq: i64,
    #[serde(default, skip_serializing)]
    pub base_updated_at: Option<i64>,
    pub board: serde_json::Value,
    #[serde(default)]
    pub agent: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoneRow {
    pub kind: String,
    pub id: String,
    pub seq: i64,
    pub gone_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyAck {
    pub applied: bool,
    pub seq: i64,
}

fn is_zero_seq(seq: &i64) -> bool {
    *seq == 0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRow {
    pub kind: String,
    pub key: String,
    pub tier: String,
    pub written_at: i64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicePrefs {
    #[serde(default)]
    pub id: String,
    pub role: String,
    pub prefs: serde_json::Value,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug)]
pub enum PutOutcome<T> {
    Written(T),
    Conflict(T),
    /// Pad is gone; `seq` is hub gone-seq. Seq 0 live PUT must not insert.
    Gone { seq: i64 },
    LiveCap { kind: &'static str, limit: usize },
}

fn default_doc_type() -> String {
    "markdown".into()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_text(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn parse_json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap_or(serde_json::Value::Null)
}

fn live_count(conn: &Connection, table: &str) -> Result<usize> {
    let n: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE deleted_at IS NULL"),
        [],
        |row| row.get(0),
    )?;
    Ok(n as usize)
}

fn insert_revision(
    conn: &Connection,
    kind: &str,
    pad_id: &str,
    updated_at: i64,
    payload: &serde_json::Value,
) -> Result<()> {
    conn.execute(
        "INSERT INTO revisions (kind, pad_id, updated_at, payload_json, written_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind, pad_id, updated_at, json_text(payload), now_ms()],
    )?;
    Ok(())
}

pub fn revision_count(conn: &Connection, kind: &str, pad_id: &str) -> Result<usize> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM revisions WHERE kind = ?1 AND pad_id = ?2",
        params![kind, pad_id],
        |row| row.get(0),
    )?;
    Ok(n as usize)
}

fn read_whiteboard(conn: &Connection, id: &str) -> Result<Option<WhiteboardPad>> {
    let row = conn
        .query_row(
            "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json,
                    ifnull(sync_seq, 0)
             FROM whiteboard WHERE id = ?1",
            params![id],
            |row| {
                Ok(WhiteboardPad {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    updated_at: row.get(2)?,
                    page_count: row.get(3)?,
                    deleted_at: row.get(4)?,
                    board: parse_json(&row.get::<_, String>(5)?),
                    agent: parse_json(&row.get::<_, String>(6)?),
                    sync_seq: row.get(7)?,
                    base_updated_at: None,
                })
            },
        )
        .optional()?;
    Ok(row)
}

fn read_annotate(conn: &Connection, id: &str) -> Result<Option<AnnotatePad>> {
    let row = conn
        .query_row(
            "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                    footnotes_json, board_json, agent_json, ifnull(sync_seq, 0)
             FROM annotate WHERE id = ?1",
            params![id],
            |row| {
                Ok(AnnotatePad {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    hash: row.get(2)?,
                    doc_type: row.get(3)?,
                    updated_at: row.get(4)?,
                    deleted_at: row.get(5)?,
                    source: row.get(6)?,
                    footnotes: parse_json(&row.get::<_, String>(7)?),
                    board: parse_json(&row.get::<_, String>(8)?),
                    agent: parse_json(&row.get::<_, String>(9)?),
                    sync_seq: row.get(10)?,
                    base_updated_at: None,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn list_whiteboard(conn: &Connection, archived: bool) -> Result<Vec<WhiteboardPad>> {
    let sql = if archived {
        "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json,
                ifnull(sync_seq, 0)
         FROM whiteboard WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    } else {
        "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json,
                ifnull(sync_seq, 0)
         FROM whiteboard WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map_whiteboard_row)?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_annotate(conn: &Connection, archived: bool) -> Result<Vec<AnnotatePad>> {
    let sql = if archived {
        "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                footnotes_json, board_json, agent_json, ifnull(sync_seq, 0)
         FROM annotate WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    } else {
        "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                footnotes_json, board_json, agent_json, ifnull(sync_seq, 0)
         FROM annotate WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map_annotate_row)?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn map_whiteboard_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WhiteboardPad> {
    Ok(WhiteboardPad {
        id: row.get(0)?,
        title: row.get(1)?,
        updated_at: row.get(2)?,
        page_count: row.get(3)?,
        deleted_at: row.get(4)?,
        board: parse_json(&row.get::<_, String>(5)?),
        agent: parse_json(&row.get::<_, String>(6)?),
        sync_seq: row.get(7)?,
        base_updated_at: None,
    })
}

fn map_annotate_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnnotatePad> {
    Ok(AnnotatePad {
        id: row.get(0)?,
        name: row.get(1)?,
        hash: row.get(2)?,
        doc_type: row.get(3)?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
        source: row.get(6)?,
        footnotes: parse_json(&row.get::<_, String>(7)?),
        board: parse_json(&row.get::<_, String>(8)?),
        agent: parse_json(&row.get::<_, String>(9)?),
        sync_seq: row.get(10)?,
        base_updated_at: None,
    })
}

/// Live pads touched after `since`. Gone-ids are a separate ping list.
pub fn list_changed_whiteboard(conn: &Connection, since: i64) -> Result<Vec<WhiteboardPad>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json,
                ifnull(sync_seq, 0)
         FROM whiteboard
         WHERE deleted_at IS NULL AND updated_at > ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![since], map_whiteboard_row)?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_changed_annotate(conn: &Connection, since: i64) -> Result<Vec<AnnotatePad>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                footnotes_json, board_json, agent_json, ifnull(sync_seq, 0)
         FROM annotate
         WHERE deleted_at IS NULL AND updated_at > ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![since], map_annotate_row)?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_changed_gone(conn: &Connection, since: i64) -> Result<Vec<GoneRow>> {
    let mut stmt = conn.prepare(
        "SELECT kind, id, seq, gone_at FROM gone WHERE gone_at > ?1 ORDER BY gone_at DESC",
    )?;
    let rows = stmt.query_map(params![since], |row| {
        Ok(GoneRow {
            kind: row.get(0)?,
            id: row.get(1)?,
            seq: row.get(2)?,
            gone_at: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_changed_snapshots(conn: &Connection, since: i64) -> Result<Vec<SnapshotRow>> {
    let mut stmt = conn.prepare(
        "SELECT s.kind, s.key, s.tier, s.written_at, s.payload_json
         FROM snapshots s
         WHERE s.written_at > ?1
           AND s.tier IN ('24h', '7d')
           AND (
             (s.kind = 'whiteboard' AND EXISTS (
                SELECT 1 FROM whiteboard w WHERE w.id = s.key AND w.deleted_at IS NULL
             ))
             OR (s.kind = 'annotate' AND EXISTS (
                SELECT 1 FROM annotate a WHERE a.id = s.key AND a.deleted_at IS NULL
             ))
           )
         ORDER BY s.written_at DESC",
    )?;
    let rows = stmt.query_map(params![since], |row| {
        Ok(SnapshotRow {
            kind: row.get(0)?,
            key: row.get(1)?,
            tier: row.get(2)?,
            written_at: row.get(3)?,
            payload: parse_json(&row.get::<_, String>(4)?),
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn gone_seq(conn: &Connection, kind: PadKind, id: &str) -> Result<i64> {
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM gone WHERE kind = ?1 AND id = ?2",
            params![kind.as_str(), id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(seq.unwrap_or(0))
}

fn stored_seq(conn: &Connection, kind: PadKind, id: &str) -> Result<i64> {
    let live = match kind {
        PadKind::Whiteboard => read_whiteboard(conn, id)?.map(|row| row.sync_seq).unwrap_or(0),
        PadKind::Annotate => read_annotate(conn, id)?.map(|row| row.sync_seq).unwrap_or(0),
        PadKind::Problem => read_problem(conn, id)?.map(|row| row.sync_seq).unwrap_or(0),
    };
    Ok(live.max(gone_seq(conn, kind, id)?))
}

fn clear_gone(conn: &Connection, kind: PadKind, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM gone WHERE kind = ?1 AND id = ?2",
        params![kind.as_str(), id],
    )?;
    Ok(())
}

pub fn compact_revisions(conn: &Connection, kind: &str, pad_id: &str, until_ms: i64) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM revisions WHERE kind = ?1 AND pad_id = ?2 AND updated_at <= ?3",
        params![kind, pad_id, until_ms],
    )?;
    Ok(n)
}

fn drop_snapshots_and_revisions(conn: &Connection, kind: PadKind, id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM snapshots WHERE kind = ?1 AND key = ?2",
        params![kind.as_str(), id],
    )?;
    conn.execute(
        "DELETE FROM revisions WHERE kind = ?1 AND pad_id = ?2",
        params![kind.as_str(), id],
    )?;
    Ok(())
}

/// Seq-gated delete: drop live row + snapshots. Stale seq ACKs as not applied.
pub fn delete_pad(conn: &Connection, kind: PadKind, id: &str, seq: i64) -> Result<ApplyAck> {
    conn.execute("BEGIN IMMEDIATE", [])?;
    let result = (|| {
        let stored = stored_seq(conn, kind, id)?;
        if seq < stored {
            return Ok(ApplyAck {
                applied: false,
                seq: stored,
            });
        }
        drop_snapshots_and_revisions(conn, kind, id)?;
        // Handwriting is pad content, so it goes with the pad. Left behind it
        // would be resurrected by the next device to push a page of it.
        delete_ink_pages(conn, kind.as_str(), id)?;
        let table = kind.as_str();
        conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
        conn.execute(
            "INSERT INTO gone (kind, id, seq, gone_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, gone_at = excluded.gone_at",
            params![kind.as_str(), id, seq, now_ms()],
        )?;
        Ok(ApplyAck {
            applied: true,
            seq,
        })
    })();
    match result {
        Ok(ack) => {
            conn.execute("COMMIT", [])?;
            Ok(ack)
        }
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

pub fn annotate_hash_in_use(conn: &Connection, hash: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM annotate WHERE hash = ?1",
        params![hash],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

pub fn get_whiteboard(conn: &Connection, id: &str) -> Result<Option<WhiteboardPad>> {
    read_whiteboard(conn, id)
}

pub fn get_annotate(conn: &Connection, id: &str) -> Result<Option<AnnotatePad>> {
    read_annotate(conn, id)
}

pub fn put_whiteboard(conn: &Connection, pad: &WhiteboardPad) -> Result<PutOutcome<WhiteboardPad>> {
    let existing = read_whiteboard(conn, &pad.id)?;
    let gone = gone_seq(conn, PadKind::Whiteboard, &pad.id)?;
    if gone > 0 && pad.sync_seq <= gone {
        return Ok(PutOutcome::Gone { seq: gone });
    }
    if pad.sync_seq > 0
        && pad.sync_seq < existing.as_ref().map(|row| row.sync_seq).unwrap_or(0)
    {
        if let Some(stored) = existing {
            return Ok(PutOutcome::Conflict(stored));
        }
    }
    if let Some(stored) = existing.as_ref() {
        if let Some(base) = pad.base_updated_at {
            if base != stored.updated_at {
                return Ok(PutOutcome::Conflict(stored.clone()));
            }
        } else if pad.updated_at < stored.updated_at {
            return Ok(PutOutcome::Conflict(stored.clone()));
        }
        insert_revision(
            conn,
            "whiteboard",
            &stored.id,
            stored.updated_at,
            &serde_json::to_value(stored)?,
        )?;
    } else if live_count(conn, "whiteboard")? >= WHITEBOARD_LIVE_CAP {
        return Ok(PutOutcome::LiveCap {
            kind: "whiteboard",
            limit: WHITEBOARD_LIVE_CAP,
        });
    }

    let next_seq = if pad.sync_seq > 0 {
        pad.sync_seq
    } else {
        existing.as_ref().map(|row| row.sync_seq).unwrap_or(0)
    };
    if pad.sync_seq > gone {
        clear_gone(conn, PadKind::Whiteboard, &pad.id)?;
    }

    conn.execute(
        "INSERT INTO whiteboard (id, title, updated_at, page_count, deleted_at, board_json, agent_json, sync_seq)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at,
            page_count = excluded.page_count,
            deleted_at = NULL,
            board_json = excluded.board_json,
            agent_json = excluded.agent_json,
            sync_seq = excluded.sync_seq",
        params![
            pad.id,
            pad.title,
            pad.updated_at,
            pad.page_count,
            json_text(&pad.board),
            json_text(&pad.agent),
            next_seq,
        ],
    )?;
    Ok(PutOutcome::Written(
        read_whiteboard(conn, &pad.id)?.expect("just wrote"),
    ))
}

pub fn put_annotate(conn: &Connection, pad: &AnnotatePad) -> Result<PutOutcome<AnnotatePad>> {
    let existing = read_annotate(conn, &pad.id)?;
    let gone = gone_seq(conn, PadKind::Annotate, &pad.id)?;
    if gone > 0 && pad.sync_seq <= gone {
        return Ok(PutOutcome::Gone { seq: gone });
    }
    if pad.sync_seq > 0
        && pad.sync_seq < existing.as_ref().map(|row| row.sync_seq).unwrap_or(0)
    {
        if let Some(stored) = existing {
            return Ok(PutOutcome::Conflict(stored));
        }
    }
    if let Some(stored) = existing.as_ref() {
        if let Some(base) = pad.base_updated_at {
            if base != stored.updated_at {
                return Ok(PutOutcome::Conflict(stored.clone()));
            }
        } else if pad.updated_at < stored.updated_at {
            return Ok(PutOutcome::Conflict(stored.clone()));
        }
        insert_revision(
            conn,
            "annotate",
            &stored.id,
            stored.updated_at,
            &serde_json::to_value(stored)?,
        )?;
    } else if live_count(conn, "annotate")? >= ANNOTATE_LIVE_CAP {
        return Ok(PutOutcome::LiveCap {
            kind: "annotate",
            limit: ANNOTATE_LIVE_CAP,
        });
    }

    let next_seq = if pad.sync_seq > 0 {
        pad.sync_seq
    } else {
        existing.as_ref().map(|row| row.sync_seq).unwrap_or(0)
    };
    if pad.sync_seq > gone {
        clear_gone(conn, PadKind::Annotate, &pad.id)?;
    }

    conn.execute(
        "INSERT INTO annotate (id, name, hash, doc_type, updated_at, deleted_at, source_text,
                               footnotes_json, board_json, agent_json, sync_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            hash = excluded.hash,
            doc_type = excluded.doc_type,
            updated_at = excluded.updated_at,
            deleted_at = NULL,
            source_text = excluded.source_text,
            footnotes_json = excluded.footnotes_json,
            board_json = excluded.board_json,
            agent_json = excluded.agent_json,
            sync_seq = excluded.sync_seq",
        params![
            pad.id,
            pad.name,
            pad.hash,
            pad.doc_type,
            pad.updated_at,
            pad.source,
            json_text(&pad.footnotes),
            json_text(&pad.board),
            json_text(&pad.agent),
            next_seq,
        ],
    )?;
    Ok(PutOutcome::Written(
        read_annotate(conn, &pad.id)?.expect("just wrote"),
    ))
}

pub fn get_problem(conn: &Connection, id: &str) -> Result<Option<ProblemPad>> {
    read_problem(conn, id)
}

pub fn put_problem(conn: &Connection, pad: &ProblemPad) -> Result<PutOutcome<ProblemPad>> {
    let id = if pad.id.trim().is_empty() {
        format!("{}/{}", pad.dataset.trim(), pad.task_id.trim())
    } else {
        pad.id.clone()
    };
    let mut pad = pad.clone();
    pad.id = id;
    if pad.dataset.is_empty() || pad.task_id.is_empty() {
        if let Some((dataset, task_id)) = pad.id.split_once('/') {
            if pad.dataset.is_empty() {
                pad.dataset = dataset.to_string();
            }
            if pad.task_id.is_empty() {
                pad.task_id = task_id.to_string();
            }
        }
    }
    let existing = read_problem(conn, &pad.id)?;
    let gone = gone_seq(conn, PadKind::Problem, &pad.id)?;
    if gone > 0 && pad.sync_seq <= gone {
        return Ok(PutOutcome::Gone { seq: gone });
    }
    if pad.sync_seq > 0
        && pad.sync_seq < existing.as_ref().map(|row| row.sync_seq).unwrap_or(0)
    {
        if let Some(stored) = existing {
            return Ok(PutOutcome::Conflict(stored));
        }
    }
    if let Some(stored) = existing.as_ref() {
        if let Some(base) = pad.base_updated_at {
            if base != stored.updated_at {
                return Ok(PutOutcome::Conflict(stored.clone()));
            }
        } else if pad.updated_at < stored.updated_at {
            return Ok(PutOutcome::Conflict(stored.clone()));
        }
        insert_revision(
            conn,
            "problem",
            &stored.id,
            stored.updated_at,
            &serde_json::to_value(stored)?,
        )?;
    }

    let next_seq = if pad.sync_seq > 0 {
        pad.sync_seq
    } else {
        existing.as_ref().map(|row| row.sync_seq).unwrap_or(0)
    };
    if pad.sync_seq > gone {
        clear_gone(conn, PadKind::Problem, &pad.id)?;
    }

    conn.execute(
        "INSERT INTO problem (id, dataset, task_id, updated_at, board_json, agent_json, sync_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            dataset = excluded.dataset,
            task_id = excluded.task_id,
            updated_at = excluded.updated_at,
            board_json = excluded.board_json,
            agent_json = excluded.agent_json,
            sync_seq = excluded.sync_seq",
        params![
            pad.id,
            pad.dataset,
            pad.task_id,
            pad.updated_at,
            json_text(&pad.board),
            json_text(&pad.agent),
            next_seq,
        ],
    )?;
    Ok(PutOutcome::Written(
        read_problem(conn, &pad.id)?.expect("just wrote"),
    ))
}

fn read_problem(conn: &Connection, id: &str) -> Result<Option<ProblemPad>> {
    let row = conn
        .query_row(
            "SELECT id, dataset, task_id, updated_at, board_json, agent_json, ifnull(sync_seq, 0)
             FROM problem WHERE id = ?1",
            params![id],
            |row| {
                Ok(ProblemPad {
                    id: row.get(0)?,
                    dataset: row.get(1)?,
                    task_id: row.get(2)?,
                    updated_at: row.get(3)?,
                    board: parse_json(&row.get::<_, String>(4)?),
                    agent: parse_json(&row.get::<_, String>(5)?),
                    sync_seq: row.get(6)?,
                    base_updated_at: None,
                })
            },
        )
        .optional()?;
    Ok(row)
}

fn map_problem_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProblemPad> {
    Ok(ProblemPad {
        id: row.get(0)?,
        dataset: row.get(1)?,
        task_id: row.get(2)?,
        updated_at: row.get(3)?,
        board: parse_json(&row.get::<_, String>(4)?),
        agent: parse_json(&row.get::<_, String>(5)?),
        sync_seq: row.get(6)?,
        base_updated_at: None,
    })
}

pub fn list_changed_problem(conn: &Connection, since: i64) -> Result<Vec<ProblemPad>> {
    let mut stmt = conn.prepare(
        "SELECT id, dataset, task_id, updated_at, board_json, agent_json, ifnull(sync_seq, 0)
         FROM problem
         WHERE updated_at > ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![since], map_problem_row)?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

/// Compat: bump seq and hard-delete. Prefer [`delete_pad`] with an explicit seq.
pub fn tombstone(conn: &Connection, kind: PadKind, id: &str) -> Result<bool> {
    let seq = stored_seq(conn, kind, id)?.saturating_add(1).max(1);
    Ok(delete_pad(conn, kind, id, seq)?.applied)
}

pub fn restore(conn: &Connection, kind: PadKind, id: &str) -> Result<PutOutcome<()>> {
    if kind == PadKind::Problem {
        anyhow::bail!("problem pads are not archived");
    }
    let table = kind.as_str();
    let found: Option<Option<i64>> = conn
        .query_row(
            &format!("SELECT deleted_at FROM {table} WHERE id = ?1"),
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(deleted_at) = found else {
        if gone_seq(conn, kind, id)? > 0 {
            anyhow::bail!("pad not found");
        }
        anyhow::bail!("pad not found");
    };
    if deleted_at.is_none() {
        return Ok(PutOutcome::Written(()));
    }
    let cap = match kind {
        PadKind::Whiteboard => WHITEBOARD_LIVE_CAP,
        PadKind::Annotate => ANNOTATE_LIVE_CAP,
        PadKind::Problem => 0,
    };
    if live_count(conn, table)? >= cap {
        return Ok(PutOutcome::LiveCap {
            kind: table,
            limit: cap,
        });
    }
    conn.execute(
        &format!("UPDATE {table} SET deleted_at = NULL WHERE id = ?1"),
        params![id],
    )?;
    Ok(PutOutcome::Written(()))
}

fn pad_is_live(conn: &Connection, kind: &str, key: &str) -> Result<bool> {
    let table = kind;
    if table != "whiteboard" && table != "annotate" {
        return Ok(false);
    }
    let n: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1 AND deleted_at IS NULL"),
        params![key],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

fn snapshot_node_type_ok(ty: &str) -> bool {
    matches!(ty, "annotate" | "whiteboard" | "practice" | "web" | "thread")
}

fn validate_snapshot_node(value: Option<&serde_json::Value>, end: &str) -> Result<()> {
    let node = value
        .and_then(|v| v.as_object())
        .ok_or_else(|| anyhow::anyhow!("snapshot edge {end} must be an object"))?;
    match node.get("type").and_then(|v| v.as_str()) {
        Some(ty) if snapshot_node_type_ok(ty) => {}
        _ => anyhow::bail!("snapshot edge {end} needs a known type"),
    }
    match node.get("id") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Ok(()),
        _ => anyhow::bail!("snapshot edge {end} needs id"),
    }
}

/// Shape of a snapshot payload that can restore ink, edges, and source text.
///
/// Absent fields are the old payload `{ name, board, footnotes, agent, pageCount }`.
/// Present fields must be the right type — a string in `ink` would round-trip
/// and then fail on restore, which is the silent loss this check exists to stop.
pub fn validate_snapshot_payload(payload: &serde_json::Value) -> Result<()> {
    if payload.is_null() {
        return Ok(());
    }
    let obj = payload
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("snapshot payload must be an object"))?;
    if let Some(ink) = obj.get("ink") {
        let pages = ink
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("snapshot ink must be an array"))?;
        for page in pages {
            let page = page
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("snapshot ink page must be an object"))?;
            if page.get("pageId").and_then(|v| v.as_i64()).is_none() {
                anyhow::bail!("snapshot ink page needs pageId");
            }
            if page.get("updatedAt").and_then(|v| v.as_i64()).is_none() {
                anyhow::bail!("snapshot ink page needs updatedAt");
            }
            match page.get("gz") {
                Some(serde_json::Value::String(s)) if !s.is_empty() => {}
                _ => anyhow::bail!("snapshot ink page needs gz"),
            }
        }
    }
    if let Some(edges) = obj.get("edges") {
        let edges = edges
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("snapshot edges must be an array"))?;
        for edge in edges {
            let edge = edge
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("snapshot edge must be an object"))?;
            match edge.get("id") {
                Some(serde_json::Value::String(s)) if !s.is_empty() => {}
                _ => anyhow::bail!("snapshot edge needs id"),
            }
            match edge.get("kind") {
                Some(serde_json::Value::String(s)) if !s.is_empty() => {}
                _ => anyhow::bail!("snapshot edge needs kind"),
            }
            validate_snapshot_node(edge.get("from"), "from")?;
            validate_snapshot_node(edge.get("to"), "to")?;
        }
    }
    if let Some(source) = obj.get("source") {
        if !source.is_string() {
            anyhow::bail!("snapshot source must be a string");
        }
    }
    Ok(())
}

pub fn put_snapshot(conn: &Connection, row: &SnapshotRow) -> Result<ApplyAck> {
    let kind = match row.kind.as_str() {
        "whiteboard" => PadKind::Whiteboard,
        "annotate" => PadKind::Annotate,
        _ => anyhow::bail!("unknown snapshot kind"),
    };
    validate_snapshot_payload(&row.payload)?;
    let gone = gone_seq(conn, kind, &row.key)?;
    let live = pad_is_live(conn, kind.as_str(), &row.key)?;
    if !live {
        return Ok(ApplyAck {
            applied: false,
            seq: gone,
        });
    }
    if row.tier == "2h" {
        /* restore path: live row already written */
    } else if row.tier != "24h" && row.tier != "7d" {
        anyhow::bail!("unknown snapshot tier");
    }

    conn.execute(
        "INSERT INTO snapshots (kind, key, tier, written_at, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(kind, key, tier) DO UPDATE SET
            written_at = excluded.written_at,
            payload_json = excluded.payload_json",
        params![
            row.kind,
            row.key,
            row.tier,
            row.written_at,
            json_text(&row.payload)
        ],
    )?;
    if row.tier == "24h" || row.tier == "7d" {
        compact_revisions(conn, &row.kind, &row.key, row.written_at)?;
    }
    Ok(ApplyAck {
        applied: true,
        seq: stored_seq(conn, kind, &row.key)?,
    })
}

/// One page of handwriting on the wire. `gz` is base64 of the bytes on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InkPageRow {
    pub kind: String,
    pub key: String,
    pub page_id: i64,
    pub updated_at: i64,
    pub gz: String,
}

/// What a device needs to decide whether to ask for a page: no bytes.
///
/// The same shape the chunk digest takes, and for the same reason - a ping runs
/// every fifteen seconds and must not move handwriting to discover that nothing
/// has changed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InkPageDigest {
    pub kind: String,
    pub key: String,
    pub page_id: i64,
    pub updated_at: i64,
}

fn ink_kind(kind: &str) -> Result<PadKind> {
    match kind {
        "whiteboard" => Ok(PadKind::Whiteboard),
        "annotate" => Ok(PadKind::Annotate),
        _ => anyhow::bail!("unknown ink kind"),
    }
}

pub fn list_ink_digests(conn: &Connection, since: i64) -> Result<Vec<InkPageDigest>> {
    let mut stmt = conn.prepare(
        "SELECT kind, key, page_id, updated_at FROM ink_pages
         WHERE updated_at > ?1 ORDER BY updated_at, kind, key, page_id",
    )?;
    let rows = stmt.query_map(params![since], |row| {
        Ok(InkPageDigest {
            kind: row.get(0)?,
            key: row.get(1)?,
            page_id: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_ink_pages(conn: &Connection, kind: &str, key: &str) -> Result<Vec<InkPageRow>> {
    ink_kind(kind)?;
    let mut stmt = conn.prepare(
        "SELECT kind, key, page_id, updated_at, gz FROM ink_pages
         WHERE kind = ?1 AND key = ?2 ORDER BY page_id",
    )?;
    let rows = stmt.query_map(params![kind, key], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Vec<u8>>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (kind, key, page_id, updated_at, gz) = row?;
        out.push(InkPageRow {
            kind,
            key,
            page_id,
            updated_at,
            gz: BASE64.encode(&gz),
        });
    }
    Ok(out)
}

/// Newest page wins, and a page of a deleted pad is refused.
///
/// Per page rather than per pad, so two devices writing on two pages of one
/// notebook both land. Equal `updated_at` keeps what is already here: a tie is
/// two devices that saved in the same millisecond, and taking the incoming one
/// would make the result depend on which happened to ping last.
pub fn put_ink_page(conn: &Connection, row: &InkPageRow) -> Result<ApplyAck> {
    let kind = ink_kind(&row.kind)?;
    let gone = gone_seq(conn, kind, &row.key)?;
    if !pad_is_live(conn, kind.as_str(), &row.key)? {
        return Ok(ApplyAck {
            applied: false,
            seq: gone,
        });
    }
    let bytes = BASE64
        .decode(row.gz.as_bytes())
        .context("ink page is not base64")?;
    if bytes.is_empty() {
        anyhow::bail!("ink page is empty");
    }
    let current: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM ink_pages WHERE kind = ?1 AND key = ?2 AND page_id = ?3",
            params![row.kind, row.key, row.page_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(current) = current {
        if current >= row.updated_at {
            return Ok(ApplyAck {
                applied: false,
                seq: stored_seq(conn, kind, &row.key)?,
            });
        }
    }
    conn.execute(
        "INSERT INTO ink_pages (kind, key, page_id, updated_at, gz)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(kind, key, page_id) DO UPDATE SET
            updated_at = excluded.updated_at,
            gz = excluded.gz",
        params![row.kind, row.key, row.page_id, row.updated_at, bytes],
    )?;
    Ok(ApplyAck {
        applied: true,
        seq: stored_seq(conn, kind, &row.key)?,
    })
}

pub fn delete_ink_pages(conn: &Connection, kind: &str, key: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM ink_pages WHERE kind = ?1 AND key = ?2",
        params![kind, key],
    )?;
    Ok(())
}

/// One graph edge on the wire. `payload` is the device's own JSON, kept whole.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeRow {
    pub id: String,
    pub from_type: String,
    pub from_id: String,
    pub to_type: String,
    pub to_id: String,
    pub kind: String,
    pub created_at: i64,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub updated_at: i64,
}

pub fn list_edges(conn: &Connection, since: i64) -> Result<Vec<EdgeRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, from_type, from_id, to_type, to_id, edge_kind, created_at,
                payload_json, updated_at
         FROM edges WHERE updated_at > ?1 ORDER BY updated_at, id",
    )?;
    let rows = stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, i64>(8)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, from_type, from_id, to_type, to_id, kind, created_at, payload, updated_at) = row?;
        out.push(EdgeRow {
            id,
            from_type,
            from_id,
            to_type,
            to_id,
            kind,
            created_at,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            updated_at,
        });
    }
    Ok(out)
}

/// Union on id, minus anything tombstoned.
///
/// An edge is a stated fact, so two devices that both drew it agree and there
/// is nothing to resolve. Deleting is the only real event, and `gone` already
/// models that - without consulting it, a device still holding a deleted edge
/// would put it back on its next push, forever.
pub fn put_edge(conn: &Connection, row: &EdgeRow, now: i64) -> Result<ApplyAck> {
    if row.id.trim().is_empty() {
        anyhow::bail!("edge needs an id");
    }
    let gone = edge_gone_seq(conn, &row.id)?;
    if gone > 0 {
        return Ok(ApplyAck {
            applied: false,
            seq: gone,
        });
    }
    conn.execute(
        "INSERT INTO edges (id, from_type, from_id, to_type, to_id, edge_kind,
                            created_at, payload_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO NOTHING",
        params![
            row.id,
            row.from_type,
            row.from_id,
            row.to_type,
            row.to_id,
            row.kind,
            row.created_at,
            json_text(&row.payload),
            now
        ],
    )?;
    Ok(ApplyAck {
        applied: true,
        seq: now,
    })
}

pub fn delete_edge(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute("DELETE FROM edges WHERE id = ?1", params![id])?;
    conn.execute(
        "INSERT INTO gone (kind, id, seq, gone_at) VALUES ('edge', ?1, ?2, ?2)
         ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, gone_at = excluded.gone_at",
        params![id, now],
    )?;
    Ok(())
}

pub fn edge_gone_seq(conn: &Connection, id: &str) -> Result<i64> {
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM gone WHERE kind = 'edge' AND id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(seq.unwrap_or(0))
}

pub fn list_gone_edges(conn: &Connection, since: i64) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT id FROM gone WHERE kind = 'edge' AND gone_at > ?1 ORDER BY gone_at")?;
    let rows = stmt.query_map(params![since], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_snapshots(conn: &Connection, kind: &str, key: &str) -> Result<Vec<SnapshotRow>> {
    let mut stmt = conn.prepare(
        "SELECT kind, key, tier, written_at, payload_json FROM snapshots
         WHERE kind = ?1 AND key = ?2 ORDER BY written_at DESC",
    )?;
    let rows = stmt.query_map(params![kind, key], |row| {
        Ok(SnapshotRow {
            kind: row.get(0)?,
            key: row.get(1)?,
            tier: row.get(2)?,
            written_at: row.get(3)?,
            payload: parse_json(&row.get::<_, String>(4)?),
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn safe_hash(hash: &str) -> Result<&str> {
    let trimmed = hash.trim();
    if trimmed.is_empty()
        || trimmed.len() > 180
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid document hash");
    }
    Ok(trimmed)
}

pub fn blob_path(dir: &Path, hash: &str) -> Result<PathBuf> {
    Ok(dir.join(safe_hash(hash)?))
}

pub fn put_blob(dir: &Path, hash: &str, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BLOB_BYTES {
        anyhow::bail!("blob exceeds {MAX_BLOB_BYTES} bytes");
    }
    std::fs::create_dir_all(dir)
        .with_context(|| format!("cannot create {}", dir.display()))?;
    let path = blob_path(dir, hash)?;
    std::fs::write(&path, bytes).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(())
}

pub fn get_blob(dir: &Path, hash: &str) -> Result<Option<Vec<u8>>> {
    let path = blob_path(dir, hash)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read(&path).with_context(|| {
        format!("cannot read {}", path.display())
    })?))
}

pub fn blob_exists(dir: &Path, hash: &str) -> Result<bool> {
    Ok(blob_path(dir, hash)?.exists())
}

pub fn list_devices(conn: &Connection) -> Result<Vec<DevicePrefs>> {
    let mut stmt =
        conn.prepare("SELECT id, role, prefs_json, updated_at FROM devices ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(DevicePrefs {
            id: row.get(0)?,
            role: row.get(1)?,
            prefs: parse_json(&row.get::<_, String>(2)?),
            updated_at: row.get(3)?,
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn get_device(conn: &Connection, id: &str) -> Result<Option<DevicePrefs>> {
    let row = conn
        .query_row(
            "SELECT id, role, prefs_json, updated_at FROM devices WHERE id = ?1",
            params![id],
            |row| {
                Ok(DevicePrefs {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    prefs: parse_json(&row.get::<_, String>(2)?),
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn put_device(conn: &Connection, prefs: &DevicePrefs) -> Result<DevicePrefs> {
    conn.execute(
        "INSERT INTO devices (id, role, prefs_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            role = excluded.role,
            prefs_json = excluded.prefs_json,
            updated_at = excluded.updated_at",
        params![prefs.id, prefs.role, json_text(&prefs.prefs), prefs.updated_at],
    )?;
    Ok(get_device(conn, &prefs.id)?.expect("just wrote"))
}

/// Copy prefs from an android device (else any existing) into `id` when empty.
pub fn clone_device(
    conn: &Connection,
    id: &str,
    role: &str,
) -> Result<Option<DevicePrefs>> {
    if let Some(existing) = get_device(conn, id)? {
        return Ok(Some(existing));
    }
    let devices = list_devices(conn)?;
    let source = devices
        .iter()
        .find(|d| d.role == "android")
        .or_else(|| devices.first());
    let Some(source) = source else {
        return Ok(None);
    };
    let cloned = DevicePrefs {
        id: id.to_string(),
        role: role.to_string(),
        prefs: source.prefs.clone(),
        updated_at: now_ms(),
    };
    Ok(Some(put_device(conn, &cloned)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("lc-pads-test-{nanos}.db"))
    }

    fn tmp_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("lc-pads-blobs-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wb(id: &str, updated_at: i64) -> WhiteboardPad {
        WhiteboardPad {
            id: id.into(),
            title: format!("n-{id}"),
            updated_at,
            page_count: 1,
            deleted_at: None,
            sync_seq: 0,
            base_updated_at: None,
            board: json!({"v": 1, "elements": [{"id": id}]}),
            agent: json!([{"role": "assistant"}]),
        }
    }

    fn an(id: &str, updated_at: i64) -> AnnotatePad {
        AnnotatePad {
            id: id.into(),
            name: "notes.md".into(),
            hash: "h1".into(),
            doc_type: "markdown".into(),
            updated_at,
            deleted_at: None,
            sync_seq: 0,
            base_updated_at: None,
            source: "# hi".into(),
            footnotes: json!([{"id": "f1", "kind": "ai"}]),
            board: json!({"v": 1, "elements": []}),
            agent: json!([]),
        }
    }

    fn pb(id: &str, updated_at: i64) -> ProblemPad {
        let (dataset, task_id) = id.split_once('/').unwrap();
        ProblemPad {
            id: id.into(),
            dataset: dataset.into(),
            task_id: task_id.into(),
            updated_at,
            sync_seq: 0,
            base_updated_at: None,
            board: json!({"v": 1, "elements": [{"id": "ink"}]}),
            agent: json!([]),
        }
    }

    #[test]
    fn put_then_get_round_trip_whiteboard_and_annotate() {
        let path = tmp();
        let conn = open(&path).unwrap();
        let written = match put_whiteboard(&conn, &wb("w1", 10)).unwrap() {
            PutOutcome::Written(row) => row,
            other => panic!("{other:?}"),
        };
        assert_eq!(written.title, "n-w1");
        assert_eq!(written.agent[0]["role"], "assistant");
        let got = get_whiteboard(&conn, "w1").unwrap().unwrap();
        assert_eq!(got.board["elements"][0]["id"], "w1");

        let ann = match put_annotate(&conn, &an("a1", 11)).unwrap() {
            PutOutcome::Written(row) => row,
            other => panic!("{other:?}"),
        };
        assert_eq!(ann.footnotes[0]["kind"], "ai");
        assert_eq!(get_annotate(&conn, "a1").unwrap().unwrap().source, "# hi");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn older_put_is_conflict_and_keeps_a_revision() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 20)).unwrap();
        match put_whiteboard(&conn, &wb("w1", 30)).unwrap() {
            PutOutcome::Written(_) => {}
            other => panic!("{other:?}"),
        }
        match put_whiteboard(&conn, &wb("w1", 25)).unwrap() {
            PutOutcome::Conflict(row) => assert_eq!(row.updated_at, 30),
            other => panic!("{other:?}"),
        }
        assert_eq!(revision_count(&conn, "whiteboard", "w1").unwrap(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_pad_drops_snapshots_seq_restore_wins() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "24h".into(),
                written_at: 2,
                payload: json!({"tier": "24h"}),
            },
        )
        .unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "7d".into(),
                written_at: 3,
                payload: json!({"tier": "7d"}),
            },
        )
        .unwrap();
        let ack = delete_pad(&conn, PadKind::Whiteboard, "w1", 5).unwrap();
        assert!(ack.applied);
        assert_eq!(ack.seq, 5);
        assert!(get_whiteboard(&conn, "w1").unwrap().is_none());
        assert!(get_snapshots(&conn, "whiteboard", "w1").unwrap().is_empty());
        assert_eq!(list_changed_gone(&conn, 0).unwrap()[0].id, "w1");

        let stale = delete_pad(&conn, PadKind::Whiteboard, "w1", 4).unwrap();
        assert!(!stale.applied);
        assert_eq!(stale.seq, 5);

        let mut restored = wb("w1", 10);
        restored.sync_seq = 6;
        match put_whiteboard(&conn, &restored).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.sync_seq, 6),
            other => panic!("{other:?}"),
        }
        assert!(get_whiteboard(&conn, "w1").unwrap().is_some());
        let late = delete_pad(&conn, PadKind::Whiteboard, "w1", 5).unwrap();
        assert!(!late.applied);
        assert!(get_whiteboard(&conn, "w1").unwrap().is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn restore_then_delete_lower_seq_is_noop() {
        let path = tmp();
        let conn = open(&path).unwrap();
        let mut pad = wb("w1", 1);
        pad.sync_seq = 6;
        put_whiteboard(&conn, &pad).unwrap();
        let ack = delete_pad(&conn, PadKind::Whiteboard, "w1", 5).unwrap();
        assert!(!ack.applied);
        assert!(get_whiteboard(&conn, "w1").unwrap().is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_24h_compacts_revisions() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_whiteboard(&conn, &wb("w1", 2)).unwrap();
        put_whiteboard(&conn, &wb("w1", 3)).unwrap();
        assert_eq!(revision_count(&conn, "whiteboard", "w1").unwrap(), 2);
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "24h".into(),
                written_at: 2,
                payload: json!({"tier": "24h"}),
            },
        )
        .unwrap();
        assert_eq!(revision_count(&conn, "whiteboard", "w1").unwrap(), 0);
        assert_eq!(get_whiteboard(&conn, "w1").unwrap().unwrap().updated_at, 3);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fork_annotate_ids_share_hash_delete_one() {
        let path = tmp();
        let blobs = tmp_dir();
        let conn = open(&path).unwrap();
        let mut a1 = an("a1", 1);
        a1.hash = "pdf1".into();
        let mut a2 = an("a2", 2);
        a2.hash = "pdf1".into();
        put_annotate(&conn, &a1).unwrap();
        put_annotate(&conn, &a2).unwrap();
        put_blob(&blobs, "pdf1", b"bytes").unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "annotate".into(),
                key: "a1".into(),
                tier: "24h".into(),
                written_at: 3,
                payload: json!({"id": "a1"}),
            },
        )
        .unwrap();
        assert!(get_snapshots(&conn, "annotate", "a2").unwrap().is_empty());
        delete_pad(&conn, PadKind::Annotate, "a1", 1).unwrap();
        assert!(get_annotate(&conn, "a1").unwrap().is_none());
        assert!(get_annotate(&conn, "a2").unwrap().is_some());
        assert!(annotate_hash_in_use(&conn, "pdf1").unwrap());
        delete_pad(&conn, PadKind::Annotate, "a2", 1).unwrap();
        assert!(!annotate_hash_in_use(&conn, "pdf1").unwrap());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(blobs);
    }

    #[test]
    fn snapshot_rejected_after_delete() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        delete_pad(&conn, PadKind::Whiteboard, "w1", 1).unwrap();
        let ack = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "24h".into(),
                written_at: 9,
                payload: json!({}),
            },
        )
        .unwrap();
        assert!(!ack.applied);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn blob_round_trip_and_missing_is_none() {
        let dir = tmp_dir();
        put_blob(&dir, "abc", b"hello").unwrap();
        assert_eq!(get_blob(&dir, "abc").unwrap().unwrap(), b"hello");
        assert!(get_blob(&dir, "nope").unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prefs_seed_clone_desktop_from_android_without_clobber() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_device(
            &conn,
            &DevicePrefs {
                id: "tab".into(),
                role: "android".into(),
                prefs: json!({"handedness": "left"}),
                updated_at: 1,
            },
        )
        .unwrap();
        let cloned = clone_device(&conn, "desk", "desktop").unwrap().unwrap();
        assert_eq!(cloned.prefs["handedness"], "left");
        put_device(
            &conn,
            &DevicePrefs {
                id: "tab".into(),
                role: "android".into(),
                prefs: json!({"handedness": "right"}),
                updated_at: 2,
            },
        )
        .unwrap();
        assert_eq!(
            get_device(&conn, "desk").unwrap().unwrap().prefs["handedness"],
            "left"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ping_lists_whiteboard_annotate_snapshots_and_tombstones() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 10)).unwrap();
        put_whiteboard(&conn, &wb("w2", 40)).unwrap();
        put_annotate(&conn, &an("a1", 15)).unwrap();
        put_annotate(&conn, &an("a2", 50)).unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w2".into(),
                tier: "24h".into(),
                written_at: 45,
                payload: json!({"name": "n-w2"}),
            },
        )
        .unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "annotate".into(),
                key: "a1".into(),
                tier: "24h".into(),
                written_at: 12,
                payload: json!({"name": "notes.md"}),
            },
        )
        .unwrap();
        tombstone(&conn, PadKind::Whiteboard, "w1").unwrap();

        let changed_wb = list_changed_whiteboard(&conn, 20).unwrap();
        assert_eq!(
            changed_wb.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["w2"]
        );
        let gone = list_changed_gone(&conn, 0).unwrap();
        assert!(gone.iter().any(|row| row.id == "w1" && row.kind == "whiteboard"));

        let changed_an = list_changed_annotate(&conn, 20).unwrap();
        assert_eq!(changed_an.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["a2"]);

        let snaps = list_changed_snapshots(&conn, 20).unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].key, "w2");

        let all = list_changed_annotate(&conn, 0).unwrap();
        assert_eq!(all.len(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fifty_first_live_whiteboard_is_rejected_tombstones_do_not_count() {
        let path = tmp();
        let conn = open(&path).unwrap();
        for i in 0..WHITEBOARD_LIVE_CAP {
            match put_whiteboard(&conn, &wb(&format!("w{i}"), i as i64)).unwrap() {
                PutOutcome::Written(_) => {}
                other => panic!("{other:?}"),
            }
        }
        match put_whiteboard(&conn, &wb("extra", 999)).unwrap() {
            PutOutcome::LiveCap { limit, .. } => assert_eq!(limit, WHITEBOARD_LIVE_CAP),
            other => panic!("{other:?}"),
        }
        tombstone(&conn, PadKind::Whiteboard, "w0").unwrap();
        match put_whiteboard(&conn, &wb("extra", 1000)).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.id, "extra"),
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_7d_compacts_revisions() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_whiteboard(&conn, &wb("w1", 8)).unwrap();
        put_whiteboard(&conn, &wb("w1", 12)).unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "7d".into(),
                written_at: 10,
                payload: json!({"tier": "7d"}),
            },
        )
        .unwrap();
        assert_eq!(revision_count(&conn, "whiteboard", "w1").unwrap(), 0);
        assert_eq!(get_whiteboard(&conn, "w1").unwrap().unwrap().updated_at, 12);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_2h_stays_off_ping_until_restore() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "2h".into(),
                written_at: 50,
                payload: json!({"tier": "2h"}),
            },
        )
        .unwrap();
        assert!(list_changed_snapshots(&conn, 0).unwrap().is_empty());
        delete_pad(&conn, PadKind::Whiteboard, "w1", 1).unwrap();
        let rejected = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "2h".into(),
                written_at: 60,
                payload: json!({"tier": "2h"}),
            },
        )
        .unwrap();
        assert!(!rejected.applied);
        let mut restored = wb("w1", 70);
        restored.sync_seq = 2;
        put_whiteboard(&conn, &restored).unwrap();
        let ack = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "2h".into(),
                written_at: 71,
                payload: json!({"tier": "2h"}),
            },
        )
        .unwrap();
        assert!(ack.applied);
        let snaps = get_snapshots(&conn, "whiteboard", "w1").unwrap();
        assert!(snaps.iter().any(|row| row.tier == "2h"));
        assert!(list_changed_snapshots(&conn, 0)
            .unwrap()
            .iter()
            .all(|row| row.tier != "2h"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn idle_since_now_is_empty() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 10)).unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "24h".into(),
                written_at: 10,
                payload: json!({}),
            },
        )
        .unwrap();
        assert!(list_changed_whiteboard(&conn, 10).unwrap().is_empty());
        assert!(list_changed_snapshots(&conn, 10).unwrap().is_empty());
        assert!(list_changed_gone(&conn, 10).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cas_mismatch_keeps_hub_even_when_put_stamp_is_newer() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 100)).unwrap();
        let mut stale = wb("w1", 999);
        stale.base_updated_at = Some(1);
        match put_whiteboard(&conn, &stale).unwrap() {
            PutOutcome::Conflict(row) => assert_eq!(row.updated_at, 100),
            other => panic!("{other:?}"),
        }
        assert_eq!(get_whiteboard(&conn, "w1").unwrap().unwrap().updated_at, 100);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn problem_cas_mismatch_keeps_hub() {
        let path = tmp();
        let conn = open(&path).unwrap();
        let first = pb("leetcode/two-sum", 100);
        match put_problem(&conn, &first).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.updated_at, 100),
            other => panic!("{other:?}"),
        }
        let mut stale = pb("leetcode/two-sum", 999);
        stale.base_updated_at = Some(1);
        match put_problem(&conn, &stale).unwrap() {
            PutOutcome::Conflict(row) => assert_eq!(row.updated_at, 100),
            other => panic!("{other:?}"),
        }
        let mut ok = pb("leetcode/two-sum", 200);
        ok.base_updated_at = Some(100);
        match put_problem(&conn, &ok).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.updated_at, 200),
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn problem_put_is_visible_to_a_peer_ping() {
        let path = tmp();
        let conn = open(&path).unwrap();
        match put_problem(&conn, &pb("leetcode/two-sum", 100)).unwrap() {
            PutOutcome::Written(_) => {}
            other => panic!("{other:?}"),
        }
        let changed = list_changed_problem(&conn, 0).unwrap();
        assert!(
            changed.iter().any(|row| row.id == "leetcode/two-sum"
                && row.board["elements"][0]["id"] == "ink"),
            "{changed:?}"
        );
        assert!(list_changed_problem(&conn, 100).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn problem_seq_zero_put_after_delete_does_not_restore() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_problem(&conn, &pb("leetcode/two-sum", 1)).unwrap();
        delete_pad(&conn, PadKind::Problem, "leetcode/two-sum", 5).unwrap();
        assert!(get_problem(&conn, "leetcode/two-sum").unwrap().is_none());
        match put_problem(&conn, &pb("leetcode/two-sum", 999)).unwrap() {
            PutOutcome::Gone { seq } => assert_eq!(seq, 5),
            other => panic!("{other:?}"),
        }
        assert!(get_problem(&conn, "leetcode/two-sum").unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cas_match_writes_even_when_wall_clock_is_behind() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 200)).unwrap();
        let mut behind = wb("w1", 50);
        behind.base_updated_at = Some(200);
        match put_whiteboard(&conn, &behind).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.updated_at, 50),
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn seq_zero_put_after_delete_does_not_resurrect() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        delete_pad(&conn, PadKind::Whiteboard, "w1", 5).unwrap();
        match put_whiteboard(&conn, &wb("w1", 999)).unwrap() {
            PutOutcome::Gone { seq } => assert_eq!(seq, 5),
            other => panic!("{other:?}"),
        }
        assert!(get_whiteboard(&conn, "w1").unwrap().is_none());
        let mut restored = wb("w1", 10);
        restored.sync_seq = 6;
        match put_whiteboard(&conn, &restored).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.sync_seq, 6),
            other => panic!("{other:?}"),
        }
        assert!(get_whiteboard(&conn, "w1").unwrap().is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cas_and_gone_are_per_annotate_id() {
        let path = tmp();
        let conn = open(&path).unwrap();
        let mut a1 = an("a1", 10);
        a1.hash = "pdf1".into();
        let mut a2 = an("a2", 10);
        a2.hash = "pdf1".into();
        put_annotate(&conn, &a1).unwrap();
        put_annotate(&conn, &a2).unwrap();
        delete_pad(&conn, PadKind::Annotate, "a1", 1).unwrap();
        match put_annotate(&conn, &a1).unwrap() {
            PutOutcome::Gone { seq } => assert_eq!(seq, 1),
            other => panic!("{other:?}"),
        }
        let mut a2_next = a2.clone();
        a2_next.updated_at = 20;
        a2_next.base_updated_at = Some(10);
        match put_annotate(&conn, &a2_next).unwrap() {
            PutOutcome::Written(row) => assert_eq!(row.updated_at, 20),
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_file(path);
    }

    fn ink(kind: &str, key: &str, page: i64, at: i64, body: &str) -> InkPageRow {
        InkPageRow {
            kind: kind.into(),
            key: key.into(),
            page_id: page,
            updated_at: at,
            gz: BASE64.encode(body.as_bytes()),
        }
    }

    fn edge(id: &str, to: &str) -> EdgeRow {
        EdgeRow {
            id: id.into(),
            from_type: "whiteboard".into(),
            from_id: "w1".into(),
            to_type: "annotate".into(),
            to_id: to.into(),
            kind: "picker".into(),
            created_at: 1,
            payload: json!({ "id": id }),
            updated_at: 0,
        }
    }

    #[test]
    fn two_devices_writing_on_two_pages_both_land() {
        // The case per-page exists for. A pad-wide newest-wins would have thrown
        // one of these away for no reason: they do not touch the same paper.
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        assert!(put_ink_page(&conn, &ink("whiteboard", "w1", 1, 10, "pc"))
            .unwrap()
            .applied);
        assert!(put_ink_page(&conn, &ink("whiteboard", "w1", 2, 9, "tablet"))
            .unwrap()
            .applied);
        let pages = get_ink_pages(&conn, "whiteboard", "w1").unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].page_id, 1);
        assert_eq!(pages[1].page_id, 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_newer_page_wins_and_the_older_one_is_refused() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_ink_page(&conn, &ink("whiteboard", "w1", 1, 20, "newer")).unwrap();
        let ack = put_ink_page(&conn, &ink("whiteboard", "w1", 1, 5, "older")).unwrap();
        assert!(!ack.applied, "an older page must not overwrite a newer one");
        let pages = get_ink_pages(&conn, "whiteboard", "w1").unwrap();
        assert_eq!(BASE64.decode(pages[0].gz.as_bytes()).unwrap(), b"newer");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_tie_keeps_what_is_already_here() {
        // Two devices saving in the same millisecond. Taking the incoming one
        // would make the result depend on which pinged last, which is not a
        // rule so much as a coin toss.
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_ink_page(&conn, &ink("whiteboard", "w1", 1, 7, "first")).unwrap();
        let ack = put_ink_page(&conn, &ink("whiteboard", "w1", 1, 7, "second")).unwrap();
        assert!(!ack.applied);
        let pages = get_ink_pages(&conn, "whiteboard", "w1").unwrap();
        assert_eq!(BASE64.decode(pages[0].gz.as_bytes()).unwrap(), b"first");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ink_for_a_deleted_pad_is_refused_and_never_resurrects_it() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_ink_page(&conn, &ink("whiteboard", "w1", 1, 10, "strokes")).unwrap();
        delete_pad(&conn, PadKind::Whiteboard, "w1", 5).unwrap();
        assert!(get_ink_pages(&conn, "whiteboard", "w1").unwrap().is_empty());
        let ack = put_ink_page(&conn, &ink("whiteboard", "w1", 1, 99, "late")).unwrap();
        assert!(!ack.applied, "a pad in the grave stays there");
        assert!(get_ink_pages(&conn, "whiteboard", "w1").unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_ink_digest_carries_no_bytes_and_answers_since() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_ink_page(&conn, &ink("whiteboard", "w1", 1, 10, "one")).unwrap();
        put_ink_page(&conn, &ink("whiteboard", "w1", 2, 30, "two")).unwrap();
        let all = list_ink_digests(&conn, 0).unwrap();
        assert_eq!(all.len(), 2);
        let recent = list_ink_digests(&conn, 20).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].page_id, 2);
        assert_eq!(recent[0].updated_at, 30);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn edges_union_on_id() {
        let path = tmp();
        let conn = open(&path).unwrap();
        assert!(put_edge(&conn, &edge("e1", "a1"), 10).unwrap().applied);
        assert!(put_edge(&conn, &edge("e1", "a1"), 20).unwrap().applied);
        assert!(put_edge(&conn, &edge("e2", "a2"), 30).unwrap().applied);
        let rows = list_edges(&conn, 0).unwrap();
        assert_eq!(rows.len(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_deleted_edge_does_not_come_back_when_the_other_device_pushes_it() {
        // Without the tombstone the loser of a delete re-states the edge on its
        // next ping, and the two devices push it back and forth forever.
        let path = tmp();
        let conn = open(&path).unwrap();
        put_edge(&conn, &edge("e1", "a1"), 10).unwrap();
        delete_edge(&conn, "e1", 20).unwrap();
        let ack = put_edge(&conn, &edge("e1", "a1"), 30).unwrap();
        assert!(!ack.applied);
        assert!(list_edges(&conn, 0).unwrap().is_empty());
        assert_eq!(list_gone_edges(&conn, 0).unwrap(), vec!["e1".to_string()]);
        let _ = std::fs::remove_file(path);
    }

    /// §2a/§2e, as far as a test can take it.
    ///
    /// The real drill needs two machines and a wiped profile; what can be
    /// checked here is the half that used to be silently empty — whether the
    /// hub is *holding* everything a rebuilt device would ask for. Before §2b
    /// and §2c this failed on ink and edges, which is the whole reason Part 2
    /// exists. Source text and marks are checked with them so a regression in
    /// any one of the four shows up as a named failure rather than a vague one.
    #[test]
    fn the_hub_holds_everything_a_wiped_device_asks_for() {
        let path = tmp();
        let conn = open(&path).unwrap();

        // A pad with all of it: marks, a coach thread, handwriting, and an edge
        // to a second pad.
        let mut pad = an("a1", 10);
        pad.source = "# Gradients\n\nthe chain rule".into();
        pad.footnotes = json!([{ "id": "f1", "excerpt": "the chain rule" }]);
        pad.agent = json!([{ "role": "user", "text": "why" }]);
        put_annotate(&conn, &pad).unwrap();
        put_annotate(&conn, &an("a2", 10)).unwrap();

        put_ink_page(&conn, &ink("annotate", "a1", 1, 11, "strokes")).unwrap();
        put_edge(
            &conn,
            &EdgeRow {
                id: "picker|annotate:a1|annotate:a2".into(),
                from_type: "annotate".into(),
                from_id: "a1".into(),
                to_type: "annotate".into(),
                to_id: "a2".into(),
                kind: "picker".into(),
                created_at: 9,
                payload: json!({ "id": "picker|annotate:a1|annotate:a2" }),
                updated_at: 0,
            },
            12,
        )
        .unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "annotate".into(),
                key: "a1".into(),
                tier: "24h".into(),
                written_at: 13,
                payload: json!({
                    "name": "notes.md",
                    "source": "# Gradients\n\nthe chain rule",
                    "ink": [{ "pageId": 1, "updatedAt": 11, "gz": "c3Ryb2tlcw==" }],
                }),
            },
        )
        .unwrap();

        // Now ask the way a device with an empty profile would: everything
        // since the beginning of time.
        let pads = list_annotate(&conn, false).unwrap();
        let mine = pads.iter().find(|row| row.id == "a1").unwrap();
        assert_eq!(mine.source, "# Gradients\n\nthe chain rule", "source text");
        assert_eq!(mine.footnotes[0]["id"], "f1", "marks");
        assert_eq!(mine.agent[0]["role"], "user", "coach thread");

        let ink_pages = get_ink_pages(&conn, "annotate", "a1").unwrap();
        assert_eq!(ink_pages.len(), 1, "handwriting");
        assert_eq!(
            BASE64.decode(ink_pages[0].gz.as_bytes()).unwrap(),
            b"strokes"
        );

        let edges = list_edges(&conn, 0).unwrap();
        assert_eq!(edges.len(), 1, "graph edge");
        assert_eq!(edges[0].to_id, "a2");

        let snaps = get_snapshots(&conn, "annotate", "a1").unwrap();
        assert_eq!(snaps.len(), 1, "snapshot tier");
        assert_eq!(snaps[0].payload["ink"][0]["pageId"], 1);

        // And the digests a ping would carry, so the device knows to ask.
        let digests = list_ink_digests(&conn, 0).unwrap();
        assert_eq!(digests.len(), 1);
        assert_eq!(digests[0].key, "a1");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pads_schema_version_stays_unpinned() {
        let path = tmp();
        let conn = open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0, "no schema change yet, so nothing to pin");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_round_trips_ink_edges_and_source() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_annotate(&conn, &an("a1", 1)).unwrap();
        let payload = json!({
            "name": "notes.md",
            "source": "# hi\n\nmore",
            "ink": [{ "pageId": 3, "updatedAt": 99, "gz": "YQ==" }],
            "edges": [{ "id": "picker|annotate:a1|annotate:a2", "from": { "type": "annotate", "id": "a1" }, "to": { "type": "annotate", "id": "a2" }, "kind": "picker", "createdAt": 1 }]
        });
        let ack = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "annotate".into(),
                key: "a1".into(),
                tier: "24h".into(),
                written_at: 10,
                payload: payload.clone(),
            },
        )
        .unwrap();
        assert!(ack.applied);
        let got = get_snapshots(&conn, "annotate", "a1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].payload["source"], "# hi\n\nmore");
        assert_eq!(got[0].payload["ink"][0]["pageId"], 3);
        assert_eq!(got[0].payload["ink"][0]["gz"], "YQ==");
        assert_eq!(got[0].payload["edges"][0]["id"], "picker|annotate:a1|annotate:a2");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_rejects_a_malformed_ink_payload() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        let err = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "24h".into(),
                written_at: 2,
                payload: json!({ "ink": "nope" }),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("ink must be an array"), "{err:#}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_rejects_an_edge_without_ends() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_annotate(&conn, &an("a1", 1)).unwrap();
        let err = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "annotate".into(),
                key: "a1".into(),
                tier: "24h".into(),
                written_at: 2,
                payload: json!({ "edges": [{ "id": "orphan" }] }),
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("kind") || err.to_string().contains("from"),
            "{err:#}"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn snapshot_still_accepts_the_old_payload_shape() {
        let path = tmp();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        let ack = put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "24h".into(),
                written_at: 2,
                payload: json!({ "name": "n-w1", "board": { "v": 1 } }),
            },
        )
        .unwrap();
        assert!(ack.applied);
        let _ = std::fs::remove_file(path);
    }
}
