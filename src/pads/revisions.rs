//! Transaction boundaries and durable hub revision allocation.
use anyhow::{ensure, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

fn transaction<T>(conn: &Connection, begin: &str, body: impl FnOnce() -> Result<T>) -> Result<T> {
    if !conn.is_autocommit() { return body(); }
    conn.execute_batch(begin)?;
    match body() {
        Ok(value) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => { let _ = conn.execute_batch("ROLLBACK"); Err(error.into()) }
        },
        Err(error) => { let _ = conn.execute_batch("ROLLBACK"); Err(error) }
    }
}

pub fn read_transaction<T>(conn: &Connection, body: impl FnOnce() -> Result<T>) -> Result<T> {
    transaction(conn, "BEGIN DEFERRED", body)
}

pub fn write_transaction<T>(conn: &Connection, body: impl FnOnce() -> Result<T>) -> Result<T> {
    transaction(conn, "BEGIN IMMEDIATE", body)
}

pub fn next_rev(conn: &Connection) -> Result<i64> {
    ensure!(!conn.is_autocommit(), "revision allocation requires a write transaction");
    conn.execute("UPDATE meta SET value = value + 1 WHERE key = 'rev_seq'", [])?;
    Ok(conn.query_row("SELECT value FROM meta WHERE key = 'rev_seq'", [], |row| row.get(0))?)
}

pub fn bump_book_head(conn: &Connection, kind: &str, id: &str) -> Result<i64> {
    let rev = next_rev(conn)?;
    conn.execute("INSERT INTO book_heads(kind,id,rev) VALUES (?1,?2,?3)
        ON CONFLICT(kind,id) DO UPDATE SET rev = excluded.rev", params![kind, id, rev])?;
    Ok(rev)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BookHead { pub kind: String, pub id: String, pub rev: i64 }

pub fn list_book_heads(conn: &Connection) -> Result<Vec<BookHead>> {
    let mut statement = conn.prepare("SELECT kind,id,rev FROM book_heads ORDER BY kind,id")?;
    let rows = statement.query_map([], |row| Ok(BookHead {
        kind: row.get(0)?, id: row.get(1)?, rev: row.get(2)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    ensure!(!conn.is_autocommit(), "migration requires a transaction");
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES('rev_seq',0);
        CREATE TABLE IF NOT EXISTS book_heads(kind TEXT NOT NULL,id TEXT NOT NULL,rev INTEGER NOT NULL,
        PRIMARY KEY(kind,id));")?;
    let sequence: i64 = conn.query_row("SELECT value FROM meta WHERE key='rev_seq'", [], |row| row.get(0))?;
    if sequence == 0 {
        // The sort key includes the complete primary key: pages sharing a stamp
        // and pad still get reproducible revisions in page-id order.
        let mut rows: Vec<(i64,String,String,String,i64,i64,i64)> = Vec::new();
        for table in ["annotate", "whiteboard", "problem", "ink_pages", "gone"] {
            let sql = match table {
                "ink_pages" => "SELECT updated_at,kind,key,page_id,rowid,rev FROM ink_pages".to_string(),
                "gone" => "SELECT gone_at,kind,id,0,rowid,rev FROM gone".to_string(),
                _ => format!("SELECT updated_at,'{table}',id,0,rowid,rev FROM {table}"),
            };
            let mut statement = conn.prepare(&sql)?;
            for row in statement.query_map([], |row| Ok((row.get(0)?, table.to_string(),
                row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))? { rows.push(row?); }
        }
        rows.sort_by(|a,b| (&a.0,&a.1,&a.2,&a.3,&a.4).cmp(&(&b.0,&b.1,&b.2,&b.3,&b.4)));
        let mut maximum = rows.iter().map(|row| row.6).max().unwrap_or(0);
        for (_,table,_,_,_,rowid,rev) in rows {
            if rev > 0 { continue; }
            maximum += 1;
            conn.execute(&format!("UPDATE {table} SET rev=?1 WHERE rowid=?2"), params![maximum,rowid])?;
        }
        conn.execute("UPDATE meta SET value=?1 WHERE key='rev_seq'", params![maximum])?;
    }
    // Reopening repairs missing heads without replacing a newer lifecycle head.
    let mut heads: Vec<(String,String,i64)> = Vec::new();
    for table in ["annotate", "whiteboard", "problem"] {
        let mut statement = conn.prepare(&format!("SELECT id,rev FROM {table}"))?;
        for row in statement.query_map([], |row| Ok((table.to_string(),row.get(0)?,row.get(1)?)))? { heads.push(row?); }
    }
    for table in ["ink_pages", "gone"] {
        let mut statement = conn.prepare(if table == "ink_pages" { "SELECT kind,key,rev FROM ink_pages" } else { "SELECT kind,id,rev FROM gone WHERE kind IN ('annotate','whiteboard','problem')" })?;
        for row in statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?)))? {
            let (kind,key,rev) = row?;
            heads.push((kind.clone(),super::ink_pad_id(&kind,&key).to_string(),rev));
        }
    }
    for (kind,id,rev) in heads {
        conn.execute("INSERT INTO book_heads(kind,id,rev) VALUES(?1,?2,?3)
            ON CONFLICT(kind,id) DO UPDATE SET rev=MAX(book_heads.rev,excluded.rev)", params![kind,id,rev])?;
    }
    Ok(())
}
