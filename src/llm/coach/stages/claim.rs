use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm::helpers::{clip, parse_reply};

use super::super::board::BoardSnapshot;
use super::{tidy_list, MAX_CLAIM_FIELD};

/// Stage 2 — the student's approach as the coach understands it, plus the one
/// decision the whole pipeline turns on: does this claim already decide the
/// answer?
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Claim {
    /// One sentence naming their idea. This is the value that flows into
    /// whichever review the daemon emits, so the card's approach line always
    /// comes from the stage that was not asked to find fault.
    pub understood_approach: String,
    /// The steps the board actually justifies, in order. Read by the Lazy fill
    /// as the specification to implement.
    pub key_steps: Vec<String>,
    /// Whether following the claim literally answers the problem.
    pub claim_sufficient: bool,
    pub why_sufficient_or_not: String,
    /// What the board has not decided yet. Forced empty when the claim is
    /// sufficient — a claim that decides the answer leaves nothing open, and a
    /// model that says both is contradicting itself.
    pub unresolved: Vec<String>,
    /// A question that would confirm or stress-test the claim. Used verbatim as
    /// the Socratic question on the on-track path, so that path needs no second
    /// call to ask something specific.
    pub confirming_question: String,
    /// The planner catalog entry this claim matches, when the model recognized
    /// one. Absent is the normal case and carries no judgement: a student may
    /// invent an approach nobody catalogued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_approach_id: Option<String>,
    /// Other approaches the board could equally be arguing for. Offered to the
    /// student as choices when the claim does not decide the answer — never
    /// used to pick one for them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub compatible_alternatives: Vec<String>,
}

impl Claim {
    /// The gate. `claim_sufficient` alone is not enough to trust: a model that
    /// answers `{"claim_sufficient": true, "understood_approach": "yes"}` has
    /// not read a board, and must not short-circuit a student into "on track".
    /// Two words and eight characters is the floor — enough to let a genuinely
    /// terse claim ("two pointers") through, enough to stop a bare "ok".
    pub fn decides_the_answer(&self) -> bool {
        let named = self.understood_approach.trim();
        self.claim_sufficient
            && named.chars().count() >= 8
            && named.split_whitespace().count() >= 2
    }

    fn tidy(&mut self) {
        self.understood_approach = clip(self.understood_approach.trim(), MAX_CLAIM_FIELD);
        self.why_sufficient_or_not = clip(self.why_sufficient_or_not.trim(), MAX_CLAIM_FIELD);
        self.confirming_question = clip(self.confirming_question.trim(), MAX_CLAIM_FIELD);
        tidy_list(&mut self.key_steps);
        tidy_list(&mut self.unresolved);
        tidy_list(&mut self.compatible_alternatives);
        self.matched_approach_id = self
            .matched_approach_id
            .take()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty());
        if self.claim_sufficient {
            self.unresolved.clear();
        }
    }
}

pub fn parse_claim(raw: &str) -> Result<Claim> {
    let mut claim: Claim = parse_reply(raw, "claim")?;
    claim.tidy();
    if claim.understood_approach.is_empty() {
        anyhow::bail!("the coach did not name an approach");
    }
    Ok(claim)
}

/// The board as the staged path reads it: ink, layout, and canvas notes, with
/// the code dock stripped. Every stage before the code pass gets this, so a
/// stubby `solution.py` cannot seed the claim it is later judged against.
pub fn board_without_code(board: &BoardSnapshot) -> BoardSnapshot {
    let mut stripped = board.clone();
    stripped.pseudocode = None;
    stripped.pseudocode_delta = None;
    stripped.code_mode = None;
    stripped
}

/// The frozen claim, as every later stage sees it.
pub fn write_claim(out: &mut String, claim: &Claim) {
    let _ = writeln!(
        out,
        "\n## The claim the board makes (frozen — read it as given, do not replace it)"
    );
    let _ = writeln!(out, "\n- approach: {}", claim.understood_approach);
    if !claim.key_steps.is_empty() {
        let _ = writeln!(out, "- steps the board justifies:");
        for (i, step) in claim.key_steps.iter().enumerate() {
            let _ = writeln!(out, "  {}. {step}", i + 1);
        }
    }
    let _ = writeln!(
        out,
        "- does this already decide the answer? {}",
        if claim.claim_sufficient { "yes" } else { "no" }
    );
    if !claim.why_sufficient_or_not.is_empty() {
        let _ = writeln!(out, "- because: {}", claim.why_sufficient_or_not);
    }
    if !claim.unresolved.is_empty() {
        let _ = writeln!(out, "- not decided by the board yet:");
        for item in &claim.unresolved {
            let _ = writeln!(out, "  - {item}");
        }
    }
}

/// The session's committed approach, for the stages that come after the claim.
///
/// The instruction matters more than the text: several approaches solve most of
/// these problems, and a model handed a list of them will drift toward whichever
/// it likes best. It is being told to coach *this* one — not to pick.
pub fn write_committed_approach(out: &mut String, committed: &super::super::CommittedApproach) {
    let _ = writeln!(
        out,
        "\n## The approach this session is coaching (committed — work inside it)"
    );
    let _ = writeln!(out, "\n- approach: {}", committed.name);
    if !committed.key_steps.is_empty() {
        let _ = writeln!(out, "- its steps, as the student has them:");
        for (i, step) in committed.key_steps.iter().enumerate() {
            let _ = writeln!(out, "  {}. {step}", i + 1);
        }
    }
    let _ = writeln!(
        out,
        "\nOther approaches may also solve this problem. Do not propose one, and do not \
         re-describe the student's work as a different approach. If this approach cannot be \
         made to work, say exactly which step fails and why — the decision to change approach \
         is the student's, not yours."
    );
}
