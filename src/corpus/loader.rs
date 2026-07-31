use anyhow::{bail, Result};
use rusqlite::{params, Connection};

use crate::dataset::{self, Dataset};
use crate::index::{row_reader, ProblemRow, ROW_COLUMNS};

/// Resolve a user-supplied id — exact `task_id` slug, LeetCode `question_id`,
/// or a unique `task_id` prefix — to a row in the default corpus.
pub fn resolve(conn: &Connection, id: &str) -> Result<ProblemRow> {
    resolve_in(conn, dataset::default(), id)
}

/// Same, scoped to one dataset. Ids collide across corpora (`two-sum` is in
/// three of them), so the dataset is part of the question, not a hint.
pub fn resolve_in(conn: &Connection, dataset: &'static Dataset, id: &str) -> Result<ProblemRow> {
    if let Some(row) = find_one(conn, dataset, "task_id = ?1", id)? {
        return Ok(row);
    }
    if let Some(row) = find_one(conn, dataset, "question_id = ?1", id)? {
        return Ok(row);
    }
    let matches = find_many(conn, dataset, "task_id LIKE ?1", &format!("{id}%"), 6)?;
    match matches.len() {
        0 => bail!(
            "no indexed problem matches {id:?} in dataset {} — check the id, or run \
             `lc index` if the corpus changed",
            dataset.id
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

fn find_one(
    conn: &Connection,
    dataset: &'static Dataset,
    clause: &str,
    value: &str,
) -> Result<Option<ProblemRow>> {
    let mut rows = find_many(conn, dataset, clause, value, 1)?;
    Ok(rows.pop())
}

fn find_many(
    conn: &Connection,
    dataset: &'static Dataset,
    clause: &str,
    value: &str,
    limit: u32,
) -> Result<Vec<ProblemRow>> {
    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM {} WHERE {clause} ORDER BY task_id LIMIT {limit}",
        dataset.table
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![value], row_reader(dataset))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
