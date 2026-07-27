use anyhow::{Context, Result};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::path::PathBuf;
use std::time::{Instant, UNIX_EPOCH};

use crate::config::Config;
use crate::problem::Problem;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS problems (
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
CREATE TABLE IF NOT EXISTS problem_tags (
    tag     TEXT NOT NULL,
    task_id TEXT NOT NULL,
    PRIMARY KEY (tag, task_id)
);
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems(difficulty);
CREATE INDEX IF NOT EXISTS idx_problems_question   ON problems(question_id);
CREATE INDEX IF NOT EXISTS idx_problems_path       ON problems(json_path);
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

#[derive(Debug, Clone)]
pub struct ProblemRow {
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub json_path: String,
    pub test_count: i64,
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

    fn order_clause(self) -> &'static str {
        match self {
            Self::TaskId => "task_id",
            Self::Question => "CAST(question_id AS INTEGER), task_id",
            Self::Difficulty => {
                "CASE difficulty WHEN 'Easy' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Hard' THEN 3 ELSE 4 END, task_id"
            }
            Self::Cases => "test_count DESC, task_id",
            Self::Tags => "(SELECT MIN(tag) FROM problem_tags pt WHERE pt.task_id = problems.task_id), task_id",
        }
    }
}

pub fn row_to_problem(row: &rusqlite::Row) -> rusqlite::Result<ProblemRow> {
    let tags_json: String = row.get(3)?;
    Ok(ProblemRow {
        task_id: row.get(0)?,
        question_id: row.get(1)?,
        difficulty: row.get(2)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        json_path: row.get(4)?,
        test_count: row.get(5)?,
    })
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
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

pub fn cmd_index(cfg: &Config, rebuild: bool) -> Result<()> {
    let json_dir = cfg.json_dir()?;
    if !json_dir.is_dir() {
        anyhow::bail!("data dir {} does not exist or is not a directory", json_dir.display());
    }
    let conn = open_db()?;
    let started = Instant::now();
    let tx = conn.unchecked_transaction()?;
    if rebuild {
        tx.execute_batch("DELETE FROM problem_tags; DELETE FROM problems;")?;
    }

    let (mut added, mut updated, mut skipped, mut failed) = (0u32, 0u32, 0u32, 0u32);
    for entry in walkdir::WalkDir::new(&json_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let is_corpus = path
            .extension()
            .and_then(|e| e.to_str())
            .map_or(false, |e| {
                e.eq_ignore_ascii_case("json") || e.eq_ignore_ascii_case("jsonl")
            });
        if !is_corpus {
            continue;
        }
        if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
            && path.with_extension("json").exists()
        {
            skipped += 1;
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
                    "SELECT mtime FROM problems WHERE json_path = ?1",
                    params![path_str],
                    |r| r.get(0),
                )
                .optional()?;
            if existing == Some(mtime) {
                skipped += 1;
                continue;
            }
        }

        match crate::problem::load_all(path) {
            Ok(problems) => {
                for problem in problems {
                    let was_existing: bool = tx
                        .query_row(
                            "SELECT 1 FROM problems WHERE task_id = ?1",
                            params![problem.task_id],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    if let Err(err) = upsert(&tx, &problem, &path_str, mtime) {
                        failed += 1;
                        eprintln!(
                            "warn: skipping {} ({}) in {}: {err:#}",
                            problem.task_id,
                            problem
                                .question_id
                                .as_deref()
                                .unwrap_or("?"),
                            path.display()
                        );
                        continue;
                    }
                    if was_existing {
                        updated += 1;
                    } else {
                        added += 1;
                    }
                }
            }
            Err(err) => {
                failed += 1;
                eprintln!("warn: skipping {}: {err:#}", path.display());
            }
        }
    }
    tx.commit()?;

    println!(
        "Index: {added} added, {updated} updated, {skipped} unchanged, {failed} failed \
         in {:.1}s → {}",
        started.elapsed().as_secs_f32(),
        db_path()?.display()
    );
    Ok(())
}

fn upsert(conn: &Connection, p: &Problem, json_path: &str, mtime: i64) -> Result<()> {
    let tags_json = serde_json::to_string(&p.tags)?;
    conn.execute(
        "INSERT OR REPLACE INTO problems \
         (task_id, question_id, difficulty, tags, json_path, test_count, estimated_date, mtime, indexed_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%s','now'))",
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
        "DELETE FROM problem_tags WHERE task_id = ?1",
        params![p.task_id],
    )?;
    let mut stmt =
        conn.prepare_cached("INSERT OR IGNORE INTO problem_tags (tag, task_id) VALUES (?1, ?2)")?;
    for tag in &p.tags {
        stmt.execute(params![tag.to_lowercase(), p.task_id])?;
    }
    Ok(())
}

fn push_text_query_filter(clauses: &mut Vec<String>, params: &mut Vec<String>, query: Option<&str>) {
    if let Some(q) = query {
        if !q.is_empty() {
            params.push(format!("%{q}%"));
            let p = params.len();
            clauses.push(format!(
                "(task_id LIKE ?{p} OR question_id LIKE ?{p} OR \
                 task_id IN (SELECT task_id FROM problem_tags WHERE tag LIKE ?{p}))",
            ));
        }
    }
}

pub fn search(
    conn: &Connection,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
    limit: u32,
    random: bool,
    sort: SearchSort,
) -> Result<Vec<ProblemRow>> {
    let mut sql = format!("SELECT {ROW_COLUMNS} FROM problems");
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(d) = difficulty {
        params.push(d.to_string());
        clauses.push(format!("difficulty = ?{} COLLATE NOCASE", params.len()));
    }
    if let Some(t) = tag {
        params.push(t.to_lowercase());
        clauses.push(format!(
            "task_id IN (SELECT task_id FROM problem_tags WHERE tag = ?{})",
            params.len()
        ));
    }
    push_text_query_filter(&mut clauses, &mut params, query);
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(if random {
        " ORDER BY RANDOM()"
    } else {
        " ORDER BY "
    });
    if !random {
        sql.push_str(sort.order_clause());
    }
    if limit != u32::MAX {
        sql.push_str(&format!(" LIMIT {limit}"));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), row_to_problem)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn search_count(
    conn: &Connection,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
) -> Result<u32> {
    let mut sql = String::from("SELECT COUNT(*) FROM problems");
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(d) = difficulty {
        params.push(d.to_string());
        clauses.push(format!("difficulty = ?{} COLLATE NOCASE", params.len()));
    }
    if let Some(t) = tag {
        params.push(t.to_lowercase());
        clauses.push(format!(
            "task_id IN (SELECT task_id FROM problem_tags WHERE tag = ?{})",
            params.len()
        ));
    }
    push_text_query_filter(&mut clauses, &mut params, query);
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }

    let count: i64 = conn.query_row(
        &sql,
        params_from_iter(params.iter()),
        |r| r.get(0),
    )?;
    Ok(count.max(0) as u32)
}

