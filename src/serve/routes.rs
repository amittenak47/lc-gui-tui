//! Corpus and workspace routes.
//!
//! Every response body is a DTO defined here rather than a re-serialized
//! internal struct. That keeps `index.rs`, `problem.rs`, `generator.rs`, and
//! `runner.rs` untouched, and it makes the wire format an explicit, auditable
//! list of fields — which is how `ProblemDetail` can be read at a glance as
//! carrying no solution text.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::{blocking, AppError, Shared};
use crate::config::Config;
use crate::generator::WorkspaceMeta;
use crate::index::{self, ProblemRow, SearchSort};
use crate::problem::{IoCase, Problem};
use crate::runner::{self, CaseResult};
use crate::session::Session;
use crate::{generator, loader, problem};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ProblemSummary {
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub test_count: i64,
}

impl From<ProblemRow> for ProblemSummary {
    fn from(row: ProblemRow) -> Self {
        Self {
            task_id: row.task_id,
            question_id: row.question_id,
            difficulty: row.difficulty,
            tags: row.tags,
            test_count: row.test_count,
        }
    }
}

/// The redacted problem, field by field. `Problem` cannot even hold
/// `completion`/`response`/`query`, and this DTO lists what does go out.
#[derive(Debug, Serialize)]
pub struct ProblemDetail {
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub problem_description: Option<String>,
    pub starter_code: Option<String>,
    pub entry_point: Option<String>,
    pub cases: Vec<IoCase>,
}

