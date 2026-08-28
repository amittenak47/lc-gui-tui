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
mod docs;
mod pads;
mod practice;
mod workspace;

pub(crate) use crate::serve::common;
pub(crate) use crate::serve::{blocking, AppError, Shared};

pub use attempt::{
    finish_attempt, get_agent_session, put_agent_session, AgentSessionResponse, AgentSessionUpdate,
    FinishAttemptBody,
};
pub use config::{
    get_config, llm_start, llm_models, llm_status, llm_stop, put_config, ConfigDto, ModesConfigDto,
    ProviderConfigDto,
};
pub use docs::{
    clear_local_index as clear_local_docs, embed as embed_docs, get_chunks as get_doc_chunks,
    get_index as get_docs_index, index_from_bytes as index_from_bytes_docs,
    list_chunk_digests as list_doc_chunk_digests, put_chunks as put_doc_chunks,
    put_index as put_docs_index, retrieve as retrieve_docs, retrieve_library as retrieve_library_docs,
};
pub use pads::{
    archive_annotate, archive_whiteboard, clone_device_prefs, get_device_prefs, get_doc_bytes,
    get_ink_pages, put_edges, put_ink_page, tombstone_edge,
    get_annotate, get_snapshots, get_whiteboard, list_annotate, list_devices, list_whiteboard,
    put_annotate, put_device_prefs,
    put_doc_bytes, put_problem, put_snapshot, put_whiteboard, restore_annotate,
    restore_whiteboard,
    sync_pads, tombstone_annotate, tombstone_problem, tombstone_whiteboard,
    get_problem as get_problem_pad,
};
pub use corpus::{
    adjacent_problem, get_problem, list_datasets, list_problems, list_tags, random_problem,
    AdjacentResponse, ProblemDetail, ProblemPage, ProblemSummary, SearchQuery,
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
