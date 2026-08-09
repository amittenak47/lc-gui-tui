//! Workspace load, test, solution, and board routes.

use std::path::Path;

use anyhow::{anyhow, Context};
use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::common::{load_meta, not_found_if_unresolved, read_board_blob, DatasetQuery};
use super::{blocking, AppError, Shared};
use crate::attempt::{self, AttemptState};
use crate::generator::{self, WorkspaceMeta};
use crate::index;
use crate::loader;
use crate::problem;
use crate::runner::{self, CaseResult};
use crate::session::Session;

#[derive(Debug, Serialize)]
pub struct LoadResponse {
    pub dataset: String,
    pub task_id: String,
    pub workspace_dir: String,
    pub case_count: usize,
    pub meta: WorkspaceMeta,
    /// Layout, code, and coach transcript kept from a previous visit — see
    /// [`crate::attempt`]. The client restores these instead of starting fresh.
    pub resume: ResumeState,
}

/// What a previous visit left behind for this workspace.
#[derive(Debug, Serialize)]
pub struct ResumeState {
    pub attempt: AttemptState,
    /// Saved whiteboard, or `null` when the next attempt starts fresh.
    pub board: Option<serde_json::Value>,
    /// Saved coach transcript, empty when the next attempt starts fresh.
    pub agent_messages: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct TestResponse {
    pub dataset: String,
    pub task_id: String,
    pub all_passed: bool,
    pub passed: usize,
    pub total: usize,
    pub results: Vec<CaseResult>,
    /// Whether this run stopped early because Settings → Tests says to.
    pub stopped_early: bool,
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

#[derive(Debug, Deserialize)]
pub struct OpenWorkspaceBody {
    /// `"ide"` opens Cursor/VS Code; `"canvas"` is a no-op on the daemon (client navigates).
    pub target: String,
}

#[derive(Debug, Serialize)]
pub struct OpenWorkspaceResponse {
    pub task_id: String,
    pub target: String,
    pub workspace_dir: String,
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

pub async fn open_workspace(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
    Json(body): Json<OpenWorkspaceBody>,
) -> Result<Json<OpenWorkspaceResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let target = body.target.to_ascii_lowercase();
    if target != "ide" && target != "canvas" {
        return Err(AppError::bad_request(anyhow!(
            "target must be \"ide\" or \"canvas\", got {:?}",
            body.target
        )));
    }
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        if target == "ide" {
            generator::open_in_editor(&dir);
        }
        Ok(OpenWorkspaceResponse {
            task_id: meta.task_id,
            target,
            workspace_dir: dir.display().to_string(),
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn load_problem(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
) -> Result<Json<LoadResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let conn = index::open_db()?;
        let row = loader::resolve_in(&conn, dataset, &id)?;
        let json_path = Path::new(&row.json_path);
        let problem = problem::load_task_for(dataset, json_path, &row.task_id)?;
        let dir = generator::generate(&cfg, dataset, &problem, json_path, false)?;
        // Same bookkeeping `lc load` does, so the tablet and the CLI share one
        // session history.
        Session::load_or_new()?.mark_loaded(&dataset.key(&problem.task_id))?;
        let meta = runner::read_meta(&dir)?;
        // Whatever the last visit chose to keep. `attempt::finish` already
        // cleared what was not kept, so this is just "read what is there".
        let resume = ResumeState {
            attempt: attempt::read_state(&dir)?,
            board: read_board_blob(&dir)?,
            agent_messages: attempt::read_agent(&dir)?.messages,
        };
        Ok(LoadResponse {
            dataset: dataset.id.to_string(),
            task_id: problem.task_id,
            workspace_dir: dir.display().to_string(),
            case_count: meta.cases.len(),
            meta,
            resume,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn workspace_meta(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
) -> Result<Json<WorkspaceMeta>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let meta = blocking(move || load_meta(&cfg, dataset, &id))
        .await
        .map_err(not_found_if_unresolved)?;
    Ok(Json(meta))
}

pub async fn run_tests(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
) -> Result<Json<TestResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    // `runner` writes results to a single last_run.json and returns only a
    // bool, so read them back under the lock rather than racing another client.
    let guard = state.test_lock.lock().await;
    let response = blocking(move || {
        let meta = load_meta(&cfg, dataset, &id)?;
        let all_passed = runner::cmd_test_quiet_in(&cfg, dataset, Some(&id), None, false)?;
        let last = runner::load_last_run()?
            .filter(|run| run.task_id == meta.task_id)
            .with_context(|| format!("no results were recorded for {}", meta.task_id))?;
        let passed = last.results.iter().filter(|r| r.pass).count();
        // Settings → Tests can cut the run short, so a "3/12" here means three
        // of the twelve *recorded* cases ran, not that nine silently passed.
        let stopped_early =
            cfg.tests.stop_on_first_failure && !all_passed && last.results.len() < meta.cases.len();
        if all_passed {
            let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
            attempt::mark_solved(&dir)?;
        }
        Ok(TestResponse {
            dataset: dataset.id.to_string(),
            task_id: meta.task_id,
            all_passed,
            passed,
            total: last.results.len(),
            results: last.results,
            stopped_early,
        })
    })
    .await;
    drop(guard);
    Ok(Json(response.map_err(not_found_if_unresolved)?))
}

pub async fn get_solution(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
) -> Result<Json<SolutionResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
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
    Query(query): Query<DatasetQuery>,
    Json(update): Json<SolutionUpdate>,
) -> Result<Json<SolutionResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
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

pub async fn get_board(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
) -> Result<Json<BoardResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        Ok(BoardResponse {
            task_id: meta.task_id,
            board: read_board_blob(&dir)?,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn put_board(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
    Json(update): Json<BoardBlob>,
) -> Result<Json<BoardResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        let path = dir.join("board.json");
        // Compact, not pretty. `board.json` is machine-written and machine-read
        // — nobody edits it by hand — and it is the one file here that holds
        // handwriting. Pretty-printing put every ink coordinate and pressure
        // reading on its own indented line, which on an annotated page is most
        // of the file: about 2.5x the bytes, to no reader's benefit. Every
        // other `to_string_pretty` in the tree writes something a person may
        // actually open, so they stay as they are.
        let text = serde_json::to_string(&update.board).context("cannot encode board")?;
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
