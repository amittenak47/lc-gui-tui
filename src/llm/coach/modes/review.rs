use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::problem::IoCase;
use crate::llm::helpers::parse_reply;

// ---------------------------------------------------------------------------
// Mode A — submit for review
// ---------------------------------------------------------------------------


/// Verdicts the model may return. Anything unrecognized degrades to
/// [`Verdict::Unclear`] rather than failing the whole review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    OnTrack,
    SubtlyWrong,
    WrongTrack,
    #[default]
    #[serde(other)]
    Unclear,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Rating {
    #[serde(deserialize_with = "deserialize_score")]
    pub correctness: u8,
    #[serde(deserialize_with = "deserialize_score")]
    pub complexity: u8,
    #[serde(deserialize_with = "deserialize_score")]
    pub clarity: u8,
}

/// Local models often emit `2.0` or `"3"` instead of an integer.
fn deserialize_score<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let n = match value {
        serde_json::Value::Number(num) => num
            .as_u64()
            .or_else(|| num.as_f64().map(|f| f.round() as u64))
            .unwrap_or(0),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|f| f.round() as u64)
            .unwrap_or(0),
        _ => 0,
    };
    Ok(n.min(u64::from(u8::MAX)) as u8)
}

impl Rating {
    pub(super) fn clamp(&mut self) {
        for field in [
            &mut self.correctness,
            &mut self.complexity,
            &mut self.clarity,
        ] {
            *field = (*field).min(5);
        }
    }
}

/// A cited sample case that breaks the student's approach.
///
/// `case_index` is a 0-based index into `WorkspaceMeta::cases`. The daemon
/// validates it and overwrites `input`/`expected` with the corpus's actual
/// text, so a model that cites a real index but misquotes its contents still
/// cannot show the student a fabricated case.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Counterexample {
    pub case_index: usize,
    /// 1-based, matching `lc test --case N`. Filled in by the daemon.
    pub case_number: u32,
    pub input: String,
    pub expected: String,
    pub why_your_approach_fails: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReviewResponse {
    pub understood_approach: String,
    pub verdict: Verdict,
    pub rating: Rating,
    pub strengths: Vec<String>,
    pub gaps: Vec<String>,
    pub counterexample: Option<Counterexample>,
    pub socratic_question: String,
    pub offer_bridge: bool,
    /// Set by the daemon when the model cited a case index that does not exist
    /// and the citation was dropped. Never set by the model.
    pub counterexample_rejected: Option<String>,
    /// Present when layout and code were reviewed in separate LLM passes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_verdict: Option<Verdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_verdict: Option<Verdict>,
}

/// Parse a review reply and enforce that any cited case actually exists.
///
/// A fabricated index is dropped and reported in `counterexample_rejected`,
/// rather than being shown to the student as if it were real.
pub fn parse_review(raw: &str, cases: &[IoCase]) -> Result<ReviewResponse> {
    let mut review: ReviewResponse = parse_reply(raw, "review")?;
    review.rating.clamp();
    validate_counterexample(&mut review, cases);
    Ok(review)
}

/// Replace a cited case with the corpus's own text, or drop it if the index is
/// out of range. Public so the reveal/bridge path can reuse the same guarantee.
pub fn validate_counterexample(review: &mut ReviewResponse, cases: &[IoCase]) {
    let Some(cited) = review.counterexample.as_mut() else {
        return;
    };
    match cases.get(cited.case_index) {
        Some(case) => {
            cited.case_number = cited.case_index as u32 + 1;
            cited.input = case.input.clone();
            cited.expected = case.output.clone();
        }
        None => {
            let bogus = cited.case_index;
            review.counterexample = None;
            review.counterexample_rejected = Some(format!(
                "the coach cited case {bogus}, which does not exist \
                 (this problem has {} sample cases) — citation dropped",
                cases.len()
            ));
        }
    }
}

/// Render a review card as plain text for the TUI (no JSON, no GUI chrome).
pub fn format_review_card(review: &ReviewResponse) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "Verdict: {}\nApproach: {}",
        verdict_label(review.verdict),
        review.understood_approach.trim()
    );
    let _ = writeln!(
        out,
        "Rating: correctness {}/5 · complexity {}/5 · clarity {}/5",
        review.rating.correctness, review.rating.complexity, review.rating.clarity
    );
    if !review.strengths.is_empty() {
        let _ = writeln!(out, "\nStrengths:");
        for s in &review.strengths {
            let _ = writeln!(out, "  - {}", strip_review_tag_prefix(s));
        }
    }
    if !review.gaps.is_empty() {
        let _ = writeln!(out, "\nGaps:");
        for g in &review.gaps {
            let _ = writeln!(out, "  - {}", strip_review_tag_prefix(g));
        }
    }
    if let Some(ce) = &review.counterexample {
        let _ = writeln!(
            out,
            "\nCounterexample (case {}):\n  input: {}\n  expected: {}\n  why: {}",
            ce.case_number,
            ce.input.trim(),
            ce.expected.trim(),
            ce.why_your_approach_fails.trim()
        );
    }
    if let Some(rej) = &review.counterexample_rejected {
        let _ = writeln!(out, "\n(Counterexample dropped: {rej})");
    }
    if !review.socratic_question.trim().is_empty() {
        let _ = writeln!(out, "\nNext: {}", review.socratic_question.trim());
    }
    out.trim_end().to_string()
}

