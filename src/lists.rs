use anyhow::{Context, Result};
use comfy_table::Table;
use rand::seq::SliceRandom;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::loader;

#[derive(Serialize, Deserialize)]
struct ListFile {
    name: String,
    task_ids: Vec<String>,
}

fn list_id(conn: &Connection, name: &str) -> Result<i64> {
    conn.query_row(
        "SELECT id FROM lists WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )
    .optional()?
    .with_context(|| format!("no list named {name:?} — create it with `lc list create {name}`"))
}

fn next_position(conn: &Connection, id: i64) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM list_items WHERE list_id = ?1",
        params![id],
        |r| r.get(0),
    )?)
}

pub fn create(conn: &Connection, name: &str) -> Result<bool> {
    let inserted = conn.execute("INSERT OR IGNORE INTO lists (name) VALUES (?1)", params![name])?;
    Ok(inserted > 0)
}

pub fn create_or_get(conn: &Connection, name: &str) -> Result<()> {
    if create(conn, name)? {
        println!("created list {name:?}");
    } else {
        println!("list {name:?} already exists");
    }
    Ok(())
}

pub fn delete(conn: &Connection, name: &str) -> Result<()> {
    let id = list_id(conn, name)?;
    conn.execute("DELETE FROM list_items WHERE list_id = ?1", params![id])?;
    conn.execute("DELETE FROM lists WHERE id = ?1", params![id])?;
    println!("deleted list {name:?}");
    Ok(())
}

pub fn add(conn: &Connection, name: &str, ids: &[String]) -> Result<()> {
  let added = add_tasks(conn, name, ids)?;
  println!("{added} added to {name:?}");
  Ok(())
}

/// Add tasks without printing (for TUI).
pub fn add_tasks(conn: &Connection, name: &str, ids: &[String]) -> Result<u32> {
    let id = list_id(conn, name)?;
    let mut added = 0;
    for raw in ids {
        let row = loader::resolve(conn, raw)?;
        let position = next_position(conn, id)?;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO list_items (list_id, position, task_id) VALUES (?1, ?2, ?3)",
            params![id, position, row.task_id],
        )?;
        if inserted > 0 {
            added += 1;
        }
    }
    Ok(added)
}

pub fn remove(conn: &Connection, name: &str, ids: &[String]) -> Result<()> {
    let id = list_id(conn, name)?;
    let mut removed = 0;
    for raw in ids {
        // Prefer index resolution, but fall back to the raw string so entries
        // that are no longer in the index can still be removed.
        let task_id = loader::resolve(conn, raw)
            .map(|r| r.task_id)
            .unwrap_or_else(|_| raw.clone());
        removed += conn.execute(
            "DELETE FROM list_items WHERE list_id = ?1 AND task_id = ?2",
            params![id, task_id],
        )?;
    }
    println!("{removed} removed from {name:?}");
    Ok(())
}

pub fn show(conn: &Connection, name: &str) -> Result<()> {
    let id = list_id(conn, name)?;
    let mut stmt = conn.prepare(
        "SELECT li.position, li.task_id, p.question_id, p.difficulty \
         FROM list_items li LEFT JOIN problems p ON p.task_id = li.task_id \
         WHERE li.list_id = ?1 ORDER BY li.position",
    )?;
    let rows = stmt.query_map(params![id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;

    let mut table = Table::new();
    table.load_preset(comfy_table::presets::UTF8_FULL_CONDENSED);
    table.set_header(["#", "task_id", "q#", "difficulty"]);
    let mut count = 0;
    for row in rows {
        let (position, task_id, question_id, difficulty) = row?;
        count += 1;
        table.add_row([
            position.to_string(),
            task_id,
            question_id.unwrap_or_default(),
            difficulty.unwrap_or_default(),
        ]);
    }
    if count == 0 {
        println!("list {name:?} is empty");
    } else {
        println!("{table}");
    }
    Ok(())
}

pub fn shuffle(conn: &Connection, name: &str) -> Result<()> {
    let id = list_id(conn, name)?;
    let mut task_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT task_id FROM list_items WHERE list_id = ?1 ORDER BY position")?;
        let rows = stmt.query_map(params![id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    task_ids.shuffle(&mut rand::thread_rng());

    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE list_items SET position = ?1 WHERE list_id = ?2 AND task_id = ?3",
        )?;
        for (i, task_id) in task_ids.iter().enumerate() {
            stmt.execute(params![(i + 1) as i64, id, task_id])?;
        }
    }
    tx.commit()?;
    println!("shuffled {} items in {name:?}", task_ids.len());
    Ok(())
}

pub fn export(conn: &Connection, name: &str, output: Option<&Path>) -> Result<()> {
    let id = list_id(conn, name)?;
    let task_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT task_id FROM list_items WHERE list_id = ?1 ORDER BY position")?;
        let rows = stmt.query_map(params![id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let json = serde_json::to_string_pretty(&ListFile {
        name: name.to_string(),
        task_ids,
    })?;
    match output {
        Some(path) => {
            std::fs::write(path, &json)?;
            println!("wrote {}", path.display());
        }
        None => println!("{json}"),
    }
    Ok(())
}

pub fn import(conn: &Connection, file: &Path) -> Result<()> {
    let raw = std::fs::read_to_string(file)
        .with_context(|| format!("cannot read {}", file.display()))?;
    let data: ListFile = serde_json::from_str(&raw)
        .with_context(|| format!("{} is not a valid list export", file.display()))?;

    conn.execute("INSERT OR IGNORE INTO lists (name) VALUES (?1)", params![data.name])?;
    let id = list_id(conn, &data.name)?;

    let tx = conn.unchecked_transaction()?;
    let mut added = 0;
    for task_id in &data.task_ids {
        let known: Option<String> = tx
            .query_row(
                "SELECT task_id FROM problems WHERE task_id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()?;
        if known.is_none() {
            eprintln!("warn: {task_id} is not in the index (adding anyway)");
        }
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM list_items WHERE list_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        added += tx.execute(
            "INSERT OR IGNORE INTO list_items (list_id, position, task_id) VALUES (?1, ?2, ?3)",
            params![id, position, task_id],
        )?;
    }
    tx.commit()?;
    println!("imported {added} problems into {:?}", data.name);
    Ok(())
}

pub fn ls(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT l.name, COUNT(li.task_id) FROM lists l \
         LEFT JOIN list_items li ON li.list_id = l.id \
         GROUP BY l.id ORDER BY l.name",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut count = 0;
    for row in rows {
        let (name, items) = row?;
        count += 1;
        println!("{name}  ({items} problems)");
    }
    if count == 0 {
        println!("no lists yet — `lc list create <name>`");
    }
    Ok(())
}
