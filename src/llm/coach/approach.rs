//! Which approach this board session is coaching, and what it takes to leave it.
//!
//! Most interesting problems have several valid approaches, and the coach has
//! no official solution to check against — it judges the student's own claim.
//! That is the right design, and it has one failure mode: a model that knows
//! three valid approaches can read a half-drawn board as approach A on one
//! turn and approach B on the next, then coach the student toward whichever it
//! happened to see. From the student's side that is worse than being wrong
//! consistently, because the advice contradicts itself.
//!
//! So the session commits. The first usable claim becomes the committed
//! approach; later stages are handed it as frozen, the same way the claim
//! itself already is. Leaving it takes an [`ApproachTransition`] with a reason,
//! and the student is told.
//!
//! The rule that does the actual work is in [`ApproachSession::observe_claim`]:
//! **a different reading of the same drawing is the model changing its mind,
//! not the student changing theirs.** Only a board that actually changed can
//! move the commitment. Nothing here asks a model whether it is flip-flopping
//! — that is the question a flip-flopping model is worst at.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::stages::Claim;

/// Where a commitment came from. Kept because the answer changes what may
/// overturn it: what the student *said* outranks what a model *read*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitSource {
    /// Inferred from the drawing by the claim stage.
    BoardClaim,
    /// The student named it in prose.
    StudentSaid,
    /// Taken from the planner's catalog with no board yet.
    PlannerSuggest,
    /// The student asked to switch.
    ExplicitSwitch,
}

/// One approach family the planner knows about. Never a full solution: a
/// catalog entry is the shape of an idea, not code.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ApproachCandidate {
    /// Short label the planner assigns ("A", "B", …), for referring back.
    pub id: String,
    pub name: String,
    pub when_to_use: String,
    pub strengths: Vec<String>,
    pub weaknesses: Vec<String>,
    /// The shape of the approach, not its implementation.
    pub sketch_steps: Vec<String>,
}

/// The approach this session is coaching, until something explicit moves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedApproach {
    /// Catalog id when the claim matched one; `None` when the student invented
    /// something the planner did not list, which is allowed and common.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub key_steps: Vec<String>,
    pub source: CommitSource,
    /// The board this was read off. A claim about a drawing the student has
    /// since changed cannot be defended against a new one.
    pub committed_at_fingerprint: u64,
}

/// A recorded move from one approach to another, with the reason. The reason is
/// required: a switch nobody can explain is the flip-flop this module exists to
/// stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApproachTransition {
    pub from: String,
    pub to: String,
    pub reason: String,
    /// What survives the move. Almost never nothing, and saying so is the
    /// difference between "start over" and "keep going".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub what_carries_over: Vec<String>,
}

/// What [`ApproachSession::observe_claim`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApproachOutcome {
    /// Nothing was committed; this claim is the commitment now.
    Committed,
    /// The same approach as the one already committed. Coach within it.
    Held,
    /// A different reading of a board that did not change. The commitment
    /// stands and the new reading is discarded — see the module docs.
    HeldAgainstDrift { discarded: String },
    /// The board changed and no longer argues for the committed approach.
    Transitioned(ApproachTransition),
}

impl ApproachOutcome {
    /// The line to show the student, if any. Holding is silent: a coach that
    /// announces "still the same approach" every turn is noise.
    pub fn note(&self) -> Option<String> {
        match self {
            ApproachOutcome::Transitioned(transition) => Some(format!(
                "Switching from “{}” to “{}” — {}",
                transition.from, transition.to, transition.reason
            )),
            _ => None,
        }
    }
}

/// What the session already decided, handed to every stage after the claim.
///
/// Everything on it is optional, and the default — nothing committed, no
/// catalog — is exactly the behaviour that shipped before any of this existed.
/// That matters: the TUI, the tests, and any caller that has no board session
/// pass the default and get the old prompts back, unchanged.
#[derive(Debug, Clone, Default)]
pub struct CoachContext {
    pub committed: Option<CommittedApproach>,
    pub catalog: Vec<ApproachCandidate>,
}