pub(super) fn verdict_label(v: Verdict) -> &'static str {
    match v {
        Verdict::OnTrack => "on track",
        Verdict::SubtlyWrong => "subtly wrong",
        Verdict::WrongTrack => "wrong track",
        Verdict::Unclear => "unclear",
    }
}

pub(super) fn strip_review_tag_prefix(note: &str) -> String {
    note.trim()
        .strip_prefix("[layout] ")
        .or_else(|| note.trim().strip_prefix("[code] "))
        .map(str::to_string)
        .unwrap_or_else(|| note.trim().to_string())
}

/// Merge separate layout and code reviews into one card for the client.
///
/// The board wins: tablet typing is hard, so a correct layout must not be
/// downgraded by a sparse code dock, and code-only nitpicks stay secondary.
pub fn merge_layout_and_code_reviews(
    layout: ReviewResponse,
    code: ReviewResponse,
) -> ReviewResponse {
    let mut merged = ReviewResponse::default();
    merged.understood_approach = if !layout.understood_approach.trim().is_empty() {
        if code.understood_approach.trim().is_empty()
            || code.understood_approach.trim() == layout.understood_approach.trim()
        {
            layout.understood_approach.clone()
        } else {
            format!(
                "Board: {} | Code: {}",
                layout.understood_approach.trim(),
                code.understood_approach.trim()
            )
        }
    } else {
        code.understood_approach.clone()
    };
    merged.verdict = prefer_layout_verdict(layout.verdict, code.verdict);
    // Weight the board more heavily when scoring.
    merged.rating = Rating {
        correctness: ((layout.rating.correctness * 2 + code.rating.correctness) as f32 / 3.0)
            .round() as u8,
        complexity: ((layout.rating.complexity * 2 + code.rating.complexity) as f32 / 3.0).round()
            as u8,
        clarity: ((layout.rating.clarity * 2 + code.rating.clarity) as f32 / 3.0).round() as u8,
    };
    merged.rating.clamp();
    merged.strengths = [
        prefix_notes("layout", &layout.strengths),
        prefix_notes("code", &code.strengths),
    ]
    .concat();
    // When the board is on track, drop code gaps — they are usually "you didn't
    // type the full solution" noise on a tablet.
    merged.gaps = if layout.verdict == Verdict::OnTrack {
        prefix_notes("layout", &layout.gaps)
    } else {
        [prefix_notes("layout", &layout.gaps), prefix_notes("code", &code.gaps)].concat()
    };
    // Prefer a board counterexample; only use code's if the board had none and
    // the board was not already judged on track.
    merged.counterexample = if layout.verdict == Verdict::OnTrack {
        None
    } else {
        layout.counterexample.or(code.counterexample)
    };
    merged.counterexample_rejected = layout
        .counterexample_rejected
        .or(code.counterexample_rejected);
    merged.socratic_question = if !layout.socratic_question.trim().is_empty() {
        if layout.verdict == Verdict::OnTrack || code.socratic_question.trim().is_empty() {
            layout.socratic_question.clone()
        } else {
            format!(
                "Board: {}\nCode: {}",
                layout.socratic_question.trim(),
                code.socratic_question.trim()
            )
        }
    } else {
        code.socratic_question.clone()
    };
    merged.offer_bridge = if layout.verdict == Verdict::OnTrack {
        false
    } else {
        layout.offer_bridge || code.offer_bridge
    };
    merged.layout_verdict = Some(layout.verdict);
    merged.code_verdict = Some(code.verdict);
    merged
}

pub(super) fn prefix_notes(tag: &str, notes: &[String]) -> Vec<String> {
    notes
        .iter()
        .filter(|n| !n.trim().is_empty())
        .map(|n| format!("[{tag}] {n}"))
        .collect()
}

/// Board-first merge: a correct layout is not dragged down by thin code.
pub(super) fn prefer_layout_verdict(layout: Verdict, code: Verdict) -> Verdict {
    use Verdict::*;
    match layout {
        OnTrack => OnTrack,
        Unclear => code,
        // Keep the board's criticism; incomplete code shouldn't soften a wrong board.
        SubtlyWrong | WrongTrack => layout,
    }
}
