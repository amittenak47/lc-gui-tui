//! `whiteboard` as a library.
//!
//! The CLI (`src/main.rs`) and the LAN daemon ([`serve`]) are both thin shells
//! over the same modules. Package layout groups harness concerns (`corpus`,
//! `workspace`, `practice`, `gate`, `design`); [`lib`] re-exports the historical
//! `crate::dataset`, `crate::generator`, … paths so callers stay stable.
//!
//! ## The redaction invariant
//!
//! [`problem::Problem`] cannot deserialize the corpus's `completion`,
//! `response`, or `query` fields, so reference solutions cannot reach the
//! workspace, the index, or a tutor prompt through it. [`reveal`] is the one
//! deliberate exception, reachable only from an explicit user action — see that
//! module's docs.
//!
//! [`datasets`] adds a second front to defend: its adapters build a `Problem`
//! by hand from a differently-shaped corpus, so serde's protection does not
//! apply to them. That module lists the solution-bearing columns and tests that
//! no adapter reads one.

pub mod config;
pub mod corpus;
pub mod datasets;
pub mod design;
pub mod gate;
pub mod llm;
pub mod practice;
pub mod pad;
pub mod docs_index;
pub mod serve;
pub mod tui;
pub mod workspace;

pub use corpus::dataset;
pub use corpus::index;
pub use corpus::lists;
pub use corpus::loader;
pub use corpus::problem;
pub use design::context as coach;
pub use gate::reveal;
pub use practice::session;
pub use practice::stats;
pub use workspace::attempt;
pub use workspace::generator;
pub use workspace::runner;