impl CoachContext {
    pub fn committed(&self) -> Option<&CommittedApproach> {
        self.committed.as_ref()
    }
}

/// Per-board-session approach state.
#[derive(Debug, Clone, Default)]
pub struct ApproachSession {
    /// From the planner. Empty whenever the planner did not run, which is the
    /// default — everything here works without it.
    pub catalog: Vec<ApproachCandidate>,
    pub committed: Option<CommittedApproach>,
    pub transition_log: Vec<ApproachTransition>,
}

impl ApproachSession {
    /// Drop everything. Called when the task changes: a catalog for one problem
    /// is worse than none for another.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn set_catalog(&mut self, catalog: Vec<ApproachCandidate>) {
        self.catalog = catalog;
    }

    /// Whether the planner has already run for this session.
    pub fn has_catalog(&self) -> bool {
        !self.catalog.is_empty()
    }

    /// What the stages after the claim should be told.
    pub fn context(&self) -> CoachContext {
        CoachContext {
            committed: self.committed.clone(),
            catalog: self.catalog.clone(),
        }
    }

    /// Fold a fresh claim into the commitment, and say what happened.
    pub fn observe_claim(&mut self, fingerprint: u64, claim: &Claim) -> ApproachOutcome {
        let named = claim.understood_approach.trim();
        if named.is_empty() {
            return match self.committed {
                Some(_) => ApproachOutcome::Held,
                None => ApproachOutcome::Held,
            };
        }

        let Some(current) = self.committed.clone() else {
            self.committed = Some(self.commitment_from(fingerprint, claim));
            return ApproachOutcome::Committed;
        };

        if same_approach(&current.name, named) || shares_steps(&current.key_steps, &claim.key_steps)
        {
            // Same idea, possibly better articulated. Keep the steps that grew.
            if let Some(committed) = self.committed.as_mut() {
                if claim.key_steps.len() > committed.key_steps.len() {
                    committed.key_steps = claim.key_steps.clone();
                }
                committed.committed_at_fingerprint = fingerprint;
            }
            return ApproachOutcome::Held;
        }

        if current.committed_at_fingerprint == fingerprint {
            // The drawing is byte-for-byte the one the commitment was read off,
            // and the model now reads it differently. That is drift.
            return ApproachOutcome::HeldAgainstDrift {
                discarded: named.to_string(),
            };
        }

        let transition = ApproachTransition {
            from: current.name.clone(),
            to: named.to_string(),
            reason: "your board changed and now argues for a different idea".to_string(),
            what_carries_over: current
                .key_steps
                .iter()
                .filter(|step| {
                    claim
                        .key_steps
                        .iter()
                        .any(|fresh| same_approach(step, fresh))
                })
                .cloned()
                .collect(),
        };
        self.committed = Some(self.commitment_from(fingerprint, claim));
        self.transition_log.push(transition.clone());
        ApproachOutcome::Transitioned(transition)
    }

    /// Move to a named approach because the student asked. Their word outranks
    /// the drift rule — this is the one path that ignores the fingerprint.
    pub fn switch_on_request(
        &mut self,
        fingerprint: u64,
        name: &str,
        reason: &str,
    ) -> ApproachOutcome {
        let name = name.trim();
        if name.is_empty() {
            return ApproachOutcome::Held;
        }
        let from = self
            .committed
            .as_ref()
            .map(|current| current.name.clone())
            .unwrap_or_default();
        if same_approach(&from, name) {
            return ApproachOutcome::Held;
        }
        let matched = self.match_catalog(name);
        self.committed = Some(CommittedApproach {
            id: matched.as_ref().map(|entry| entry.id.clone()),
            name: matched
                .as_ref()
                .map(|entry| entry.name.clone())
                .unwrap_or_else(|| name.to_string()),
            key_steps: matched
                .as_ref()
                .map(|entry| entry.sketch_steps.clone())
                .unwrap_or_default(),
            source: CommitSource::ExplicitSwitch,
            committed_at_fingerprint: fingerprint,
        });
        if from.is_empty() {
            return ApproachOutcome::Committed;
        }
        let transition = ApproachTransition {
            from,
            to: name.to_string(),
            reason: reason.trim().to_string(),
            what_carries_over: Vec::new(),
        };
        self.transition_log.push(transition.clone());
        ApproachOutcome::Transitioned(transition)
    }

    /// Up to three alternatives worth naming when the board is ambiguous.
    ///
    /// Only ever *offered* — listing alternatives is not choosing one, and the
    /// commitment does not move until the student picks or draws.
    pub fn candidates_for(&self, claim: &Claim) -> Vec<ApproachCandidate> {
        if claim.decides_the_answer() {
            return Vec::new();
        }
        let mut out: Vec<ApproachCandidate> = Vec::new();
        for name in &claim.compatible_alternatives {
            let entry = self.match_catalog(name).unwrap_or(ApproachCandidate {
                name: name.clone(),
                ..Default::default()
            });
            if !out.iter().any(|kept| same_approach(&kept.name, &entry.name)) {
                out.push(entry);
            }
        }
        out.truncate(3);
        out
    }

    fn commitment_from(&self, fingerprint: u64, claim: &Claim) -> CommittedApproach {
        let matched = claim
            .matched_approach_id
            .as_deref()
            .and_then(|id| self.catalog.iter().find(|entry| entry.id == id))
            .or_else(|| self.match_catalog(&claim.understood_approach).map(|_| {
                // `match_catalog` returns a clone; re-find to borrow.
                self.catalog
                    .iter()
                    .find(|entry| same_approach(&entry.name, &claim.understood_approach))
                    .expect("just matched")
            }));
        CommittedApproach {
            id: matched.map(|entry| entry.id.clone()),
            name: claim.understood_approach.trim().to_string(),
            key_steps: claim.key_steps.clone(),
            source: CommitSource::BoardClaim,
            committed_at_fingerprint: fingerprint,
        }
    }

    fn match_catalog(&self, name: &str) -> Option<ApproachCandidate> {
        self.catalog
            .iter()
            .find(|entry| same_approach(&entry.name, name) || entry.id == name.trim())
            .cloned()
    }
}

