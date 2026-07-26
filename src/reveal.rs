//! The one deliberate hole in the redaction invariant.
//!
//! [`crate::problem::Problem`] cannot deserialize the corpus's `completion`
//! field, and that is enforced by a test. This module reads it anyway — but
//! only through [`SolutionReveal::load`], which demands a [`UserConsent`]
//! token, and `UserConsent` can only be built by
//! [`UserConsent::from_explicit_user_action`]. The daemon calls that in exactly
//! one place: the `POST /coach/reveal` handler, after the client has set the
//! confirmation flag its dialog produces.
//!
//! Nothing here is reachable from `Problem`, `WorkspaceMeta`, `lc ask`, the
//! review path, or the ambient path — see the tests at the bottom of this file
//! and in [`crate::llm::coach`].

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Proof that a human asked for this. Carries no data; its only purpose is to
/// make "read the reference solution" impossible to reach by accident.
///
/// It is deliberately not `Default`, not `Clone`, and has a private field, so
/// it cannot be conjured from a struct literal in another module.
#[derive(Debug)]
pub struct UserConsent(());

impl UserConsent {
    /// Call this **only** in direct response to an explicit user reveal action
    /// (a confirmation dialog, not a config flag and not a model tool call).
    pub fn from_explicit_user_action() -> Self {
        UserConsent(())
    }
}

/// Reads the corpus's reference solution. Constructed ONLY from an explicit
/// user reveal action; never reachable from Problem, WorkspaceMeta, or any
/// ambient/review code path.
#[derive(Debug, Clone, Deserialize)]
pub struct SolutionReveal {
    pub task_id: String,
    #[serde(default)]
    pub completion: Option<String>,
}

impl SolutionReveal {
    /// Load the reference solution for `task_id` from the corpus file the
    /// workspace was generated from (`WorkspaceMeta::json_path`).
    pub fn load(path: &Path, task_id: &str, _consent: UserConsent) -> Result<Self> {
        let found = if is_jsonl(path) {
            load_jsonl(path, task_id)?
        } else {
            load_json(path, task_id)?
        };
        let reveal = found.with_context(|| {
            format!("task_id {task_id:?} not found in {}", path.display())
        })?;
        if reveal.completion.as_deref().is_none_or(|c| c.trim().is_empty()) {
            bail!(
                "the corpus has no reference solution for {task_id:?} — \
                 nothing to reveal"
            );
        }
        Ok(reveal)
    }

    /// The reference text, guaranteed non-empty by [`SolutionReveal::load`].
    pub fn text(&self) -> &str {
        self.completion.as_deref().unwrap_or_default()
    }
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

fn load_json(path: &Path, task_id: &str) -> Result<Option<SolutionReveal>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read corpus file {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .with_context(|| format!("cannot parse corpus JSON {}", path.display()))?;
    let records = match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    };
    for record in records {
        let reveal: SolutionReveal = match serde_json::from_value(record) {
            Ok(reveal) => reveal,
            Err(_) => continue,
        };
        if reveal.task_id == task_id {
            return Ok(Some(reveal));
        }
    }
    Ok(None)
}

fn load_jsonl(path: &Path, task_id: &str) -> Result<Option<SolutionReveal>> {
    let file = File::open(path)
        .with_context(|| format!("cannot read corpus file {}", path.display()))?;
    for line in BufReader::new(file).lines() {
        let line = line.with_context(|| format!("cannot read {}", path.display()))?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(reveal) = serde_json::from_str::<SolutionReveal>(line) else {
            continue;
        };
        if reveal.task_id == task_id {
            return Ok(Some(reveal));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One line, so it can be reused as-is for the `.jsonl` case.
    const RECORD: &str = r#"{"task_id": "two-sum", "question_id": 1, "completion": "SECRET_SOLUTION_BODY", "response": "SECRET_RESPONSE", "query": "SECRET_QUERY", "input_output": []}"#;

    fn corpus(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lc-reveal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn reveal_reads_the_completion_when_consent_is_given() {
        let path = corpus("one.json", RECORD);
        let reveal =
            SolutionReveal::load(&path, "two-sum", UserConsent::from_explicit_user_action())
                .unwrap();
        assert_eq!(reveal.text(), "SECRET_SOLUTION_BODY");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reveal_reads_jsonl_corpora() {
        let path = corpus(
            "bulk.jsonl",
            &format!("{{\"task_id\": \"other\", \"completion\": \"X\"}}\n{RECORD}\n"),
        );
        let reveal =
            SolutionReveal::load(&path, "two-sum", UserConsent::from_explicit_user_action())
                .unwrap();
        assert_eq!(reveal.text(), "SECRET_SOLUTION_BODY");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn missing_reference_is_an_error_not_an_empty_bridge() {
        let path = corpus("empty.json", r#"{"task_id": "two-sum", "completion": ""}"#);
        let err = SolutionReveal::load(&path, "two-sum", UserConsent::from_explicit_user_action())
            .unwrap_err();
        assert!(err.to_string().contains("no reference solution"), "{err}");
        let _ = std::fs::remove_file(path);
    }

    /// The redaction invariant, from the other side: the same record that
    /// [`SolutionReveal`] happily reads must stay redacted through `Problem`
    /// and therefore through `WorkspaceMeta` and every prompt built from it.
    #[test]
    fn the_same_record_stays_redacted_through_problem() {
        let problem: crate::problem::Problem = serde_json::from_str(RECORD).unwrap();
        assert!(!format!("{problem:?}").contains("SECRET"));
    }

    /// `UserConsent` has a private field, so this module is the only place that
    /// can produce one. This test documents the intent; the compiler enforces
    /// it — `UserConsent(())` does not compile outside this module.
    #[test]
    fn consent_is_not_constructible_from_data() {
        let consent = UserConsent::from_explicit_user_action();
        assert_eq!(format!("{consent:?}"), "UserConsent(())");
    }
}
