use super::super::modes::review::{Rating, ReviewResponse, Verdict};
use super::claim::Claim;

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
