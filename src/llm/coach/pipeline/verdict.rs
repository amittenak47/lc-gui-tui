use std::fmt::Write as _;

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{write_cases, write_problem_header};

use super::super::board::BoardSnapshot;
use super::super::review::{Rating, ReviewResponse, Verdict};
use super::claim::{board_without_code, write_claim, Claim};

/// Stage 3a prompt — reached only when the claim did not decide the answer.
pub fn build_verdict_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: &Claim,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board_without_code(board).write_into(&mut out);
    write_claim(&mut out, claim);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"the claim above, carried through unchanged\",\n  \
           \"verdict\": \"on_track | subtly_wrong | wrong_track | unclear\",\n  \
           \"rating\": {{\"correctness\": 1-5, \"complexity\": 1-5, \"clarity\": 1-5}},\n  \
           \"strengths\": [\"what the claim already gets right\"],\n  \
           \"gaps\": [\"only what the claim leaves open — do not restate the claim itself\"],\n  \
           \"counterexample\": {{\"case_index\": <0-based index into the numbered cases above>, \
              \"why_your_approach_fails\": \"step through THAT case's own input, using its actual \
values, and show where the claim diverges from its expected output\"}},\n  \
           \"socratic_question\": \"the most specific next move you can name\",\n  \
           \"offer_bridge\": true\n\
         }}\n\
         ```\n\n\
         `counterexample` must be null if no listed case breaks the claim. Do not restate the input \
         or expected output as fields — they are looked up from the corpus for you."
    );
    out
}

/// Stage 3b — the on-track card, built by the daemon from the frozen claim.
///
/// No second call. The model already said the claim decides the answer; asking
/// it again with a `gaps` array in front of it is exactly how a correct board
/// used to come back holding invented flaws. Everything here is either copied
/// from the claim or a fixed value, and nothing is a fresh judgement.
pub fn on_track_review_from_claim(claim: &Claim) -> ReviewResponse {
    let mut strengths = Vec::new();
    if !claim.why_sufficient_or_not.is_empty() {
        strengths.push(claim.why_sufficient_or_not.clone());
    }
    strengths.extend(claim.key_steps.iter().cloned());
    if strengths.is_empty() {
        strengths.push(claim.understood_approach.clone());
    }

    let socratic_question = if claim.confirming_question.is_empty() {
        format!(
            "You have it: {}. Which input would you run first to convince yourself that holds?",
            claim.understood_approach.trim_end_matches('.')
        )
    } else {
        claim.confirming_question.clone()
    };

    ReviewResponse {
        understood_approach: claim.understood_approach.clone(),
        verdict: Verdict::OnTrack,
        // Synthesized, not scored by a model: the approach is correct, so
        // correctness is full marks, and how much detail the board carries
        // stands in for clarity.
        rating: Rating {
            correctness: 5,
            complexity: 4,
            clarity: if claim.key_steps.len() >= 2 { 4 } else { 3 },
        },
        strengths,
        gaps: Vec::new(),
        counterexample: None,
        socratic_question,
        offer_bridge: false,
        counterexample_rejected: None,
        layout_verdict: Some(Verdict::OnTrack),
        code_verdict: None,
    }
}

