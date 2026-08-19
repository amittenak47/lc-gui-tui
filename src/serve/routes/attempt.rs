//! Agent session and attempt lifecycle routes.

use std::path::Path;

use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::common::{not_found_if_unresolved, DatasetQuery};
use super::{blocking, AppError, Shared};
use crate::attempt::{self, AgentSession, AttemptOutcome};
use crate::generator;
use crate::problem;
use crate::runner;

#[derive(Debug, Serialize)]
pub struct AgentSessionResponse {
    pub task_id: String,
    pub dataset: String,
    #[serde(flatten)]
    pub session: AgentSession,
}

#[derive(Debug, Deserialize)]
pub struct AgentSessionUpdate {
    /// Opaque coach transcript. The daemon stores it and never reads inside it.
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
}

pub async fn get_agent_session(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
) -> Result<Json<AgentSessionResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        Ok(AgentSessionResponse {
            task_id: meta.task_id,
            dataset: dataset.id.to_string(),
            session: attempt::read_agent(&dir)?,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

pub async fn put_agent_session(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
    Json(update): Json<AgentSessionUpdate>,
) -> Result<Json<AgentSessionResponse>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let response = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&id))?;
        let meta = runner::read_meta(&dir)?;
        Ok(AgentSessionResponse {
            task_id: meta.task_id,
            dataset: dataset.id.to_string(),
            session: attempt::write_agent(&dir, update.messages)?,
        })
    })
    .await
    .map_err(not_found_if_unresolved)?;
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub struct FinishAttemptBody {
    /// Whether every case passed. The client knows this from the last run; the
    /// daemon does not second-guess it, but it does OR it with what the
    /// workspace already recorded.
    #[serde(default)]
    pub solved: bool,
    /// Keep the work. Unsolved: layout, code, and transcript all resume.
    /// Solved: the attempt is archived and the code stays. See
    /// [`crate::attempt`] for the full table.
    #[serde(default)]
    pub save: bool,
}

/// Leaving a problem — the save-or-discard choice.
pub async fn finish_attempt(
    State(state): State<Shared>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<DatasetQuery>,
    Json(body): Json<FinishAttemptBody>,
) -> Result<Json<AttemptOutcome>, AppError> {
    let dataset = query.resolve()?;
    let cfg = state.cfg_snapshot();
    let for_blocking = id.clone();
    let (outcome, task_id) = blocking(move || {
        let dir = runner::locate_workspace_in(&cfg, dataset, Some(&for_blocking))?;
        let meta = runner::read_meta(&dir)?;
        // The stub a discarded attempt resets to is the same one `lc load`
        // wrote, rebuilt from the corpus rather than remembered.
        let starter = problem::load_task_for(dataset, Path::new(&meta.json_path), &meta.task_id)
            .ok()
            .map(|problem| generator::solution_stub(&problem));
        let outcome = attempt::finish(&dir, body.solved, body.save, starter.as_deref())?;
        Ok((outcome, meta.task_id))
    })
    .await
    .map_err(not_found_if_unresolved)?;

    // A discarded attempt drops the server's board baseline too, or the next
    // visit's first review would be diffed against a board that no longer
    // exists and `new_since_last` would list every element as unchanged.
    if !outcome.kept_layout {
        let mut store = state.board_sessions.lock().await;
        store.clear_task(&dataset.key(&task_id));
        let pad_id = dataset.key(&task_id);
        let _ = blocking(move || {
            let conn = crate::pads::open(&crate::pads::db_path()?)?;
            crate::pads::tombstone(&conn, crate::pads::PadKind::Problem, &pad_id)?;
            Ok::<_, anyhow::Error>(())
        })
        .await;
    }
    Ok(Json(outcome))
}