pub fn search_page(
    conn: &Connection,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
    sort: SearchSort,
    limit: u32,
    offset: u32,
) -> Result<Vec<ProblemRow>> {
    let mut sql = format!("SELECT {ROW_COLUMNS} FROM problems");
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(d) = difficulty {
        params.push(d.to_string());
        clauses.push(format!("difficulty = ?{} COLLATE NOCASE", params.len()));
    }
    if let Some(t) = tag {
        params.push(t.to_lowercase());
        clauses.push(format!(
            "task_id IN (SELECT task_id FROM problem_tags WHERE tag = ?{})",
            params.len()
        ));
    }
    push_text_query_filter(&mut clauses, &mut params, query);
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(sort.order_clause());
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), row_to_problem)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn all_tags(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT tag FROM problem_tags ORDER BY tag")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn random_one(
    conn: &Connection,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
) -> Result<Option<ProblemRow>> {
    let rows = search(conn, difficulty, tag, query, 1, true, SearchSort::TaskId)?;
    Ok(rows.into_iter().next())
}

/// Previous/next task ids in the same filtered, sorted bank order as the browser.
pub fn adjacent_task_ids(
    conn: &Connection,
    task_id: &str,
    difficulty: Option<&str>,
    tag: Option<&str>,
    query: Option<&str>,
    sort: SearchSort,
) -> Result<(Option<String>, Option<String>)> {
    let mut sql = String::from("SELECT task_id FROM problems");
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();

    if let Some(d) = difficulty {
        params.push(d.to_string());
        clauses.push(format!("difficulty = ?{} COLLATE NOCASE", params.len()));
    }
    if let Some(t) = tag {
        params.push(t.to_lowercase());
        clauses.push(format!(
            "task_id IN (SELECT task_id FROM problem_tags WHERE tag = ?{})",
            params.len()
        ));
    }
    push_text_query_filter(&mut clauses, &mut params, query);
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(sort.order_clause());

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
            "SELECT task_id FROM problems WHERE task_id < ?1 ORDER BY task_id DESC LIMIT 1",
            params![task_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let next = conn
        .query_row(
            "SELECT task_id FROM problems WHERE task_id > ?1 ORDER BY task_id ASC LIMIT 1",
            params![task_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok((prev, next))
}

pub fn record_submission(
    conn: &Connection,
    task_id: &str,
    workspace_dir: &str,
    passed: u32,
    total: u32,
    all_passed: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO submissions (task_id, workspace_dir, passed_cases, total_cases, all_passed, submitted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
        params![
            task_id,
            workspace_dir,
            passed,
            total,
            if all_passed { 1 } else { 0 }
        ],
    )?;
    Ok(())
}

pub fn list_problem_rows(conn: &Connection, list_name: &str, sort: SearchSort) -> Result<Vec<ProblemRow>> {
    let list_id: i64 = conn.query_row(
        "SELECT id FROM lists WHERE name = ?1",
        params![list_name],
        |r| r.get(0),
    )?;

    let sql = format!(
        "SELECT {ROW_COLUMNS} FROM problems \
         WHERE task_id IN (SELECT task_id FROM list_items WHERE list_id = ?1) \
         ORDER BY {}",
        sort.order_clause()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![list_id], row_to_problem)?;
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