impl From<Problem> for ProblemDetail {
    fn from(p: Problem) -> Self {
        Self {
            task_id: p.task_id,
            question_id: p.question_id,
            difficulty: p.difficulty,
            tags: p.tags,
            problem_description: p.problem_description,
            starter_code: p.starter_code,
            entry_point: p.entry_point,
            cases: p.input_output,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct LoadResponse {
    pub task_id: String,
    pub workspace_dir: String,
    pub case_count: usize,
    pub meta: WorkspaceMeta,
}

#[derive(Debug, Serialize)]
pub struct TestResponse {
    pub task_id: String,
    pub all_passed: bool,
    pub passed: usize,
    pub total: usize,
    pub results: Vec<CaseResult>,
}

#[derive(Debug, Serialize)]
pub struct SolutionResponse {
    pub task_id: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
pub struct SolutionUpdate {
    pub source: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct SearchQuery {
    pub difficulty: Option<String>,
    pub tag: Option<String>,
    /// Substring match on the slug. `q` in the URL, matching the CLI's `--query`.
    pub q: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub sort: Option<String>,
}

/// A page of results plus the totals the client needs to render "page 3 of 41".
#[derive(Debug, Serialize)]
pub struct ProblemPage {
    pub items: Vec<ProblemSummary>,
    /// Matches across the whole filter, not just this page.
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Paginated search, so the client can page through the corpus the way the TUI
/// does rather than pulling a capped slice and pretending that is everything.
pub async fn list_problems(
    Query(query): Query<SearchQuery>,
) -> Result<Json<ProblemPage>, AppError> {
    let page = blocking(move || {
        let sort = match query.sort.as_deref() {
            Some(raw) => SearchSort::parse(raw)
                .ok_or_else(|| anyhow!("unknown sort {raw:?} — expected task_id, question, difficulty, cases, or tags"))?,
            None => SearchSort::TaskId,
        };
        let limit = query.limit.unwrap_or(15).clamp(1, 500);
        let offset = query.offset.unwrap_or(0);

        let conn = index::open_db()?;
        let total = index::search_count(
            &conn,
            query.difficulty.as_deref(),
            query.tag.as_deref(),
            query.q.as_deref(),
        )?;
        let rows = index::search_page(
            &conn,
            query.difficulty.as_deref(),
            query.tag.as_deref(),
            query.q.as_deref(),
            sort,
            limit,
            offset,
        )?;
        Ok(ProblemPage {
            items: rows.into_iter().map(ProblemSummary::from).collect(),
            total,
            offset,
            limit,
        })
    })
    .await?;
    Ok(Json(page))
}

/// Every tag in the corpus, for the browser's filter — the same list the TUI
/// cycles through with `T`.
pub async fn list_tags() -> Result<Json<Vec<String>>, AppError> {
    let tags = blocking(move || {
        let conn = index::open_db()?;
        index::all_tags(&conn)
    })
    .await?;
    Ok(Json(tags))
}

/// One random problem matching the current filter — the TUI's `R`.
pub async fn random_problem(
    Query(query): Query<SearchQuery>,
) -> Result<Json<Option<ProblemSummary>>, AppError> {
    let row = blocking(move || {
        let conn = index::open_db()?;
        index::random_one(
            &conn,
            query.difficulty.as_deref(),
            query.tag.as_deref(),
            query.q.as_deref(),
        )
    })
    .await?;
    Ok(Json(row.map(ProblemSummary::from)))
}

/// Practice session on disk (`session.json`) — queue, progress, active list.
#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub started_at: u64,
    pub active_list: Option<String>,
    pub queue: Vec<String>,
    pub problems: std::collections::HashMap<String, crate::session::ProblemProgress>,
    pub reveals: std::collections::HashMap<String, u32>,
}

pub async fn get_session() -> Result<Json<SessionResponse>, AppError> {
    let session = blocking(move || Session::load_or_new()).await?;
    Ok(Json(SessionResponse {
        started_at: session.started_at,
        active_list: session.active_list,
        queue: session.queue,
        problems: session.problems,
        reveals: session.reveals,
    }))
}

/// Neighbors of `id` in the same filtered bank order the browser uses.
#[derive(Debug, Serialize)]
pub struct AdjacentResponse {
    pub task_id: String,
    pub prev: Option<String>,
    pub next: Option<String>,
}

pub async fn adjacent_problem(
    UrlPath(id): UrlPath<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<AdjacentResponse>, AppError> {
    let response = blocking(move || {
        let sort = match query.sort.as_deref() {
            Some(raw) => SearchSort::parse(raw).ok_or_else(|| {
                anyhow!("unknown sort {raw:?} — expected task_id, question, difficulty, cases, or tags")
            })?,
            None => SearchSort::TaskId,
        };
        let conn = index::open_db()?;
        let (prev, next) = index::adjacent_task_ids(
            &conn,
            &id,
            query.difficulty.as_deref(),
            query.tag.as_deref(),
            query.q.as_deref(),
            sort,
        )?;
        Ok(AdjacentResponse {
            task_id: id,
            prev,
            next,
        })
    })
    .await?;
    Ok(Json(response))
}

pub async fn get_problem(
    UrlPath(id): UrlPath<String>,
) -> Result<Json<ProblemDetail>, AppError> {
    let problem = blocking(move || {
        let conn = index::open_db()?;
        let row = loader::resolve(&conn, &id)?;
        problem::load_task(Path::new(&row.json_path), &row.task_id)
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(problem.into()))
}

pub async fn load_problem(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<LoadResponse>, AppError> {
    let cfg = state.cfg.clone();
    let response = blocking(move || {
        let conn = index::open_db()?;
        let row = loader::resolve(&conn, &id)?;
        let json_path = Path::new(&row.json_path);
        let problem = problem::load_task(json_path, &row.task_id)?;
        let dir = generator::generate(&cfg, &problem, json_path, false)?;
        // Same bookkeeping `lc load` does, so the tablet and the CLI share one
        // session history.
        Session::load_or_new()?.mark_loaded(&problem.task_id)?;
        let meta = runner::read_meta(&dir)?;
        Ok(LoadResponse {
            task_id: problem.task_id,
            workspace_dir: dir.display().to_string(),
            case_count: meta.cases.len(),
            meta,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn workspace_meta(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<WorkspaceMeta>, AppError> {
    let cfg = state.cfg.clone();
    let meta = blocking(move || load_meta(&cfg, &id))
        .await
        .map_err(not_found_if_unresolved)?;
    Ok(Json(meta))
}

pub async fn run_tests(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<TestResponse>, AppError> {
    let cfg = state.cfg.clone();
    // `runner` writes results to a single last_run.json and returns only a
    // bool, so read them back under the lock rather than racing another client.
    let guard = state.test_lock.lock().await;
    let response = blocking(move || {
        let meta = load_meta(&cfg, &id)?;
        let all_passed = runner::cmd_test_quiet(&cfg, Some(&id), None, false)?;
        let last = runner::load_last_run()?
            .filter(|run| run.task_id == meta.task_id)
            .with_context(|| format!("no results were recorded for {}", meta.task_id))?;
        let passed = last.results.iter().filter(|r| r.pass).count();
        Ok(TestResponse {
            task_id: meta.task_id,
            all_passed,
            passed,
            total: last.results.len(),
            results: last.results,
        })
    })
    .await;
    drop(guard);
    Ok(Json(response.map_err(not_found_if_unresolved)?))
}

pub async fn get_solution(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<SolutionResponse>, AppError> {
    let cfg = state.cfg.clone();
    let response = blocking(move || {
        let dir = runner::locate_workspace(&cfg, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        let source = std::fs::read_to_string(dir.join("solution.py"))
            .context("cannot read solution.py in the workspace")?;
        Ok(SolutionResponse {
            task_id: meta.task_id,
            source,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn put_solution(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Json(update): Json<SolutionUpdate>,
) -> Result<Json<SolutionResponse>, AppError> {
    let cfg = state.cfg.clone();
    let response = blocking(move || {
        let dir = runner::locate_workspace(&cfg, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        let path = dir.join("solution.py");
        std::fs::write(&path, &update.source)
            .with_context(|| format!("cannot write {}", path.display()))?;
        Ok(SolutionResponse {
            task_id: meta.task_id,
            source: update.source,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BoardBlob {
    /// Opaque JSON the client owns (`{v, elements, appState}`).
    pub board: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct BoardResponse {
    pub task_id: String,
    pub board: Option<serde_json::Value>,
}

pub async fn get_board(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<BoardResponse>, AppError> {
    let cfg = state.cfg.clone();
    let response = blocking(move || {
        let dir = runner::locate_workspace(&cfg, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        let path = dir.join("board.json");
        let board = if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read {}", path.display()))?;
            Some(serde_json::from_str(&text).context("board.json is not valid JSON")?)
        } else {
            None
        };
        Ok(BoardResponse {
            task_id: meta.task_id,
            board,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn put_board(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Json(update): Json<BoardBlob>,
) -> Result<Json<BoardResponse>, AppError> {
    let cfg = state.cfg.clone();
    let response = blocking(move || {
        let dir = runner::locate_workspace(&cfg, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        let path = dir.join("board.json");
        let text = serde_json::to_string_pretty(&update.board).context("cannot encode board")?;
        std::fs::write(&path, text).with_context(|| format!("cannot write {}", path.display()))?;
        Ok(BoardResponse {
            task_id: meta.task_id,
            board: Some(update.board),
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(crate) fn load_meta(cfg: &Config, id: &str) -> Result<WorkspaceMeta> {
    let dir = runner::locate_workspace(cfg, Some(id))?;
    runner::read_meta(&dir)
}

/// The problem statement for a workspace, or `None` if the corpus file moved
/// since `lc load` — the same tolerance `lc ask` has.
pub(crate) fn description_for(meta: &WorkspaceMeta) -> Option<String> {
    problem::load_task(Path::new(&meta.json_path), &meta.task_id)
        .ok()
        .and_then(|p| p.problem_description)
}

/// A missing problem or an un-materialized workspace is a 404, and an
/// ambiguous id is a 400 — neither is a server fault. Everything else keeps its
/// 500. The daemon has no error type of its own to match on, so this reads the
/// messages `loader::resolve`, `runner::locate_workspace`, and
/// `problem::load_task` already produce.
fn not_found_if_unresolved(err: AppError) -> AppError {
    use axum::http::StatusCode;

    let text = err.message().to_lowercase();
    const MISSING: [&str; 5] = [
        "no indexed problem matches",
        "not found in",
        "no workspace for",
        "does not exist",
        "cannot read problem file",
    ];
    if MISSING.iter().any(|needle| text.contains(needle)) {
        return err.with_status(StatusCode::NOT_FOUND);
    }
    if text.contains("is ambiguous") {
        return err.with_status(StatusCode::BAD_REQUEST);
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    fn status_of(message: &str) -> StatusCode {
        let err = AppError::from(anyhow!("{message}"));
        not_found_if_unresolved(err).status_code()
    }

    #[test]
    fn unresolvable_ids_are_404_not_500() {
        assert_eq!(
            status_of("no indexed problem matches \"nope\" — check the id"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status_of("no workspace for two-sum yet — run `lc load two-sum` first"),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn ambiguous_ids_are_the_clients_fault_not_the_servers() {
        assert_eq!(
            status_of("\"two\" is ambiguous; candidates:\n  two-sum"),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn a_real_failure_stays_a_500() {
        assert_eq!(
            status_of("failed to launch \"python3.12\": program not found"),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
