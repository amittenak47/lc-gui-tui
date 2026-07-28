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
use crate::attempt::{self, AgentSession, AttemptOutcome, AttemptState};
use crate::config::Config;
use crate::dataset::{self, Dataset, DatasetInfo};
use crate::generator::WorkspaceMeta;
use crate::index::{self, ProblemRow, SearchSort};
use crate::problem::{IoCase, Problem};
use crate::runner::{self, CaseResult};
use crate::session::Session;
use crate::{generator, loader, problem};

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
    fn resolve(&self) -> Result<&'static Dataset, AppError> {
        dataset::resolve(self.dataset.as_deref()).map_err(AppError::bad_request)
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Paginated search, so the client can page through the corpus the way the TUI
/// does rather than pulling a capped slice and pretending that is everything.
pub async fn list_problems(
    Query(query): Query<SearchQuery>,
) -> Result<Json<ProblemPage>, AppError> {
    let dataset = dataset::resolve(query.dataset.as_deref()).map_err(AppError::bad_request)?;
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

// ---------------------------------------------------------------------------
// Config (shared with TUI / `lc config`)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderConfigDto {
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModesConfigDto {
    pub ambient: String,
    pub review: String,
    pub bridge: String,
    pub viz: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigDto {
    pub data_json_dir: Option<String>,
    /// Per-dataset corpus folders, keyed by dataset slug. Only the ones the
    /// user overrode are present.
    #[serde(default)]
    pub dataset_dirs: std::collections::BTreeMap<String, String>,
    pub workspace_dir: String,
    pub python_executable: String,
    /// Settings → Tests: stop at the first failing case instead of running
    /// every case.
    #[serde(default)]
    pub stop_on_first_failure: bool,
    pub default_provider: String,
    pub local: ProviderConfigDto,
    pub ollama: ProviderConfigDto,
    pub openai: ProviderConfigDto,
    pub groq: ProviderConfigDto,
    pub modes: ModesConfigDto,
    pub serve_port: u16,
    /// Present on GET only — never echo the secret.
    #[serde(default)]
    pub token_set: bool,
}

fn config_dto(cfg: &Config) -> ConfigDto {
    ConfigDto {
        data_json_dir: cfg.data.json_dir.clone(),
        dataset_dirs: cfg.data.datasets.clone(),
        workspace_dir: cfg.workspace.dir.clone(),
        python_executable: cfg.python.executable.clone(),
        stop_on_first_failure: cfg.tests.stop_on_first_failure,
        default_provider: cfg.llm.default_provider.clone(),
        local: ProviderConfigDto {
            base_url: cfg.llm.local.base_url.clone(),
            model: cfg.llm.local.model.clone(),
            vision_model: cfg.llm.local.vision_model.clone(),
        },
        ollama: ProviderConfigDto {
            base_url: cfg.llm.ollama.base_url.clone(),
            model: cfg.llm.ollama.model.clone(),
            vision_model: cfg.llm.ollama.vision_model.clone(),
        },
        openai: ProviderConfigDto {
            base_url: cfg.llm.openai.base_url.clone(),
            model: cfg.llm.openai.model.clone(),
            vision_model: cfg.llm.openai.vision_model.clone(),
        },
        groq: ProviderConfigDto {
            base_url: cfg.llm.groq.base_url.clone(),
            model: cfg.llm.groq.model.clone(),
            vision_model: cfg.llm.groq.vision_model.clone(),
        },
        modes: ModesConfigDto {
            ambient: cfg.llm.modes.ambient.clone(),
            review: cfg.llm.modes.review.clone(),
            bridge: cfg.llm.modes.bridge.clone(),
            viz: cfg.llm.modes.viz.clone(),
        },
        serve_port: cfg.serve.port,
        token_set: cfg
            .serve
            .token
            .as_ref()
            .is_some_and(|t| !t.trim().is_empty()),
    }
}

fn apply_config_dto(cfg: &mut Config, dto: &ConfigDto) -> Result<()> {
    cfg.data.json_dir = dto
        .data_json_dir
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    cfg.data.datasets = dto
        .dataset_dirs
        .iter()
        .filter(|(slug, dir)| dataset::get(slug).is_ok() && !dir.trim().is_empty())
        .map(|(slug, dir)| (slug.clone(), dir.trim().to_string()))
        .collect();
    cfg.workspace.dir = dto.workspace_dir.clone();
    cfg.python.executable = dto.python_executable.clone();
    cfg.tests.stop_on_first_failure = dto.stop_on_first_failure;
    cfg.set("llm.default_provider", &dto.default_provider)?;
    cfg.llm.local.base_url = dto.local.base_url.clone();
    cfg.llm.local.model = dto.local.model.clone();
    cfg.llm.local.vision_model = dto.local.vision_model.clone();
    cfg.llm.ollama.base_url = dto.ollama.base_url.clone();
    cfg.llm.ollama.model = dto.ollama.model.clone();
    cfg.llm.ollama.vision_model = dto.ollama.vision_model.clone();
    cfg.llm.openai.base_url = dto.openai.base_url.clone();
    cfg.llm.openai.model = dto.openai.model.clone();
    cfg.llm.openai.vision_model = dto.openai.vision_model.clone();
    cfg.llm.groq.base_url = dto.groq.base_url.clone();
    cfg.llm.groq.model = dto.groq.model.clone();
    cfg.llm.groq.vision_model = dto.groq.vision_model.clone();
    cfg.set("llm.modes.ambient", &dto.modes.ambient)?;
    cfg.set("llm.modes.review", &dto.modes.review)?;
    cfg.set("llm.modes.bridge", &dto.modes.bridge)?;
    cfg.set("llm.modes.viz", &dto.modes.viz)?;
    cfg.serve.port = dto.serve_port;
    Ok(())
}

pub async fn get_config(State(state): State<Shared>) -> Result<Json<ConfigDto>, AppError> {
    Ok(Json(config_dto(&state.cfg_snapshot())))
}

pub async fn put_config(
    State(state): State<Shared>,
    Json(dto): Json<ConfigDto>,
) -> Result<Json<ConfigDto>, AppError> {
    let mut cfg = state.cfg_snapshot();
    let updated = blocking(move || {
        apply_config_dto(&mut cfg, &dto)?;
        cfg.save()?;
        Ok(cfg)
    })
    .await?;
    {
        let mut guard = state.cfg.write().unwrap_or_else(|e| e.into_inner());
        *guard = updated.clone();
    }
    Ok(Json(config_dto(&updated)))
}

// ---------------------------------------------------------------------------
// Local LLM lifecycle
// ---------------------------------------------------------------------------

pub async fn llm_status(State(state): State<Shared>) -> Result<Json<crate::llm::lifecycle::LlmStatus>, AppError> {
    let cfg = state.cfg_snapshot();
    Ok(Json(blocking(move || Ok(crate::llm::lifecycle::status(&cfg))).await?))
}

pub async fn llm_start(State(state): State<Shared>) -> Result<Json<crate::llm::lifecycle::LlmStatus>, AppError> {
    let cfg = state.cfg_snapshot();
    Ok(Json(
        blocking(move || crate::llm::lifecycle::start_local_llm(&cfg)).await?,
    ))
}

pub async fn llm_stop(State(state): State<Shared>) -> Result<Json<crate::llm::lifecycle::LlmStatus>, AppError> {
    let cfg = state.cfg_snapshot();
    Ok(Json(
        blocking(move || crate::llm::lifecycle::stop_local_llm(&cfg)).await?,
    ))
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
    let dataset = dataset::resolve(query.dataset.as_deref()).map_err(AppError::bad_request)?;
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
    .map_err(not_found_if_unresolved)?;
    Ok(Json(detail_of(dataset, problem)))
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
// Agent session and attempt lifecycle
// ---------------------------------------------------------------------------

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
    }
    Ok(Json(outcome))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn read_board_blob(dir: &Path) -> Result<Option<serde_json::Value>> {
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
    let dir = runner::locate_workspace_in(cfg, dataset, Some(id))?;
    runner::read_meta(&dir)
}

/// The problem statement for a workspace, or `None` if the corpus file moved
/// since `lc load` — the same tolerance `lc ask` has.
pub(crate) fn description_for(meta: &WorkspaceMeta) -> Option<String> {
    problem::load_task_for(meta.dataset(), Path::new(&meta.json_path), &meta.task_id)
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
