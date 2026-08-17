//! Corpus and problem listing routes.

use std::path::Path;

use anyhow::anyhow;
use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use super::common::DatasetQuery;
use super::{blocking, AppError, Shared};
use crate::dataset::{self, Dataset};
use crate::dataset::DatasetInfo;
use crate::index::{self, ProblemRow, SearchOrder, SearchSort};
use crate::loader;
use crate::problem::{self, IoCase, Problem};

#[derive(Debug, Serialize)]
pub struct ProblemSummary {
    pub dataset: String,
    pub task_id: String,
    /// `dataset/task_id` — what the session's progress map is keyed on, so the
    /// browser can badge a row without reassembling the key itself.
    pub key: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub test_count: i64,
}

impl From<ProblemRow> for ProblemSummary {
    fn from(row: ProblemRow) -> Self {
        Self {
            key: row.key(),
            dataset: row.dataset.to_string(),
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
    pub dataset: String,
    pub key: String,
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub problem_description: Option<String>,
    pub starter_code: Option<String>,
    pub entry_point: Option<String>,
    pub cases: Vec<IoCase>,
}

/// Built through [`detail_of`] rather than `From`, so the dataset a problem
/// was read from cannot be forgotten at a call site.
fn detail_of(dataset: &Dataset, p: Problem) -> ProblemDetail {
    ProblemDetail::from(p).with_dataset(dataset)
}

impl ProblemDetail {
    fn with_dataset(mut self, dataset: &Dataset) -> Self {
        self.key = dataset.key(&self.task_id);
        self.dataset = dataset.id.to_string();
        self
    }
}

impl From<Problem> for ProblemDetail {
    fn from(p: Problem) -> Self {
        // Full editor stub (filtered helpers + Solution), same as solution.py —
        // not the corpus `starter_code` field alone, which is often just the class.
        let starter = {
            let body = crate::generator::code_body(&p);
            if body.trim().is_empty() {
                p.starter_code
            } else {
                Some(body)
            }
        };
        Self {
            dataset: dataset::DEFAULT_DATASET.to_string(),
            key: dataset::default().key(&p.task_id),
            task_id: p.task_id,
            question_id: p.question_id,
            difficulty: p.difficulty,
            tags: p.tags,
            problem_description: p.problem_description,
            starter_code: starter,
            entry_point: p.entry_point,
            cases: p.input_output,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct SearchQuery {
    /// Which problem set to search. Absent = the default LeetCode corpus.
    pub dataset: Option<String>,
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

/// Neighbors of `id` in the same filtered bank order the browser uses.
#[derive(Debug, Serialize)]
pub struct AdjacentResponse {
    pub task_id: String,
    pub prev: Option<String>,
    pub next: Option<String>,
}

/// Paginated search, so the client can page through the corpus the way the TUI
/// does rather than pulling a capped slice and pretending that is everything.
pub async fn list_problems(
    Query(query): Query<SearchQuery>,
) -> Result<Json<ProblemPage>, AppError> {
    let dataset = dataset::resolve(query.dataset.as_deref()).map_err(AppError::bad_request)?;
    let page = blocking(move || {
        let sort = match query.sort.as_deref() {
            Some(raw) => SearchOrder::parse(raw)
                .ok_or_else(|| anyhow!("unknown sort {raw:?} — expected task_id, question, difficulty, cases, or tags"))?,
            None => SearchSort::TaskId.into(),
        };
        let limit = query.limit.unwrap_or(15).clamp(1, 500);
        let offset = query.offset.unwrap_or(0);

        let conn = index::open_db()?;
        let total = index::search_count(
            &conn,
            dataset,
            query.difficulty.as_deref(),
            query.tag.as_deref(),
            query.q.as_deref(),
        )?;
        let rows = index::search_page(
            &conn,
            dataset,
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
pub async fn list_tags(Query(query): Query<DatasetQuery>) -> Result<Json<Vec<String>>, AppError> {
    let dataset = query.resolve()?;
    let tags = blocking(move || {
        let conn = index::open_db()?;
        index::all_tags(&conn, dataset)
    })
    .await?;
    Ok(Json(tags))
}

/// The tab strip over the problem table: every dataset and how many problems
/// it has indexed, so an un-downloaded corpus shows as empty rather than
/// missing.
pub async fn list_datasets(State(state): State<Shared>) -> Result<Json<Vec<DatasetInfo>>, AppError> {
    let cfg = state.cfg_snapshot();
    let infos = blocking(move || {
        let conn = index::open_db()?;
        index::dataset_infos(&conn, &cfg)
    })
    .await?;
    Ok(Json(infos))
}

/// One random problem matching the current filter — the TUI's `R`.
pub async fn random_problem(
    Query(query): Query<SearchQuery>,
) -> Result<Json<Option<ProblemSummary>>, AppError> {
    let dataset = dataset::resolve(query.dataset.as_deref()).map_err(AppError::bad_request)?;
    let row = blocking(move || {
        let conn = index::open_db()?;
        index::random_one(
            &conn,
            dataset,
            query.difficulty.as_deref(),
            query.tag.as_deref(),
            query.q.as_deref(),
        )
    })
    .await?;
    Ok(Json(row.map(ProblemSummary::from)))
}

pub async fn adjacent_problem(
    UrlPath(id): UrlPath<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<AdjacentResponse>, AppError> {
    let dataset = dataset::resolve(query.dataset.as_deref()).map_err(AppError::bad_request)?;
    let response = blocking(move || {
        let sort = match query.sort.as_deref() {
            Some(raw) => SearchOrder::parse(raw).ok_or_else(|| {
                anyhow!("unknown sort {raw:?} — expected task_id, question, difficulty, cases, or tags")
            })?,
            None => SearchSort::TaskId.into(),
        };
        let conn = index::open_db()?;
        let (prev, next) = index::adjacent_task_ids(
            &conn,
            dataset,
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
    Query(query): Query<DatasetQuery>,
) -> Result<Json<ProblemDetail>, AppError> {
    let dataset = query.resolve()?;
    let problem = blocking(move || {
        let conn = index::open_db()?;
        let row = loader::resolve_in(&conn, dataset, &id)?;
        problem::load_task_for(dataset, Path::new(&row.json_path), &row.task_id)
    })
    .await
    .map_err(super::common::not_found_if_unresolved)?;
    Ok(Json(detail_of(dataset, problem)))
}
