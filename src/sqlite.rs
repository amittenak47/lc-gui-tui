//! SQLite connection setup shared by `docs.db`, `pads.db`, and `problems.db`.
//!
//! Each opener used to call `Connection::open` and stop there. SQLite's
//! default journal is a single-writer lock on the whole file, and there was no
//! busy handler, so a second process — the TUI, `lc ask`, or the desktop's
//! own LAN listener next to in-process Ask — failed immediately with
//! "database is locked".
//!
//! That is not a product exclusive. The GUI and the agent are meant to share
//! the same index and embeddings. Pad sync is a different file (`pads.db`)
//! and still commits per device; WAL does not merge those writes.

use anyhow::Result;
use rusqlite::Connection;
use std::time::Duration;

/// How long a second opener waits for a short write instead of failing now.
const BUSY_MS: u32 = 10_000;

pub fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_millis(BUSY_MS as u64))?;
    // WAL lets readers proceed while another connection (or process) writes.
    // `synchronous=NORMAL` is the usual pairing; FULL is for DELETE-journal.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn file_backed_opens_as_wal() {
        let path = std::env::temp_dir().join(format!(
            "lc-sqlite-test-{}.db",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let conn = Connection::open(&path).unwrap();
        configure(&conn).unwrap();
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert!(mode.eq_ignore_ascii_case("wal"), "journal_mode={mode}");
        let timeout: i64 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, BUSY_MS as i64);
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}
