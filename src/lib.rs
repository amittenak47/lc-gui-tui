//! `lc` as a library.
//!
//! The CLI (`src/main.rs`) and the LAN daemon ([`serve`]) are both thin shells
//! over the same modules. Nothing moved when the library root was introduced:
//! `main.rs` swapped its `mod` declarations for `use lc::*`, and every module
//! kept its existing `crate::`-relative paths.
//!
//! ## The redaction invariant
//!
//! [`problem::Problem`] cannot deserialize the corpus's `completion`,
//! `response`, or `query` fields, so reference solutions cannot reach the
//! workspace, the index, or a tutor prompt through it. [`reveal`] is the one
//! deliberate exception, reachable only from an explicit user action — see that
//! module's docs.

pub mod coach;
pub mod config;
pub mod generator;
pub mod index;
pub mod lists;
pub mod llm;
pub mod loader;
pub mod problem;
pub mod reveal;
pub mod runner;
pub mod serve;
pub mod session;
pub mod stats;
pub mod tui;
