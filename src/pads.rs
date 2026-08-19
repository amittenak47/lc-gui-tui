//! Historical copy of device pads: SQLite next to `docs.db`, blobs on disk.
//!
//! The tablet IndexedDB is the working copy. This database is append-friendly
//! history. A missing local row must not delete anything here. Tombstones hide
//! a pad from the live library; they do not drop snapshots or blob files.

use anyhow::{Context, Result};
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
        CREATE INDEX IF NOT EXISTS idx_whiteboard_live ON whiteboard(deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_annotate_live ON annotate(deleted_at, updated_at);
        CREATE INDEX IF NOT EXISTS idx_revisions_pad ON revisions(kind, pad_id);
        "#,
    )?;
    Ok(conn)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadKind {
    Whiteboard,
    Annotate,
}

impl PadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whiteboard => "whiteboard",
            Self::Annotate => "annotate",
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
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub footnotes: serde_json::Value,
    pub board: serde_json::Value,
    #[serde(default)]
    pub agent: serde_json::Value,
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
            "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json
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
                    footnotes_json, board_json, agent_json
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
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn list_whiteboard(conn: &Connection, archived: bool) -> Result<Vec<WhiteboardPad>> {
    let sql = if archived {
        "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json
         FROM whiteboard WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    } else {
        "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json
         FROM whiteboard WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(WhiteboardPad {
            id: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
            page_count: row.get(3)?,
            deleted_at: row.get(4)?,
            board: parse_json(&row.get::<_, String>(5)?),
            agent: parse_json(&row.get::<_, String>(6)?),
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_annotate(conn: &Connection, archived: bool) -> Result<Vec<AnnotatePad>> {
    let sql = if archived {
        "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                footnotes_json, board_json, agent_json
         FROM annotate WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    } else {
        "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                footnotes_json, board_json, agent_json
         FROM annotate WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
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
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

/// Pads touched after `since` (live or tombstoned). Ping body, not the full library.
pub fn list_changed_whiteboard(conn: &Connection, since: i64) -> Result<Vec<WhiteboardPad>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, updated_at, page_count, deleted_at, board_json, agent_json
         FROM whiteboard
         WHERE updated_at > ?1 OR ifnull(deleted_at, 0) > ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![since], |row| {
        Ok(WhiteboardPad {
            id: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
            page_count: row.get(3)?,
            deleted_at: row.get(4)?,
            board: parse_json(&row.get::<_, String>(5)?),
            agent: parse_json(&row.get::<_, String>(6)?),
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_changed_annotate(conn: &Connection, since: i64) -> Result<Vec<AnnotatePad>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, hash, doc_type, updated_at, deleted_at, source_text,
                footnotes_json, board_json, agent_json
         FROM annotate
         WHERE updated_at > ?1 OR ifnull(deleted_at, 0) > ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![since], |row| {
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
        })
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

pub fn list_changed_snapshots(conn: &Connection, since: i64) -> Result<Vec<SnapshotRow>> {
    let mut stmt = conn.prepare(
        "SELECT kind, key, tier, written_at, payload_json
         FROM snapshots
         WHERE written_at > ?1
         ORDER BY written_at DESC",
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

pub fn get_whiteboard(conn: &Connection, id: &str) -> Result<Option<WhiteboardPad>> {
    read_whiteboard(conn, id)
}

pub fn get_annotate(conn: &Connection, id: &str) -> Result<Option<AnnotatePad>> {
    read_annotate(conn, id)
}

pub fn put_whiteboard(conn: &Connection, pad: &WhiteboardPad) -> Result<PutOutcome<WhiteboardPad>> {
    let existing = read_whiteboard(conn, &pad.id)?;
    if let Some(stored) = existing.as_ref() {
        if pad.updated_at < stored.updated_at {
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

    conn.execute(
        "INSERT INTO whiteboard (id, title, updated_at, page_count, deleted_at, board_json, agent_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at,
            page_count = excluded.page_count,
            board_json = excluded.board_json,
            agent_json = excluded.agent_json",
        params![
            pad.id,
            pad.title,
            pad.updated_at,
            pad.page_count,
            existing.and_then(|row| row.deleted_at),
            json_text(&pad.board),
            json_text(&pad.agent),
        ],
    )?;
    Ok(PutOutcome::Written(
        read_whiteboard(conn, &pad.id)?.expect("just wrote"),
    ))
}

pub fn put_annotate(conn: &Connection, pad: &AnnotatePad) -> Result<PutOutcome<AnnotatePad>> {
    let existing = read_annotate(conn, &pad.id)?;
    if let Some(stored) = existing.as_ref() {
        if pad.updated_at < stored.updated_at {
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

    conn.execute(
        "INSERT INTO annotate (id, name, hash, doc_type, updated_at, deleted_at, source_text,
                               footnotes_json, board_json, agent_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            hash = excluded.hash,
            doc_type = excluded.doc_type,
            updated_at = excluded.updated_at,
            source_text = excluded.source_text,
            footnotes_json = excluded.footnotes_json,
            board_json = excluded.board_json,
            agent_json = excluded.agent_json",
        params![
            pad.id,
            pad.name,
            pad.hash,
            pad.doc_type,
            pad.updated_at,
            existing.and_then(|row| row.deleted_at),
            pad.source,
            json_text(&pad.footnotes),
            json_text(&pad.board),
            json_text(&pad.agent),
        ],
    )?;
    Ok(PutOutcome::Written(
        read_annotate(conn, &pad.id)?.expect("just wrote"),
    ))
}

pub fn tombstone(conn: &Connection, kind: PadKind, id: &str) -> Result<bool> {
    let now = now_ms();
    let table = kind.as_str();
    let n = conn.execute(
        &format!("UPDATE {table} SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL"),
        params![now, id],
    )?;
    Ok(n > 0)
}

pub fn restore(conn: &Connection, kind: PadKind, id: &str) -> Result<PutOutcome<()>> {
    let table = kind.as_str();
    let found: Option<Option<i64>> = conn
        .query_row(
            &format!("SELECT deleted_at FROM {table} WHERE id = ?1"),
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(deleted_at) = found else {
        anyhow::bail!("pad not found");
    };
    if deleted_at.is_none() {
        return Ok(PutOutcome::Written(()));
    }
    let cap = match kind {
        PadKind::Whiteboard => WHITEBOARD_LIVE_CAP,
        PadKind::Annotate => ANNOTATE_LIVE_CAP,
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

pub fn put_snapshot(conn: &Connection, row: &SnapshotRow) -> Result<()> {
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
    Ok(())
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
            source: "# hi".into(),
            footnotes: json!([{"id": "f1", "kind": "ai"}]),
            board: json!({"v": 1, "elements": []}),
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
    fn tombstone_hides_from_live_keeps_snapshots_and_blobs() {
        let path = tmp();
        let blobs = tmp_dir();
        let conn = open(&path).unwrap();
        put_whiteboard(&conn, &wb("w1", 1)).unwrap();
        put_snapshot(
            &conn,
            &SnapshotRow {
                kind: "whiteboard".into(),
                key: "w1".into(),
                tier: "2h".into(),
                written_at: 1,
                payload: json!({"tier": "2h"}),
            },
        )
        .unwrap();
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
        put_blob(&blobs, "h-file", b"pdf-bytes").unwrap();
        assert!(tombstone(&conn, PadKind::Whiteboard, "w1").unwrap());
        assert!(list_whiteboard(&conn, false).unwrap().is_empty());
        assert_eq!(list_whiteboard(&conn, true).unwrap().len(), 1);
        assert_eq!(get_snapshots(&conn, "whiteboard", "w1").unwrap().len(), 3);
        assert_eq!(get_blob(&blobs, "h-file").unwrap().unwrap(), b"pdf-bytes");
        restore(&conn, PadKind::Whiteboard, "w1").unwrap();
        assert_eq!(list_whiteboard(&conn, false).unwrap().len(), 1);
        assert!(get_whiteboard(&conn, "w1").unwrap().unwrap().deleted_at.is_none());
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(blobs);
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
                tier: "2h".into(),
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
                tier: "2h".into(),
                written_at: 12,
                payload: json!({"name": "notes.md"}),
            },
        )
        .unwrap();
        tombstone(&conn, PadKind::Whiteboard, "w1").unwrap();

        let changed_wb = list_changed_whiteboard(&conn, 20).unwrap();
        assert_eq!(
            changed_wb.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["w2", "w1"]
        );
        assert!(changed_wb.iter().any(|row| row.id == "w1" && row.deleted_at.is_some()));

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
}
