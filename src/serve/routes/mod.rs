//! Corpus and workspace routes.
//!
//! Every response body is a DTO defined here rather than a re-serialized
//! internal struct. That keeps `index.rs`, `problem.rs`, `generator.rs`, and
//! `runner.rs` untouched, and it makes the wire format an explicit, auditable
//! list of fields — which is how `ProblemDetail` can be read at a glance as
//! carrying no solution text.

mod attempt;
mod config;
mod corpus;
mod practice;
mod workspace;

pub(crate) use crate::serve::common;
pub(crate) use crate::serve::{blocking, AppError, Shared};

pub use attempt::{
    finish_attempt, get_agent_session, put_agent_session, AgentSessionResponse, AgentSessionUpdate,
    FinishAttemptBody,
};
pub use config::{
    get_config, llm_start, llm_status, llm_stop, put_config, ConfigDto, ModesConfigDto,
    ProviderConfigDto,
};
pub use corpus::{
    adjacent_problem, get_problem, list_datasets, list_problems, list_tags, offline_pack,
    random_problem, AdjacentResponse, OfflinePack, ProblemDetail, ProblemPage, ProblemSummary,
    SearchQuery,
};
pub use practice::{
    enqueue_session, get_session, random_session, reset_session, EnqueueBody, RandomSessionBody,
    SessionResponse, SessionStats,
};
pub use workspace::{
    get_board, get_solution, load_problem, open_workspace, put_board, put_solution, run_tests,
    workspace_meta, BoardBlob, BoardResponse, LoadResponse, OpenWorkspaceBody,
    OpenWorkspaceResponse, ResumeState, SolutionResponse, SolutionUpdate, TestResponse,
};

pub use super::common::DatasetQuery;
