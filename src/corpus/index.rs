use anyhow::{Context, Result};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::path::PathBuf;
use std::time::{Instant, UNIX_EPOCH};

use crate::config::Config;
use crate::dataset::{self, Dataset, DatasetInfo, DATASETS};
use crate::problem::Problem;

/// Tables that are not per-dataset: named lists and the local submission log.
///
/// Lists stay keyed on `task_id` alone and belong to the default corpus — they
/// predate datasets and `lc list` is a LeetCode-corpus workflow. The submission
/// log gains a `dataset` column instead, because it is a history and rewriting
/// it would lose which corpus each row came from.
const SHARED_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS lists (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS list_items (
    list_id  INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    task_id  TEXT NOT NULL,
    PRIMARY KEY (list_id, task_id)
);
CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    workspace_dir TEXT NOT NULL,
    passed_cases  INTEGER NOT NULL DEFAULT 0,
    total_cases   INTEGER NOT NULL DEFAULT 0,
    all_passed    INTEGER NOT NULL DEFAULT 0,
    submitted_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
"#;

/// The per-dataset table pair. Identical in every dataset — the corpora differ
/// in content, not in what `lc` needs to know about a problem.
fn dataset_schema(dataset: &Dataset) -> String {
    let Dataset { table, tag_table, .. } = dataset;
    format!(
        r#"
CREATE TABLE IF NOT EXISTS {table} (
    task_id        TEXT PRIMARY KEY,
    question_id    TEXT,
    difficulty     TEXT,
    tags           TEXT NOT NULL DEFAULT '[]',
    json_path      TEXT NOT NULL,
    test_count     INTEGER NOT NULL DEFAULT 0,
    estimated_date TEXT,
    mtime          INTEGER NOT NULL DEFAULT 0,
    indexed_at     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS {tag_table} (
    tag     TEXT NOT NULL,
    task_id TEXT NOT NULL,
    PRIMARY KEY (tag, task_id)
);
CREATE INDEX IF NOT EXISTS idx_{table}_difficulty ON {table}(difficulty);
CREATE INDEX IF NOT EXISTS idx_{table}_question   ON {table}(question_id);
CREATE INDEX IF NOT EXISTS idx_{table}_path       ON {table}(json_path);
-- The tag table's primary key is (tag, task_id), so `DELETE ... WHERE task_id
-- = ?` — which `upsert` runs once per problem — had no index to use and
-- scanned the whole table every time. On a 487k-row corpus that is a full
-- scan of ~1M tag rows per problem, and it is why indexing KodCode took
-- hours rather than minutes. Created here (not in a migration) so an existing
-- database picks it up the next time it is opened.
CREATE INDEX IF NOT EXISTS idx_{tag_table}_task   ON {tag_table}(task_id);
"#
    )
}

#[derive(Debug, Clone)]
pub struct ProblemRow {
    /// Which corpus this row came from — the same slug the UI tabs use.
    pub dataset: &'static str,
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub json_path: String,
    pub test_count: i64,
}

impl ProblemRow {
    /// `dataset/task_id` — the key `session.json` and the UI badges use.
    pub fn key(&self) -> String {
        format!("{}/{}", self.dataset, self.task_id)
    }
}

pub const ROW_COLUMNS: &str = "task_id, question_id, difficulty, tags, json_path, test_count";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SearchSort {
    #[default]
    TaskId,
    Question,
    Difficulty,
    Cases,
    Tags,
}

impl SearchSort {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw.to_ascii_lowercase().as_str() {
            "task_id" | "task" | "slug" => Self::TaskId,
            "question" | "question_id" | "q" | "number" | "num" => Self::Question,
            "difficulty" | "diff" => Self::Difficulty,
            "cases" | "case" | "tests" => Self::Cases,
            "tags" | "tag" => Self::Tags,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::TaskId => "task_id",
            Self::Question => "question",
            Self::Difficulty => "difficulty",
            Self::Cases => "cases",
            Self::Tags => "tags",
        }
    }

    pub fn default_desc(self) -> bool {
        matches!(self, Self::Cases)
    }
}

/// A search key plus direction. Bare `cases` is descending (most tests first);
/// every other key is ascending. `:desc` / `:asc` / a leading `-` override.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchOrder {
    pub key: SearchSort,
    pub desc: bool,
}

impl From<SearchSort> for SearchOrder {
    fn from(key: SearchSort) -> Self {
        Self {
            key,
            desc: key.default_desc(),
        }
    }
}

impl SearchOrder {
    pub fn parse(raw: &str) -> Option<Self> {
        let lower = raw.to_ascii_lowercase();
        let (rest, forced) = if let Some(stripped) = lower.strip_prefix('-') {
            (stripped.to_string(), Some(true))
        } else if let Some(stripped) = lower.strip_suffix(":desc") {
            (stripped.to_string(), Some(true))
        } else if let Some(stripped) = lower.strip_suffix(":asc") {
            (stripped.to_string(), Some(false))
        } else {
            (lower, None)
        };
        let key = SearchSort::parse(&rest)?;
        Some(Self {
            key,
            desc: forced.unwrap_or(key.default_desc()),
        })
    }

    pub fn order_clause(self, dataset: &Dataset) -> String {
        let dir = if self.desc { "DESC" } else { "ASC" };
        match self.key {
            SearchSort::TaskId => format!("task_id {dir}"),
            SearchSort::Question => format!("CAST(question_id AS INTEGER) {dir}, task_id"),
            SearchSort::Difficulty => format!(
                "CASE difficulty WHEN 'Easy' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Hard' THEN 3 ELSE 4 END {dir}, task_id"
            ),
            SearchSort::Cases => format!("test_count {dir}, task_id"),
            SearchSort::Tags => format!(
                "(SELECT MIN(tag) FROM {tags} pt WHERE pt.task_id = {table}.task_id) {dir}, task_id",
                tags = dataset.tag_table,
                table = dataset.table
            ),
        }
    }
}

/// Read a `ROW_COLUMNS` row, stamping it with the dataset it was read from.
pub fn row_reader(
    dataset: &'static Dataset,
) -> impl Fn(&rusqlite::Row) -> rusqlite::Result<ProblemRow> {
    move |row| {
        let tags_json: String = row.get(3)?;
        Ok(ProblemRow {
            dataset: dataset.id,
            task_id: row.get(0)?,
            question_id: row.get(1)?,
            difficulty: row.get(2)?,
            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            json_path: row.get(4)?,
            test_count: row.get(5)?,
        })
    }
}

/// Row reader for the default corpus, for callers that predate datasets.
pub fn row_to_problem(row: &rusqlite::Row) -> rusqlite::Result<ProblemRow> {
    row_reader(dataset::default())(row)
}

pub fn db_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("problems.db"))
}

pub fn open_db() -> Result<Connection> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(&path)
        .with_context(|| format!("cannot open index db {}", path.display()))?;
    conn.execute_batch(SHARED_SCHEMA)?;
    for dataset in &DATASETS {
        conn.execute_batch(&dataset_schema(dataset))?;
    }
    migrate(&conn)?;
    Ok(conn)
}

/// Additive migrations for databases written before datasets existed.
fn migrate(conn: &Connection) -> Result<()> {
    let has_dataset_column = conn
        .prepare("SELECT 1 FROM pragma_table_info('submissions') WHERE name = 'dataset'")?
        .exists([])?;
    if !has_dataset_column {
        conn.execute_batch(&format!(
            "ALTER TABLE submissions ADD COLUMN dataset TEXT NOT NULL DEFAULT '{}';",
            dataset::DEFAULT_DATASET
        ))?;
    }
    Ok(())
}

/// Index every dataset that has a corpus folder, or just `only` when given.
pub fn cmd_index(cfg: &Config, rebuild: bool, only: Option<&'static Dataset>) -> Result<()> {
    let targets: Vec<&'static Dataset> = match only {
        Some(dataset) => vec![dataset],
        None => DATASETS.iter().collect(),
    };

    let conn = open_db()?;
    let started = Instant::now();
    let mut indexed_any = false;

    for dataset in targets {
        let dir = match dataset.corpus_dir(cfg) {
            Ok(dir) => dir,
            // Only the default corpus can fail here (no data-dir set at all),
            // and only when the user asked for it specifically.
            Err(err) if only.is_some() => return Err(err),
            Err(_) => continue,
        };
        if !dir.is_dir() {
            if only.is_some() {
                anyhow::bail!(
                    "corpus dir {} for dataset {} does not exist — download it there, \
                     or point `lc config set data.datasets.{} <path>` at it",
                    dir.display(),
                    dataset.id,
                    dataset.id
                );
            }
            continue;
        }
        indexed_any = true;
        let stats = index_dataset(&conn, dataset, &dir, rebuild)?;
        println!(
            "{}: {} added, {} updated, {} unchanged, {} failed  ({})",
            dataset.id,
            stats.added,
            stats.updated,
            stats.skipped,
            stats.failed,
            dir.display()
        );
    }

    if !indexed_any {
        anyhow::bail!(
            "no corpus folders found — set `lc config set data-dir <path>`, then put each \
             dataset in its own subfolder ({})",
            DATASETS
                .iter()
                .filter(|d| !d.is_default())
                .map(|d| d.id)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    println!(
        "Index rebuilt in {:.1}s → {}",
        started.elapsed().as_secs_f32(),
        db_path()?.display()
    );
    Ok(())
}

#[derive(Debug, Default)]
struct IndexStats {
    added: u32,
    updated: u32,
    skipped: u32,
    failed: u32,
}

fn index_dataset(
    conn: &Connection,
    dataset: &'static Dataset,
    dir: &std::path::Path,
    rebuild: bool,
) -> Result<IndexStats> {
    let tx = conn.unchecked_transaction()?;
    if rebuild {
        tx.execute_batch(&format!(
            "DELETE FROM {}; DELETE FROM {};",
            dataset.tag_table, dataset.table
        ))?;
    }

    let mut stats = IndexStats::default();
    for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        // The default corpus indexes the data-dir root, so it has to step over
        // the subfolders that belong to the other datasets.
        if dataset::belongs_to_other_dataset(dir, path, dataset) {
            continue;
        }
        let is_corpus = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("json") || e.eq_ignore_ascii_case("jsonl"));
        if !is_corpus {
            continue;
        }
        if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
            && path.with_extension("json").exists()
        {
            stats.skipped += 1;
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let path_str = path.display().to_string();

        if !rebuild {
            let existing: Option<i64> = tx
                .query_row(
                    &format!("SELECT mtime FROM {} WHERE json_path = ?1", dataset.table),
                    params![path_str],
                    |r| r.get(0),
                )
                .optional()?;
            if existing == Some(mtime) {
                stats.skipped += 1;
                continue;
            }
        }

        // Streamed rather than collected: a 487k-row corpus does not fit in
        // memory as `Vec<Problem>` (each one carries a statement and a suite).
        let walk = crate::problem::for_each_for(dataset, path, |problem| {
            let was_existing: bool = tx
                .query_row(
                    &format!("SELECT 1 FROM {} WHERE task_id = ?1", dataset.table),
                    params![problem.task_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if let Err(err) = upsert(&tx, dataset, &problem, &path_str, mtime) {
                stats.failed += 1;
                eprintln!(
                    "warn: skipping {} ({}) in {}: {err:#}",
                    problem.task_id,
                    problem.question_id.as_deref().unwrap_or("?"),
                    path.display()
                );
                return Ok(());
            }
            if was_existing {
                stats.updated += 1;
            } else {
                stats.added += 1;
            }
            Ok(())
        });
        if let Err(err) = walk {
            stats.failed += 1;
            eprintln!("warn: skipping {}: {err:#}", path.display());
        }
    }
    tx.commit()?;
    Ok(stats)
}

fn upsert(
    conn: &Connection,
    dataset: &Dataset,
    p: &Problem,
    json_path: &str,
    mtime: i64,
) -> Result<()> {
    let tags_json = serde_json::to_string(&p.tags)?;
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {} \
             (task_id, question_id, difficulty, tags, json_path, test_count, estimated_date, mtime, indexed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%s','now'))",
            dataset.table
        ),
        params![
            p.task_id,
            p.question_id,
            p.difficulty,
            tags_json,
            json_path,
            p.input_output.len() as i64,
            p.estimated_date,
            mtime
        ],
    )?;
    conn.execute(
        &format!("DELETE FROM {} WHERE task_id = ?1", dataset.tag_table),
        params![p.task_id],
    )?;
    let sql = format!(
        "INSERT OR IGNORE INTO {} (tag, task_id) VALUES (?1, ?2)",
        dataset.tag_table
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    for tag in &p.tags {
        stmt.execute(params![tag.to_lowercase(), p.task_id])?;
    }
    Ok(())
}

/// How many problems each dataset has indexed, for the browser's tab strip.
pub fn dataset_infos(conn: &Connection, cfg: &Config) -> Result<Vec<DatasetInfo>> {
    let mut out = Vec::with_capacity(DATASETS.len());
    for dataset in &DATASETS {
        let count: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", dataset.table),
            [],
            |r| r.get(0),
        )?;
        out.push(DatasetInfo {
            id: dataset.id.to_string(),
            label: dataset.label.to_string(),
            source: dataset.source.to_string(),
            count: count.max(0) as u32,
            corpus_dir: dataset
                .corpus_dir(cfg)
                .ok()
                .map(|dir| dir.display().to_string()),
            notes: dataset.notes.to_string(),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

fn push_text_query_filter(
    clauses: &mut Vec<String>,
    params: &mut Vec<String>,
    query: Option<&str>,
    dataset: &Dataset,
) {
    if let Some(q) = query {
        let trimmed = q.trim();
        if trimmed.is_empty() {
            return;
        }
        // UI shows spaced titles (`Two Sum`); the index stores slugs (`two-sum`).
        // Collapse runs of spaces/hyphens so either form matches `task_id`.
        let slug_needle: String = trimmed
            .split(|c: char| c.is_whitespace() || c == '-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        params.push(format!("%{trimmed}%"));
        let p_raw = params.len();
        params.push(format!("%{slug_needle}%"));
        let p_slug = params.len();
        clauses.push(format!(
            "(task_id LIKE ?{p_slug} OR task_id LIKE ?{p_raw} OR question_id LIKE ?{p_raw} OR \
             task_id IN (SELECT task_id FROM {tags} WHERE tag LIKE ?{p_raw}))",
            tags = dataset.tag_table
        ));
    }
}

/// The shared `WHERE` builder behind search, count, paging, and adjacency.
fn filter_clauses(
    dataset: &Dataset,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    if let Some(d) = difficulty {
        params.push(d.to_string());
        clauses.push(format!("difficulty = ?{} COLLATE NOCASE", params.len()));
    }
    if let Some(t) = tag {
        params.push(t.to_lowercase());
        clauses.push(format!(
            "task_id IN (SELECT task_id FROM {} WHERE tag = ?{})",
            dataset.tag_table,
            params.len()
        ));
    }
    push_text_query_filter(&mut clauses, &mut params, query, dataset);
    (clauses, params)
}

fn with_where(sql: &mut String, clauses: &[String]) {
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
}

pub fn search(
    conn: &Connection,
    dataset: &'static Dataset,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
    limit: u32,
    random: bool,
    sort: impl Into<SearchOrder>,
) -> Result<Vec<ProblemRow>> {
    let sort = sort.into();
    let (clauses, params) = filter_clauses(dataset, difficulty, tag, query);
    let mut sql = format!("SELECT {ROW_COLUMNS} FROM {}", dataset.table);
    with_where(&mut sql, &clauses);
    if random {
        sql.push_str(" ORDER BY RANDOM()");
    } else {
        sql.push_str(" ORDER BY ");
        sql.push_str(&sort.order_clause(dataset));
    }
    if limit != u32::MAX {
        sql.push_str(&format!(" LIMIT {limit}"));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), row_reader(dataset))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn search_count(
    conn: &Connection,
    dataset: &'static Dataset,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
) -> Result<u32> {
    let (clauses, params) = filter_clauses(dataset, difficulty, tag, query);
    let mut sql = format!("SELECT COUNT(*) FROM {}", dataset.table);
    with_where(&mut sql, &clauses);
    let count: i64 = conn.query_row(&sql, params_from_iter(params.iter()), |r| r.get(0))?;
    Ok(count.max(0) as u32)
}

pub fn search_page(
    conn: &Connection,
    dataset: &'static Dataset,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
    sort: impl Into<SearchOrder>,
    limit: u32,
    offset: u32,
) -> Result<Vec<ProblemRow>> {
    let sort = sort.into();
    let (clauses, params) = filter_clauses(dataset, difficulty, tag, query);
    let mut sql = format!("SELECT {ROW_COLUMNS} FROM {}", dataset.table);
    with_where(&mut sql, &clauses);
    sql.push_str(" ORDER BY ");
    sql.push_str(&sort.order_clause(dataset));
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), row_reader(dataset))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Paginated task ids — for offline-pack delta reconciliation.
pub fn task_id_page(
    conn: &Connection,
    dataset: &'static Dataset,
    limit: u32,
    offset: u32,
) -> Result<Vec<String>> {
    let sql = format!(
        "SELECT task_id FROM {} ORDER BY task_id LIMIT {limit} OFFSET {offset}",
        dataset.table
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Problems indexed after `since_mtime` — offline-pack delta chunks.
pub fn search_page_since(
    conn: &Connection,
    dataset: &'static Dataset,
    since_mtime: i64,
    sort: impl Into<SearchOrder>,
    limit: u32,
    offset: u32,
) -> Result<Vec<ProblemRow>> {
    let sort = sort.into();
    let mut sql = format!("SELECT {ROW_COLUMNS} FROM {}", dataset.table);
    sql.push_str(&format!(" WHERE mtime > {since_mtime}"));
    sql.push_str(" ORDER BY ");
    sql.push_str(&sort.order_clause(dataset));
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_reader(dataset))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn all_tags(conn: &Connection, dataset: &Dataset) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT DISTINCT tag FROM {} ORDER BY tag",
        dataset.tag_table
    ))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn random_one(
    conn: &Connection,
    dataset: &'static Dataset,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
) -> Result<Option<ProblemRow>> {
    let rows = search(
        conn,
        dataset,
        difficulty,
        tag,
        query,
        1,
        true,
        SearchSort::TaskId,
    )?;
    Ok(rows.into_iter().next())
}

/// Previous/next task ids in the same filtered, sorted bank order as the browser.
pub fn adjacent_task_ids(
    conn: &Connection,
    dataset: &Dataset,
    task_id: &str,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
    sort: impl Into<SearchOrder>,
) -> Result<(Option<String>, Option<String>)> {
    let sort = sort.into();
    let (clauses, params) = filter_clauses(dataset, difficulty, tag, query);
    let mut sql = format!("SELECT task_id FROM {}", dataset.table);
    with_where(&mut sql, &clauses);
    sql.push_str(" ORDER BY ");
    sql.push_str(&sort.order_clause(dataset));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), |r| r.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row?);
    }

    if let Some(index) = ids.iter().position(|id| id == task_id) {
        let prev = if index > 0 {
            Some(ids[index - 1].clone())
        } else {
            None
        };
        let next = ids.get(index + 1).cloned();
        return Ok((prev, next));
    }

    // Current id isn't in this filter — still offer neighbors by task_id order.
    let prev = conn
        .query_row(
            &format!(
                "SELECT task_id FROM {} WHERE task_id < ?1 ORDER BY task_id DESC LIMIT 1",
                dataset.table
            ),
            params![task_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let next = conn
        .query_row(
            &format!(
                "SELECT task_id FROM {} WHERE task_id > ?1 ORDER BY task_id ASC LIMIT 1",
                dataset.table
            ),
            params![task_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok((prev, next))
}

pub fn record_submission(
    conn: &Connection,
    dataset: &Dataset,
    task_id: &str,
    workspace_dir: &str,
    passed: u32,
    total: u32,
    all_passed: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO submissions \
         (dataset, task_id, workspace_dir, passed_cases, total_cases, all_passed, submitted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s','now'))",
        params![
            dataset.id,
            task_id,
            workspace_dir,
            passed,
            total,
            if all_passed { 1 } else { 0 }
        ],
    )?;
    Ok(())
}

/// Named lists are a default-corpus workflow — see [`SHARED_SCHEMA`].
pub fn list_problem_rows(
    conn: &Connection,
    list_name: &str,
    sort: impl Into<SearchOrder>,
) -> Result<Vec<ProblemRow>> {
    let sort = sort.into();
    let dataset = dataset::default();
    let list_id: i64 = conn.query_row(
        "SELECT id FROM lists WHERE name = ?1",
        params![list_name],
        |r| r.get(0),
    )?;

    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM {table} \
         WHERE task_id IN (SELECT task_id FROM list_items WHERE list_id = ?1) \
         ORDER BY {order}",
        table = dataset.table,
        order = sort.order_clause(dataset)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![list_id], row_reader(dataset))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_names(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM lists ORDER BY name")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::problem::IoCase;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SHARED_SCHEMA).unwrap();
        for dataset in &DATASETS {
            conn.execute_batch(&dataset_schema(dataset)).unwrap();
        }
        conn
    }

    fn problem(task_id: &str, difficulty: &str, tags: &[&str]) -> Problem {
        Problem {
            task_id: task_id.into(),
            question_id: Some("1".into()),
            difficulty: Some(difficulty.into()),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            problem_description: None,
            prompt: None,
            starter_code: None,
            entry_point: None,
            test: None,
            input_output: vec![IoCase {
                input: "x = 1".into(),
                output: "1".into(),
            }],
            estimated_date: None,
        }
    }

    /// The whole point of separate tables: the same slug in two corpora is two
    /// different problems, and neither search may see the other.
    #[test]
    fn the_same_slug_in_two_datasets_stays_two_problems() {
        let conn = memory_db();
        let leetcode = dataset::get("leetcode").unwrap();
        let kodcode = dataset::get("kodcode").unwrap();

        upsert(&conn, leetcode, &problem("two-sum", "Easy", &["Array"]), "a.json", 1).unwrap();
        upsert(&conn, kodcode, &problem("two-sum", "Hard", &["Docs"]), "b.jsonl", 1).unwrap();

        let from_leetcode = search(&conn, leetcode, None, None, None, 10, false, SearchSort::TaskId).unwrap();
        let from_kodcode = search(&conn, kodcode, None, None, None, 10, false, SearchSort::TaskId).unwrap();

        assert_eq!(from_leetcode.len(), 1);
        assert_eq!(from_kodcode.len(), 1);
        assert_eq!(from_leetcode[0].difficulty.as_deref(), Some("Easy"));
        assert_eq!(from_kodcode[0].difficulty.as_deref(), Some("Hard"));
        // And each row knows where it came from, so the session key differs.
        assert_eq!(from_leetcode[0].key(), "leetcode/two-sum");
        assert_eq!(from_kodcode[0].key(), "kodcode/two-sum");
    }

    #[test]
    fn tags_and_counts_are_scoped_to_one_dataset() {
        let conn = memory_db();
        let leetcode = dataset::get("leetcode").unwrap();
        let kodcode = dataset::get("kodcode").unwrap();
        upsert(&conn, leetcode, &problem("two-sum", "Easy", &["Array"]), "a.json", 1).unwrap();
        upsert(&conn, kodcode, &problem("running-max", "Easy", &["Docs"]), "b.jsonl", 1).unwrap();

        assert_eq!(all_tags(&conn, leetcode).unwrap(), vec!["array"]);
        assert_eq!(all_tags(&conn, kodcode).unwrap(), vec!["docs"]);
        assert_eq!(search_count(&conn, leetcode, None, None, None).unwrap(), 1);
        // A tag filter from the wrong corpus matches nothing rather than leaking.
        assert_eq!(
            search_count(&conn, leetcode, None, Some("docs"), None).unwrap(),
            0
        );
    }

    #[test]
    fn rebuilding_one_dataset_leaves_the_others_alone() {
        let conn = memory_db();
        let leetcode = dataset::get("leetcode").unwrap();
        let kodcode = dataset::get("kodcode").unwrap();
        upsert(&conn, leetcode, &problem("two-sum", "Easy", &["Array"]), "a.json", 1).unwrap();
        upsert(&conn, kodcode, &problem("running-max", "Easy", &["Docs"]), "b.jsonl", 1).unwrap();

        conn.execute_batch(&format!(
            "DELETE FROM {}; DELETE FROM {};",
            kodcode.tag_table, kodcode.table
        ))
        .unwrap();

        assert_eq!(search_count(&conn, kodcode, None, None, None).unwrap(), 0);
        assert_eq!(search_count(&conn, leetcode, None, None, None).unwrap(), 1);
    }

    #[test]
    fn paging_and_adjacency_walk_only_the_selected_dataset() {
        let conn = memory_db();
        let kodcode = dataset::get("kodcode").unwrap();
        for slug in ["a-task", "b-task", "c-task"] {
            upsert(&conn, kodcode, &problem(slug, "Easy", &["Docs"]), "b.jsonl", 1).unwrap();
        }
        let leetcode = dataset::get("leetcode").unwrap();
        upsert(&conn, leetcode, &problem("b-task", "Easy", &[]), "a.json", 1).unwrap();

        let page = search_page(&conn, kodcode, None, None, None, SearchSort::TaskId, 2, 1).unwrap();
        assert_eq!(
            page.iter().map(|r| r.task_id.as_str()).collect::<Vec<_>>(),
            vec!["b-task", "c-task"]
        );

        let (prev, next) =
            adjacent_task_ids(&conn, kodcode, "b-task", None, None, None, SearchSort::TaskId)
                .unwrap();
        assert_eq!(prev.as_deref(), Some("a-task"));
        assert_eq!(next.as_deref(), Some("c-task"));
    }

    /// A database written before datasets existed has no `dataset` column on
    /// `submissions`, and must gain one rather than failing every insert.
    #[test]
    fn an_older_submissions_table_is_migrated_in_place() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                workspace_dir TEXT NOT NULL,
                passed_cases INTEGER NOT NULL DEFAULT 0,
                total_cases INTEGER NOT NULL DEFAULT 0,
                all_passed INTEGER NOT NULL DEFAULT 0,
                submitted_at INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO submissions (task_id, workspace_dir) VALUES ('two-sum', '/ws');",
        )
        .unwrap();

        migrate(&conn).unwrap();
        // Running twice must be a no-op, not a duplicate-column error.
        migrate(&conn).unwrap();

        let existing: String = conn
            .query_row("SELECT dataset FROM submissions LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(existing, dataset::DEFAULT_DATASET, "old rows are LeetCode");

        record_submission(
            &conn,
            dataset::get("kodcode").unwrap(),
            "running-max",
            "/ws",
            1,
            1,
            true,
        )
        .unwrap();
        let kodcode_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM submissions WHERE dataset = 'kodcode'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kodcode_rows, 1);
    }

    #[test]
    fn search_order_parses_suffix_and_flips_sql_dir() {
        let ds = dataset::default();
        let question = SearchOrder::parse("question").unwrap();
        assert!(!question.desc);
        assert!(question.order_clause(ds).contains("ASC"));

        let question_desc = SearchOrder::parse("question:desc").unwrap();
        assert!(question_desc.desc);
        assert!(question_desc.order_clause(ds).contains("DESC"));
        assert_eq!(
            SearchOrder::parse("-question"),
            SearchOrder::parse("question:desc")
        );

        let cases = SearchOrder::parse("cases").unwrap();
        assert!(cases.desc);
        assert!(cases.order_clause(ds).contains("test_count DESC"));
        let cases_asc = SearchOrder::parse("cases:asc").unwrap();
        assert!(!cases_asc.desc);
        assert!(cases_asc.order_clause(ds).contains("test_count ASC"));
    }
}
