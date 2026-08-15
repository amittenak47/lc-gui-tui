//! Shared helpers for serve routes.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

use super::AppError;
use crate::config::Config;
use crate::dataset::{self, Dataset};
use crate::generator::WorkspaceMeta;
use crate::problem;
use crate::runner;

/// Which problem set a request is about.
///
/// Every corpus route carries this, because ids collide across datasets:
/// `two-sum` exists in three of them and means a different problem in each.
/// Absent means the default LeetCode corpus, so a client that predates
/// datasets keeps working unchanged.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct DatasetQuery {
    pub dataset: Option<String>,
}

impl DatasetQuery {
    pub(crate) fn resolve(&self) -> Result<&'static Dataset, AppError> {
        dataset::resolve(self.dataset.as_deref()).map_err(AppError::bad_request)
    }
}

/// A request's dataset slug, or a 400 naming the ones that exist.
pub(crate) fn resolve_dataset(slug: Option<&str>) -> Result<&'static Dataset, AppError> {
    dataset::resolve(slug).map_err(AppError::bad_request)
}

pub(crate) fn read_board_blob(dir: &Path) -> Result<Option<serde_json::Value>> {
    let path = dir.join("board.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    Ok(Some(
        serde_json::from_str(&text).context("board.json is not valid JSON")?,
    ))
}

pub(crate) fn load_meta(cfg: &Config, dataset: &'static Dataset, id: &str) -> Result<WorkspaceMeta> {
    if let Some(meta) = crate::pad::pad_meta_for(Some(dataset.id), id) {
        return Ok(meta);
    }
    let dir = runner::locate_workspace_in(cfg, dataset, Some(id))?;
    runner::read_meta(&dir)
}

/// The problem statement for a workspace, or `None` if the corpus file moved
/// since `lc load` — the same tolerance `lc ask` has.
pub(crate) fn description_for(meta: &WorkspaceMeta) -> Option<String> {
    if crate::pad::is_whiteboard_meta(meta) {
        return Some(crate::pad::WHITEBOARD_DESCRIPTION.to_string());
    }
    if crate::pad::is_annotate_meta(meta) {
        return Some(crate::pad::ANNOTATE_DESCRIPTION.to_string());
    }
    problem::load_task_for(meta.dataset(), Path::new(&meta.json_path), &meta.task_id)
        .ok()
        .and_then(|p| p.problem_description)
}

/// A missing problem or an un-materialized workspace is a 404, and an
/// ambiguous id is a 400 — neither is a server fault. Everything else keeps its
/// 500. The daemon has no error type of its own to match on, so this reads the
/// messages `loader::resolve`, `runner::locate_workspace`, and
/// `problem::load_task` already produce.
pub(crate) fn not_found_if_unresolved(err: AppError) -> AppError {
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
        let err = AppError::from(anyhow::anyhow!("{message}"));
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