/// Words too common to tell two approaches apart. Deliberately short: the point
/// is to strip filler, not to build a stemmer.
const FILLER: [&str; 24] = [
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "then", "use", "using",
    "each", "every", "all", "it", "is", "are", "we", "you", "your", "by",
];

fn distinctive_words(text: &str) -> BTreeSet<String> {
    text.to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() > 1 && !FILLER.contains(word))
        .map(str::to_string)
        .collect()
}

/// Do two descriptions name the same idea?
///
/// Word overlap rather than string equality, because the same approach comes
/// back phrased differently every turn — "two pointers from both ends" and
/// "two pointers, one at each end" are not a switch. The bar is deliberately
/// low: over-merging costs a held commitment the student can correct, while
/// under-merging costs a spurious "switching approaches" note, which is the
/// exact noise this module exists to prevent.
pub fn same_approach(left: &str, right: &str) -> bool {
    let (left_words, right_words) = (distinctive_words(left), distinctive_words(right));
    if left_words.is_empty() || right_words.is_empty() {
        return left.trim().eq_ignore_ascii_case(right.trim());
    }
    let shared = left_words.intersection(&right_words).count();
    let smaller = left_words.len().min(right_words.len());
    shared * 2 >= smaller
}

/// Two step lists describing one plan, even when the headline sentence changed.
///
/// The bar here is higher than [`same_approach`]'s, and in the other direction:
/// two genuinely different approaches to one problem overlap in their obvious
/// steps — brute force and a hash map both "compare sums" — so half-agreement
/// means nothing. Two thirds of the shorter list is the floor.
fn shares_steps(committed: &[String], fresh: &[String]) -> bool {
    if committed.is_empty() || fresh.is_empty() {
        return false;
    }
    let shared = committed
        .iter()
        .filter(|step| fresh.iter().any(|other| same_approach(step, other)))
        .count();
    shared * 3 >= committed.len().min(fresh.len()) * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(approach: &str, steps: &[&str]) -> Claim {
        Claim {
            understood_approach: approach.into(),
            key_steps: steps.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    /// The rule the whole module is for. The board is unchanged; the model has
    /// simply read it differently on the second look. The student gets the
    /// coaching they were already getting.
    #[test]
    fn a_second_reading_of_the_same_board_cannot_move_the_commitment() {
        let mut session = ApproachSession::default();
        assert_eq!(
            session.observe_claim(7, &claim("two pointers from both ends", &["sort", "walk in"])),
            ApproachOutcome::Committed
        );

        let drifted = session.observe_claim(7, &claim("hash map of complements", &["hash each"]));
        assert_eq!(
            drifted,
            ApproachOutcome::HeldAgainstDrift {
                discarded: "hash map of complements".into()
            }
        );
        assert_eq!(
            session.committed.as_ref().unwrap().name,
            "two pointers from both ends"
        );
        assert!(session.transition_log.is_empty(), "drift is not a transition");
        assert!(drifted.note().is_none(), "and the student is told nothing");
    }

    /// The other side of that gate: the student redrew, and the new drawing
    /// really does argue for something else.
    #[test]
    fn a_changed_board_transitions_with_a_reason_and_what_survives() {
        let mut session = ApproachSession::default();
        session.observe_claim(7, &claim("brute force every pair", &["two loops", "compare sums"]));

        let moved = session.observe_claim(
            8,
            &claim("hash map of complements", &["hash each value", "compare sums"]),
        );
        let ApproachOutcome::Transitioned(transition) = &moved else {
            panic!("expected a transition, got {moved:?}");
        };
        assert_eq!(transition.from, "brute force every pair");
        assert_eq!(transition.to, "hash map of complements");
        assert!(!transition.reason.trim().is_empty(), "a silent switch is the bug");
        assert_eq!(transition.what_carries_over, vec!["compare sums"]);
        assert_eq!(session.transition_log.len(), 1);
        assert!(moved.note().unwrap().contains("Switching from"));
    }

    /// Rephrasing is not switching. This is what stops the note from firing on
    /// every turn of a session that never changed its mind.
    #[test]
    fn the_same_idea_phrased_differently_holds_and_keeps_the_longer_steps() {
        let mut session = ApproachSession::default();
        session.observe_claim(1, &claim("two pointers from both ends", &["sort first"]));

        let held = session.observe_claim(
            2,
            &claim("two pointers, one at each end", &["sort first", "move the larger inward"]),
        );
        assert_eq!(held, ApproachOutcome::Held);
        let committed = session.committed.as_ref().unwrap();
        assert_eq!(committed.name, "two pointers from both ends", "the first phrasing stands");
        assert_eq!(
            committed.key_steps.len(),
            2,
            "but a fuller reading of the same idea is worth keeping"
        );
        assert_eq!(committed.committed_at_fingerprint, 2);
    }

    /// A headline that changed while the steps did not is still the same plan.
    #[test]
    fn matching_steps_hold_the_commitment_even_when_the_sentence_changes() {
        let mut session = ApproachSession::default();
        session.observe_claim(
            1,
            &claim("scan once, remembering what you saw", &["walk left to right", "store each index"]),
        );
        assert_eq!(
            session.observe_claim(
                2,
                &claim("single pass with a lookup", &["walk left to right", "store each index"]),
            ),
            ApproachOutcome::Held
        );
    }

    /// The student's word is the one thing that overrides the drift rule —
    /// including on an unchanged board, which is exactly when they say it.
    #[test]
    fn an_explicit_switch_moves_the_commitment_on_an_unchanged_board() {
        let mut session = ApproachSession::default();
        session.set_catalog(vec![ApproachCandidate {
            id: "B".into(),
            name: "hash map of complements".into(),
            sketch_steps: vec!["hash each value".into()],
            ..Default::default()
        }]);
        session.observe_claim(7, &claim("two pointers from both ends", &["sort", "walk in"]));

        let moved = session.switch_on_request(7, "hash map of complements", "you asked to try it");
        let ApproachOutcome::Transitioned(transition) = moved else {
            panic!("an explicit request must be honoured");
        };
        assert_eq!(transition.reason, "you asked to try it");
        let committed = session.committed.as_ref().unwrap();
        assert_eq!(committed.source, CommitSource::ExplicitSwitch);
        assert_eq!(committed.id.as_deref(), Some("B"), "matched to the catalog entry");
        assert_eq!(committed.key_steps, vec!["hash each value"]);

        // Asking for the approach already committed is not a switch.
        assert_eq!(
            session.switch_on_request(7, "hash map of complements", "again"),
            ApproachOutcome::Held
        );
        assert_eq!(session.transition_log.len(), 1);
    }

    /// Alternatives are offered, never chosen — and only while the board has
    /// not settled the question.
    #[test]
    fn alternatives_are_offered_only_for_a_claim_that_does_not_decide_it() {
        let mut session = ApproachSession::default();
        session.set_catalog(vec![ApproachCandidate {
            id: "A".into(),
            name: "two pointers on a sorted array".into(),
            when_to_use: "when sorting is affordable".into(),
            ..Default::default()
        }]);

        let mut undecided = claim("something with pairs", &[]);
        undecided.compatible_alternatives = vec![
            "two pointers on a sorted array".into(),
            "two pointers, sorted".into(), // the same family, said twice
            "hash map of complements".into(),
            "sort then binary search".into(),
            "brute force".into(),
        ];
        let offered = session.candidates_for(&undecided);
        assert_eq!(offered.len(), 3, "at most three, and no duplicates: {offered:?}");
        assert_eq!(offered[0].id, "A", "catalog entries bring their own detail");
        assert_eq!(offered[0].when_to_use, "when sorting is affordable");
        assert_eq!(offered[1].name, "hash map of complements");
        assert!(
            session.committed.is_none(),
            "listing alternatives must not commit to one"
        );

        let mut decided = claim("two pointers on a sorted array", &["sort", "walk in"]);
        decided.claim_sufficient = true;
        decided.compatible_alternatives = vec!["hash map".into()];
        assert!(
            session.candidates_for(&decided).is_empty(),
            "a claim that decides the answer is not asking to be second-guessed"
        );
    }

    #[test]
    fn a_claim_that_names_nothing_leaves_the_commitment_alone() {
        let mut session = ApproachSession::default();
        session.observe_claim(1, &claim("two pointers from both ends", &["sort"]));
        assert_eq!(session.observe_claim(2, &claim("   ", &[])), ApproachOutcome::Held);
        assert_eq!(
            session.committed.as_ref().unwrap().name,
            "two pointers from both ends"
        );
    }

    #[test]
    fn a_task_switch_clears_everything() {
        let mut session = ApproachSession::default();
        session.set_catalog(vec![ApproachCandidate {
            id: "A".into(),
            ..Default::default()
        }]);
        session.observe_claim(1, &claim("two pointers", &["sort"]));
        session.observe_claim(2, &claim("hash map", &["hash it"]));
        assert!(session.has_catalog() && !session.transition_log.is_empty());

        session.clear();
        assert!(!session.has_catalog());
        assert!(session.committed.is_none());
        assert!(session.transition_log.is_empty());
    }
}
