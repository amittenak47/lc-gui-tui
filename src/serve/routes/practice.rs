//! Practice session routes (`session.json`).

use axum::Json;
use serde::{Deserialize, Serialize};

use super::blocking;
use super::AppError;
use crate::dataset;
use crate::index;
use crate::session::Session;

/// Practice session on disk (`session.json`) — queue, progress, active list.
#[derive(Debug, Serialize)]
pub struct SessionStats {
    pub loaded: u32,
    pub passed: u32,
    pub failed: u32,
    pub reveals: u32,
    pub queue_len: u32,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub started_at: u64,
    pub active_list: Option<String>,
    pub queue: Vec<String>,
    pub problems: std::collections::HashMap<String, crate::session::ProblemProgress>,
    pub reveals: std::collections::HashMap<String, u32>,
    pub stats: SessionStats,
}

fn session_response(session: Session) -> SessionResponse {
    use crate::session::ProblemState;
    let mut loaded = 0u32;
    let mut passed = 0u32;
    let mut failed = 0u32;
    for p in session.problems.values() {
        match p.state {
            ProblemState::Loaded => loaded += 1,
            ProblemState::Passed => passed += 1,
            ProblemState::Failed => failed += 1,
        }
    }
    let reveals: u32 = session.reveals.values().copied().sum();
    let queue_len = session.queue.len() as u32;
    SessionResponse {
        started_at: session.started_at,
        active_list: session.active_list,
        queue: session.queue,
        problems: session.problems,
        reveals: session.reveals,
        stats: SessionStats {
            loaded,
            passed,
            failed,
            reveals,
            queue_len,
        },
    }
}

pub async fn get_session() -> Result<Json<SessionResponse>, AppError> {
    let session = blocking(move || Session::load_or_new()).await?;
    Ok(Json(session_response(session)))
}

#[derive(Debug, Deserialize)]
pub struct EnqueueBody {
    pub task_id: String,
    #[serde(default)]
    pub dataset: Option<String>,
}

pub async fn reset_session() -> Result<Json<SessionResponse>, AppError> {
    let session = blocking(move || Session::reset()).await?;
    Ok(Json(session_response(session)))
}

pub async fn enqueue_session(
    Json(body): Json<EnqueueBody>,
) -> Result<Json<SessionResponse>, AppError> {
    let dataset = dataset::resolve(body.dataset.as_deref()).map_err(AppError::bad_request)?;
    let session = blocking(move || {
        let mut session = Session::load_or_new()?;
        session.add_to_queue(&dataset.key(&body.task_id))?;
        Session::load_or_new()
    })
    .await?;
    Ok(Json(session_response(session)))
}

#[derive(Debug, Deserialize)]
pub struct RandomSessionBody {
    #[serde(default)]
    pub dataset: Option<String>,
    pub count: Option<u32>,
    pub difficulty: Option<String>,
    pub tag: Option<String>,
    pub q: Option<String>,
}

/// Start a random practice session: reset, then fill the queue with N distinct
/// random problems matching the optional filters.
pub async fn random_session(
    Json(body): Json<RandomSessionBody>,
) -> Result<Json<SessionResponse>, AppError> {
    let dataset = dataset::resolve(body.dataset.as_deref()).map_err(AppError::bad_request)?;
    let session = blocking(move || {
        let count = body.count.unwrap_or(5).clamp(1, 50) as usize;
        let mut session = Session::reset()?;
        let conn = index::open_db()?;
        let mut seen = std::collections::HashSet::new();
        let mut attempts = 0;
        while session.queue.len() < count && attempts < count * 20 {
            attempts += 1;
            let Some(row) = index::random_one(
                &conn,
                dataset,
                body.difficulty.as_deref(),
                body.tag.as_deref(),
                body.q.as_deref(),
            )?
            else {
                break;
            };
            if seen.insert(row.task_id.clone()) {
                session.add_to_queue(&row.key())?;
            }
        }
        Session::load_or_new()
    })
    .await?;
    Ok(Json(session_response(session)))
}
