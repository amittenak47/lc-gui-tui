//! The coach loop, defined against a trait so it generalizes past LeetCode.
//!
//! Phase 6 of the plan is design-only: the point is that the transport
//! (`serve::ws`), the canvas, and the viz renderers never mention LeetCode, so
//! a future `ScreenContext` — "Google Lens for whatever I'm working on" — slots
//! in by implementing [`CoachContext`] and nothing else moves.
//!
//! [`LeetCodeContext`] is the first implementation. Its ground truth is the
//! problem's sample cases, and verifying a claim means checking it against a
//! real case rather than a case the model invented.

use crate::generator::WorkspaceMeta;
use crate::llm::coach::{AMBIENT_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT};

/// One piece of checkable ground truth. For LeetCode this is a sample case;
/// for a future screen context it might be a log line or a pixel region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evidence {
    /// Stable handle the coach cites — for LeetCode, the 0-based case index.
    pub id: usize,
    pub label: String,
    pub content: String,
}

/// Something the coach asserted that can be checked before the student sees it.
#[derive(Debug, Clone)]
pub struct Claim {
    /// The assertion, in the coach's words.
    pub text: String,
    /// Evidence ids the coach cited to support it.
    pub cites: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Every citation resolves to real evidence.
    Supported(Vec<Evidence>),
    /// At least one citation does not exist; the claim must not be shown as-is.
    Fabricated { bad_citations: Vec<usize> },
    /// Nothing was cited, so there is nothing to check.
    Unverifiable,
}

/// What a coach needs to know about the thing it is coaching.
pub trait CoachContext {
    /// Which mode's system prompt applies (`"review"` or `"ambient"`).
    fn system_prompt(&self, mode: &str) -> String;
    /// Everything the coach is allowed to cite.
    fn ground_truth(&self) -> Vec<Evidence>;
    /// Check a claim's citations against that ground truth.
    fn verify(&self, claim: &Claim) -> Verdict {
        if claim.cites.is_empty() {
            return Verdict::Unverifiable;
        }
        let truth = self.ground_truth();
        let mut resolved = Vec::new();
        let mut bad = Vec::new();
        for id in &claim.cites {
            match truth.iter().find(|e| e.id == *id) {
                Some(evidence) => resolved.push(evidence.clone()),
                None => bad.push(*id),
            }
        }
        if bad.is_empty() {
            Verdict::Supported(resolved)
        } else {
            Verdict::Fabricated { bad_citations: bad }
        }
    }
}

/// The LeetCode implementation: ground truth is the problem's sample I/O, and
/// the deeper form of verification — actually running the tests — is
/// `runner::cmd_test_quiet`, exposed as `POST /workspace/:id/test`.
pub struct LeetCodeContext {
    pub meta: WorkspaceMeta,
    pub description: Option<String>,
}

impl LeetCodeContext {
    pub fn new(meta: WorkspaceMeta, description: Option<String>) -> Self {
        Self { meta, description }
    }
}

impl CoachContext for LeetCodeContext {
    fn system_prompt(&self, mode: &str) -> String {
        match mode {
            "ambient" => AMBIENT_SYSTEM_PROMPT.to_string(),
            _ => REVIEW_SYSTEM_PROMPT.to_string(),
        }
    }

    fn ground_truth(&self) -> Vec<Evidence> {
        self.meta
            .cases
            .iter()
            .enumerate()
            .map(|(id, case)| Evidence {
                id,
                label: format!("case {}", id + 1),
                content: format!("input: {} → expected: {}", case.input, case.output),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::problem::IoCase;

    fn context(cases: usize) -> LeetCodeContext {
        LeetCodeContext::new(
            WorkspaceMeta {
                task_id: "two-sum".into(),
                question_id: None,
                difficulty: None,
                tags: vec![],
                entry_point: None,
                json_path: "corpus.jsonl".into(),
                cases: (0..cases)
                    .map(|i| IoCase {
                        input: format!("nums = [{i}]"),
                        output: format!("[{i}]"),
                    })
                    .collect(),
                test: None,
            },
            None,
        )
    }

    #[test]
    fn real_citations_are_supported() {
        let claim = Claim {
            text: "duplicates break the two-pointer scan".into(),
            cites: vec![0, 2],
        };
        match context(3).verify(&claim) {
            Verdict::Supported(evidence) => assert_eq!(evidence.len(), 2),
            other => panic!("expected support, got {other:?}"),
        }
    }

    #[test]
    fn invented_citations_are_caught_before_the_student_sees_them() {
        let claim = Claim {
            text: "case 42 breaks it".into(),
            cites: vec![1, 42],
        };
        assert_eq!(
            context(3).verify(&claim),
            Verdict::Fabricated {
                bad_citations: vec![42]
            }
        );
    }

    #[test]
    fn an_uncited_claim_is_unverifiable_not_supported() {
        let claim = Claim {
            text: "this feels quadratic".into(),
            cites: vec![],
        };
        assert_eq!(context(3).verify(&claim), Verdict::Unverifiable);
    }

    #[test]
    fn ground_truth_never_carries_a_reference_solution() {
        // It is built from WorkspaceMeta, which is built from Problem.
        let evidence = context(2).ground_truth();
        assert!(evidence.iter().all(|e| !e.content.contains("completion")));
        assert_eq!(evidence[1].label, "case 2", "labels are 1-based for humans");
    }
}
