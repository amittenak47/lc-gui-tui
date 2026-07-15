use anyhow::{bail, Result};
use rusqlite::{params, Connection};

use crate::index::{row_to_problem, ProblemRow, ROW_COLUMNS};

/// Resolve a user-supplied id — exact `task_id` slug, LeetCode `question_id`,
/// or a unique `task_id` prefix — to an indexed problem row.
pub fn resolve(conn: &Connection, id: &str) -> Result<ProblemRow> {
    if let Some(row) = find_one(conn, "task_id = ?1", id)? {
        return Ok(row);
    }
    if let Some(row) = find_one(conn, "question_id = ?1", id)? {
        return Ok(row);
    }
    let matches = find_many(conn, "task_id LIKE ?1", &format!("{id}%"), 6)?;
    match matches.len() {
        0 => bail!(
            "no indexed problem matches {id:?} — check the id, or run `lc index` if the corpus changed"
        ),
        1 => Ok(matches.into_iter().next().unwrap()),
        _ => bail!(
            "{id:?} is ambiguous; candidates:\n  {}",
            matches
                .iter()
                .map(|m| m.task_id.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        ),
    }
}

fn find_one(conn: &Connection, clause: &str, value: &str) -> Result<Option<ProblemRow>> {
    let mut rows = find_many(conn, clause, value, 1)?;
    Ok(rows.pop())
}

fn find_many(
    conn: &Connection,
    clause: &str,
    value: &str,
    limit: u32,
) -> Result<Vec<ProblemRow>> {
    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM problems WHERE {clause} ORDER BY task_id LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![value], row_to_problem)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
