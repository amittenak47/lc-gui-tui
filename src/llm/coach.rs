//! Prompt builders and response types for the whiteboard coach.
//!
//! Review (Mode A) is staged rather than one-shot: [`build_perceive_prompt`]
//! describes the board, [`build_claim_prompt`] names what it claims and whether
//! that claim decides the answer, and [`build_verdict_prompt`] runs only when it
//! does not. The gate is [`Claim::decides_the_answer`] inside [`staged_board_review`]
//! — a [`Claim`] is data Rust inspects, not a step a model talks itself past.
//! Callers (HTTP `/coach/review`, TUI coach chat) build a [`BoardSnapshot`] and
//! run [`review_submission`]; GUI-only fields (PNG, scene layout, lazy flags)
//! are simply left unset on text-only paths.
//!
//! Mirrors the section-heading style of [`crate::llm::prompt`] and reuses its
//! [`clip`] helper. Every prompt here is assembled from [`WorkspaceMeta`], the
//! problem statement, and what the user wrote on the board — the same redacted
//! sources `lc ask` uses. The one exception is [`build_bridge_prompt`], which
//! takes reference text the caller obtained through [`crate::reveal`] after an
//! explicit user action; it is never called from the review or ambient paths.

use std::fmt::Write as _;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::prompt::clip;
use crate::llm::{ChatMessage, ChatRequest, LlmProvider};
use crate::problem::IoCase;
use crate::runner::CaseResult;

const MAX_DESCRIPTION: usize = 6000;
const MAX_BOARD: usize = 8000;
const MAX_STRUCTURE: usize = 4000;
const MAX_REFERENCE: usize = 8000;
const MAX_CASE: usize = 400;
/// Sample cases shown to the coach. Enough to pick a real counterexample from,
/// small enough to leave room for the board on a 8k-context local model.
const MAX_CASES_SHOWN: usize = 12;

// ---------------------------------------------------------------------------
// What the client captured off the canvas
// ---------------------------------------------------------------------------

/// One snapshot of the whiteboard, as sent by the client.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct BoardSnapshot {
    /// Handwriting run through ML Kit, plus any typed text elements.
    #[serde(default)]
    pub recognized_text: String,
    /// Stripped Excalidraw scene: `{id, type, x, y, w, h, text?}` per element.
    /// Each `id` is a truncated stable handle the model may cite.
    #[serde(default)]
    pub scene_structure: Option<serde_json::Value>,
    /// Base64 PNG. Only sent when the selected model is vision-capable.
    #[serde(default)]
    pub png: Option<String>,
    /// Typed pseudocode from the editor panel. Kept separate from
    /// `recognized_text` because it is exact — no OCR guessing — and the coach
    /// should read it that way.
    #[serde(default)]
    pub pseudocode: Option<String>,
    /// Truncated element ids added since the last successful review this session.
    #[serde(default)]
    pub new_since_last: Vec<String>,
    /// How many successful reviews this session (0 = first look).
    #[serde(default)]
    pub turn_index: u32,
    /// Client scene fingerprint — used to skip redundant work server-side.
    #[serde(default)]
    pub scene_hash: Option<u64>,
    /// Incremental element changes since the server baseline. When present,
    /// `scene_structure` may be omitted on the wire.
    #[serde(default)]
    pub board_ops: Option<Vec<serde_json::Value>>,
    /// Raster ink op count — ambient/review gating on the client.
    #[serde(default)]
    pub ink_ops_len: Option<usize>,
    /// `full` | `delta` | `unchanged` — how to read pseudocode fields.
    #[serde(default)]
    pub code_mode: Option<String>,
    /// SHA-256 hex of the starter skeleton the student is editing.
    #[serde(default)]
    pub skeleton_hash: Option<String>,
    /// Current solution text when `code_mode` is `delta`, or omitted when
    /// `code_mode` is `unchanged`.
    #[serde(default)]
    pub pseudocode_delta: Option<String>,
    /// Messages from the app itself, not from the student — currently the last
    /// test run. Kept as its own channel because it is *fact*: the coach may
    /// state these results, while everything else on the board is something a
    /// student claimed and the coach is meant to question.
    #[serde(default)]
    pub app_messages: Vec<String>,
}

impl BoardSnapshot {
    pub fn is_empty(&self) -> bool {
        self.recognized_text.trim().is_empty()
            && self.pseudocode.as_deref().is_none_or(|p| p.trim().is_empty())
            && self
                .scene_structure
                .as_ref()
                .is_none_or(|s| s.as_array().is_some_and(|a| a.is_empty()))
    }

    /// Whether anything other than transcribed text says the student has been
    /// working: a non-empty scene layout, or an attached board image.
    pub fn has_visual_evidence(&self) -> bool {
        if self.png.is_some() {
            return true;
        }
        match self.scene_structure.as_ref() {
            Some(serde_json::Value::Array(items)) => !items.is_empty(),
            Some(serde_json::Value::Null) | None => false,
            Some(_) => true,
        }
    }

    /// Images for [`crate::llm::ChatMessage::with_images`]; empty unless a PNG
    /// was captured.
    pub fn images(&self) -> Vec<String> {
        self.png.iter().cloned().collect()
    }

    /// Everything the student wrote, ink and typing together, clipped for a
    /// prompt. Callers that need only one half should read the fields directly.
    pub fn approach_text(&self) -> String {
        let mut parts = Vec::new();
        let ink = self.recognized_text.trim();
        if !ink.is_empty() {
            parts.push(clip(ink, MAX_BOARD));
        }
        if let Some(typed) = self.pseudocode.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            parts.push(clip(typed, MAX_BOARD));
        }
        parts.join("\n\n")
    }

    fn write_into(&self, out: &mut String) {
        let _ = writeln!(out, "\n## What is on the whiteboard right now");
        if self.recognized_text.trim().is_empty() {
            // "No recognized handwriting" is not "no handwriting": the browser
            // build ships no ink OCR at all, so ink shows up only in the layout
            // and the image. Saying so here is what stops the coach opening
            // with "your board is blank" at a student who just wrote half a
            // page by hand.
            if self.has_visual_evidence() {
                let _ = writeln!(
                    out,
                    "\n(No handwriting text: this device does not transcribe ink. The student may \
                     well have written or drawn by hand. Read the canvas layout below — and the \
                     attached image, if there is one — and interpret the boxes, arrows and \
                     positions as their work. Do NOT tell them the board is blank.)"
                );
            } else {
                let _ = writeln!(out, "\n(no recognized handwriting yet)");
            }
        } else {
            let _ = writeln!(
                out,
                "\nHandwriting, as recognized (OCR is imperfect — read through typos):\n\n\
                 ```\n{}\n```",
                clip(self.recognized_text.trim(), MAX_BOARD)
            );
        }
        if let Some(structure) = &self.scene_structure {
            let section = render_structure_by_region(structure);
            if !section.is_empty() {
                let _ = writeln!(
                    out,
                    "\nCanvas layout by template box (each dashed region is labeled; objects have \
                     a short stable `id` you may cite):\n\n{}",
                    clip(&section, MAX_STRUCTURE)
                );
            }
        }
        if self.turn_index > 0 && !self.new_since_last.is_empty() {
            let _ = writeln!(
                out,
                "\n## Since your last look, the student added\n\n\
                 Element ids (truncated): {}\n\
                 Focus on what is new; do not repeat a point you already made.",
                self.new_since_last.join(", ")
            );
        }
        if let Some(pseudocode) = self.pseudocode.as_deref().map(str::trim).filter(|p| !p.is_empty())
        {
            // Typed, so it is exact — say so, or the model second-guesses it the
            // way it is told to second-guess the OCR above.
            let _ = writeln!(
                out,
                "\nPseudocode they typed (exact, not recognized — read it literally):\n\n\
                 ```\n{}\n```",
                clip(pseudocode, MAX_BOARD)
            );
        }
        if self.png.is_some() {
            let _ = writeln!(out, "\nA PNG of the board is attached to this message.");
        }
        if !self.app_messages.is_empty() {
            let _ = writeln!(
                out,
                "\n## From the app (not the student)\n\n\
                 These are real results produced by running their code. Treat them as fact — you \
                 may cite them directly, and you should not ask the student to re-run anything \
                 you can already see here."
            );
            for message in &self.app_messages {
                let _ = writeln!(out, "\n```\n{}\n```", clip(message.trim(), MAX_BOARD));
            }
        }
    }
}

/// Render scene_structure grouped by template `region` so the model reads each
/// dashed box (Approach, Complexity, …) as its own layout, not one flat list.
fn render_structure_by_region(structure: &serde_json::Value) -> String {
    let Some(arr) = structure.as_array() else {
        let rendered = serde_json::to_string(structure).unwrap_or_default();
        if rendered.len() <= 2 {
            return String::new();
        }
        return format!("```json\n{rendered}\n```");
    };
    if arr.is_empty() {
        return String::new();
    }

    let order = [
        "constraints",
        "code",
        "approach",
        "complexity",
        "walkthrough",
        "agent",
    ];
    let labels: [(&str, &str); 6] = [
        ("constraints", "Problem"),
        ("code", "Code"),
        ("approach", "Approach"),
        ("complexity", "Complexity"),
        ("walkthrough", "Walkthrough"),
        ("agent", "Coach lane"),
    ];

    let mut buckets: std::collections::BTreeMap<String, Vec<&serde_json::Value>> =
        std::collections::BTreeMap::new();
    let mut other: Vec<&serde_json::Value> = Vec::new();
    for el in arr {
        match el.get("region").and_then(|r| r.as_str()) {
            Some(region) => buckets.entry(region.to_string()).or_default().push(el),
            None => other.push(el),
        }
    }

    let mut out = String::new();
    for key in order {
        let Some(items) = buckets.remove(key) else {
            continue;
        };
        let label = labels
            .iter()
            .find(|(id, _)| *id == key)
            .map(|(_, l)| *l)
            .unwrap_or(key);
        let _ = writeln!(out, "### {label} (`{key}`)\n");
        let _ = writeln!(
            out,
            "```json\n{}\n```\n",
            serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
        );
    }
    for (key, items) in buckets {
        let _ = writeln!(out, "### `{key}`\n");
        let _ = writeln!(
            out,
            "```json\n{}\n```\n",
            serde_json::to_string(&items).unwrap_or_else(|_| "[]".into())
        );
    }
    if !other.is_empty() {
        let _ = writeln!(out, "### Outside a template box\n");
        let _ = writeln!(
            out,
            "```json\n{}\n```\n",
            serde_json::to_string(&other).unwrap_or_else(|_| "[]".into())
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Mode A — submit for review
// ---------------------------------------------------------------------------

pub const REVIEW_SYSTEM_PROMPT: &str = "You are a whiteboard coach for competitive programming. \
The student sketches by hand (and may type code later on a tablet). Your job is to work out what \
they intend and judge whether that ALGORITHM is correct — fairly, not adversarially.\n\
\n\
Rules:\n\
- Infer the approach charitably: handwriting recognition is noisy and notation is abbreviated.\n\
- Judge the ALGORITHM / insight, not penmanship, missing syntax, or incomplete code stubs.\n\
- Do NOT hunt for criticism. If their approach solves the problem, say so: verdict \"on_track\", \
list real strengths, and leave \"gaps\" empty or with only optional polish — never invent flaws \
to fill the field.\n\
- An elegant insight that skips an unnecessary loop (e.g. \"trailing zeros break double-reversal\") \
IS a complete approach. Do not demand they \"implement the actual reversal\" when the insight \
already decides the answer.\n\
- Only mark subtly_wrong / wrong_track when you can show a real failure. Cite a counterexample by \
index into the numbered sample cases. Never invent a case, input, or index — if none of the given \
cases breaks their approach, set \"counterexample\" to null.\n\
- Your explanation of a counterexample must trace THE CITED CASE's actual values only.\n\
- On a follow-up turn (when \"Since your last look\" is present), respond to what is new; do not \
repeat a point you already made.\n\
- Some devices cannot transcribe ink. Missing handwriting text is NOT an empty board: read the \
canvas layout — and the attached image when there is one — before judging. Never assert the board \
is blank when there are objects on it.\n\
- Prefer the whiteboard layout over the code dock. Tablet typing is hard; a sparse or stubby \
solution.py must not override a clear correct board. Incomplete code is not evidence the \
approach is wrong.\n\
- If the board is sparse or the session is early, open the interview: put one or two concrete, \
problem-specific hints in \"gaps\", use verdict \"unclear\", and do not tell them to \"start coding\".\n\
- Keep fields distinct: \"understood_approach\" is ONE short sentence naming their idea. \"gaps\" \
lists only concrete missing pieces — do not restate understood_approach. \"socratic_question\" is \
the most specific next move.\n\
- Always score \"rating\" with integers 1–5. Use 4–5 when the approach is solid, even if code is \
thin. Never return all zeros if they wrote, asked, or sketched anything.\n\
- Never write the corrected algorithm or working code in the review JSON. End with one Socratic \
question (or a confirming question if they are on track).\n\
- Reply with a single JSON object and nothing else — no prose, no markdown fence.";

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
    fn clamp(&mut self) {
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

pub fn build_review_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);

    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"one short sentence naming their intended idea\",\n  \
           \"verdict\": \"on_track | subtly_wrong | wrong_track | unclear\",\n  \
           \"rating\": {{\"correctness\": 1-5, \"complexity\": 1-5, \"clarity\": 1-5}},\n  \
           \"strengths\": [\"...\"],\n  \
           \"gaps\": [\"concrete missing pieces only — do not repeat understood_approach\"],\n  \
           \"counterexample\": {{\"case_index\": <0-based index into the numbered cases above>, \
              \"why_your_approach_fails\": \"step through THAT case's own input, using its actual \
values, and show where their approach diverges from its expected output\"}},\n  \
           \"socratic_question\": \"a specific, actionable next step or probe — more detailed than \
understood_approach\",\n  \
           \"offer_bridge\": true\n\
         }}\n\
         ```\n\n\
         `counterexample` must be null if no listed case breaks their approach. Do not restate the \
         input or expected output as fields — they are looked up from the corpus for you — but DO \
         work through that same input inside `why_your_approach_fails`."
    );
    out
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

// ---------------------------------------------------------------------------
// Mode A, staged — perceive, then claim, then judge only if needed
// ---------------------------------------------------------------------------
//
// Why this exists: one call that perceives, names, judges, and cites all at
// once gives a small VLM every reason to invent a flaw — the schema has a
// `gaps` array in it, so it fills the array. Splitting the work means the stage
// that decides "is this enough?" is never the stage that was asked to find
// something wrong, and the daemon — not the model — owns the gate between them.
//
// Stage 1 describes the board. Stage 2 names the claim and says whether it
// decides the answer. Stage 3 runs *only* when stage 2 said no.

pub const PERCEIVE_SYSTEM_PROMPT: &str = "You are looking at a photo of a student's whiteboard. \
You describe what is on it. You do not judge it.\n\
\n\
Rules:\n\
- List what you can actually see: boxes, arrows, tables, indices, labels, written invariants, \
small worked examples.\n\
- Transcribe short written text as text. Where a region is unreadable, say that instead of \
guessing what it probably said.\n\
- Do NOT say whether anything is right, wrong, missing, or incomplete. No verdict, no gaps, no \
advice — a later stage does that.\n\
- Do NOT name an algorithm that is not written on the board.\n\
- Reply with a single JSON object and nothing else — no prose, no markdown fence.";

pub const CLAIM_SYSTEM_PROMPT: &str = "You restate the approach a student's whiteboard claims, and \
say whether that claim already decides the answer.\n\
\n\
Rules:\n\
- Read the board charitably. Handwriting recognition is noisy, notation is abbreviated, and a \
sketch is not a submission.\n\
- \"claim_sufficient\" is true when following the claim literally gives the right answer for every \
input the problem allows. An insight that removes work counts: if the reasoning itself settles the \
answer, the student does not owe you the loop it replaced.\n\
- \"claim_sufficient\" is false only when you can name what the claim leaves undecided — an input \
it says nothing about, or a step that does not follow from the one before it. Name it in \
\"why_sufficient_or_not\".\n\
- Absent code, absent complexity analysis, and untidy notation are NOT reasons to answer false. \
Judge the idea.\n\
- \"unresolved\" lists only parts of the problem the board has not decided yet. It must be empty \
when \"claim_sufficient\" is true.\n\
- Do not grade, coach, or hunt for a counterexample here. The claim and whether it is enough — \
that is all.\n\
- Reply with a single JSON object and nothing else — no prose, no markdown fence.";

pub const VERDICT_SYSTEM_PROMPT: &str = "An earlier stage read the student's whiteboard, wrote down \
the claim it makes, and recorded why that claim does not yet decide the answer. Turn that into one \
review.\n\
\n\
Rules:\n\
- The claim is fixed. Do not re-read the board into a different approach, and do not rename their \
idea — carry \"understood_approach\" through as you were given it.\n\
- Every gap must be something the claim genuinely leaves open. Never list a step the claim already \
contains, and never pad the list to fill it — a short \"gaps\" is a good answer.\n\
- When the claim needs more detail rather than a different idea, the verdict is \"unclear\" and the \
gaps are the questions you would ask about it.\n\
- Use \"subtly_wrong\" or \"wrong_track\" only when you can show a real failure, cited by index \
into the numbered sample cases. Never invent a case, an input, or an index — if no listed case \
breaks the claim, \"counterexample\" must be null.\n\
- A counterexample explanation traces THE CITED CASE's own values and nothing else.\n\
- If you decide the claim does settle the answer after all, say \"on_track\" with empty gaps rather \
than arguing yourself into a flaw.\n\
- Never write the corrected algorithm or working code. End with one Socratic question.\n\
- Reply with a single JSON object and nothing else — no prose, no markdown fence.";

pub const CLAIM_CODE_SYSTEM_PROMPT: &str = "You check one thing: whether the Python in front of you \
implements the claim the student's whiteboard already made. The board was judged separately and \
that judgement stands.\n\
\n\
Rules:\n\
- The claim is the specification. Judge the code against it — not against a textbook solution, and \
not against the approach you would have picked.\n\
- Tablet code is typed slowly and is usually a stub. Absent scaffolding, unfinished helpers, and \
edge cases the claim never promised are not gaps.\n\
- Say \"on_track\" when the code follows the claim as far as it goes.\n\
- Mark it wrong only when the code contradicts the claim or demonstrably fails one of the numbered \
cases — cite that case by index, or set \"counterexample\" to null.\n\
- Do not restate the algorithm and do not write the fix.\n\
- Reply with a single JSON object and nothing else — no prose, no markdown fence.";

/// How many items any staged list keeps, and how long each may be. Local models
/// will happily return thirty observations; the next prompt has to fit beside a
/// board and a problem statement in 8k.
const MAX_STAGE_ITEMS: usize = 8;
const MAX_STAGE_ITEM: usize = 240;
const MAX_CLAIM_FIELD: usize = 600;

/// Stage 1 — what is on the board, with no opinion attached.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Perception {
    /// Structures seen: boxes, arrows, tables, worked examples.
    pub observations: Vec<String>,
    /// Text legible enough to quote back.
    pub transcribed_notes: Vec<String>,
    /// Regions the model could not read — said out loud rather than guessed at.
    pub illegible: Vec<String>,
}

impl Perception {
    pub fn is_blank(&self) -> bool {
        self.observations.is_empty() && self.transcribed_notes.is_empty()
    }

    fn tidy(&mut self) {
        for list in [
            &mut self.observations,
            &mut self.transcribed_notes,
            &mut self.illegible,
        ] {
            tidy_list(list);
        }
    }
}

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
        if self.claim_sufficient {
            self.unresolved.clear();
        }
    }
}

fn tidy_list(list: &mut Vec<String>) {
    list.retain(|item| !item.trim().is_empty());
    for item in list.iter_mut() {
        *item = clip(item.trim(), MAX_STAGE_ITEM);
    }
    list.truncate(MAX_STAGE_ITEMS);
}

/// Stage 1 prompt. Deliberately narrow: no statement, no sample cases, no code
/// dock. Nothing to reason from means nothing to have an opinion about, and it
/// leaves the context budget for the board itself.
pub fn build_perceive_prompt(meta: &WorkspaceMeta, board: &BoardSnapshot) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Board for problem: {}", meta.task_id);
    board_without_code(board).write_into(&mut out);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"observations\": [\"one short clause per thing you can see on the board\"], \
         \"transcribed_notes\": [\"pieces of text you can read\"], \
         \"illegible\": [\"regions you cannot read — leave empty if none\"]}}\n\
         ```"
    );
    out
}

pub fn parse_perception(raw: &str) -> Result<Perception> {
    let mut perception: Perception = parse_reply(raw, "perception")?;
    perception.tidy();
    if perception.is_blank() {
        anyhow::bail!("the coach described nothing on the board");
    }
    Ok(perception)
}

/// Stage 2 prompt. Takes the stage-1 description when there was one; on a
/// text-only build the caller passes `None` and this same call reads the layout
/// and the recognized ink directly.
pub fn build_claim_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    perception: Option<&Perception>,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board_without_code(board).write_into(&mut out);
    write_perception(&mut out, perception);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"one short sentence naming their idea\",\n  \
           \"key_steps\": [\"the steps the board justifies, in order\"],\n  \
           \"claim_sufficient\": true or false,\n  \
           \"why_sufficient_or_not\": \"one or two sentences — if false, name exactly what the \
claim leaves undecided\",\n  \
           \"unresolved\": [\"parts of the problem the board has not decided — empty when \
claim_sufficient is true\"],\n  \
           \"confirming_question\": \"one question that would confirm or stress-test this claim\"\n\
         }}\n\
         ```"
    );
    out
}

pub fn parse_claim(raw: &str) -> Result<Claim> {
    let mut claim: Claim = parse_reply(raw, "claim")?;
    claim.tidy();
    if claim.understood_approach.is_empty() {
        anyhow::bail!("the coach did not name an approach");
    }
    Ok(claim)
}

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

/// The code pass, conditioned on the frozen claim. Asks "does this code match
/// the claim?" — never "what approach does this stub suggest?", which is how a
/// half-typed file used to talk the coach out of a correct board.
pub fn build_claim_code_review_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: &Claim,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    write_claim(&mut out, claim);
    if !board.app_messages.is_empty() {
        let _ = writeln!(
            out,
            "\n## From the app (not the student)\n\n\
             Real results from running their code — treat them as fact."
        );
        for message in &board.app_messages {
            let _ = writeln!(out, "\n```\n{}\n```", clip(message.trim(), MAX_BOARD));
        }
    }
    let code = board.pseudocode.as_deref().unwrap_or("").trim();
    let _ = writeln!(
        out,
        "\n## The code dock (solution.py)\n\n```python\n{}\n```",
        clip(if code.is_empty() { "(empty)" } else { code }, MAX_BOARD)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Does this code implement the claim above? Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"understood_approach\": \"one short sentence: what the code does\",\n  \
           \"verdict\": \"on_track | subtly_wrong | wrong_track | unclear\",\n  \
           \"rating\": {{\"correctness\": 1-5, \"complexity\": 1-5, \"clarity\": 1-5}},\n  \
           \"strengths\": [\"where the code follows the claim\"],\n  \
           \"gaps\": [\"only where the code contradicts the claim — empty if it just stops \
early\"],\n  \
           \"counterexample\": {{\"case_index\": <0-based index, or null>, \
              \"why_your_approach_fails\": \"...\"}},\n  \
           \"socratic_question\": \"a code-focused next step\",\n  \
           \"offer_bridge\": true\n\
         }}\n\
         ```"
    );
    out
}

/// Result of [`review_submission`]: the card to show, plus the frozen claim
/// when the staged path ran (Lazy / follow-ups can reuse it).
#[derive(Debug, Clone)]
pub struct ReviewOutcome {
    pub review: ReviewResponse,
    pub claim: Option<Claim>,
}

/// Terminal coach: question + `solution.py` only — no whiteboard layout pass,
/// no `[layout]` / `[code]` merge prefixes.
pub fn review_submission_text_only(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    question: &str,
    solution: &str,
    app_messages: &[String],
    turn_index: u32,
) -> Result<ReviewOutcome> {
    let board = BoardSnapshot {
        recognized_text: if question.trim().is_empty() {
            String::new()
        } else {
            format!("Student question (terminal):\n{}", question.trim())
        },
        pseudocode: Some(solution.to_string()),
        app_messages: app_messages.to_vec(),
        turn_index,
        ..Default::default()
    };

    let has_approach = !question.trim().is_empty() || solution.trim().len() > 8;

    let (mut review, claim) = if has_approach {
        if let Ok((claim, review)) = staged_board_review(provider, meta, description, &board) {
            (review, Some(claim))
        } else {
            let prompt = build_review_prompt(meta, description, &board);
            let reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                    ChatMessage::user(prompt),
                ])
                .json(),
            )?;
            (parse_review(&reply.content, &meta.cases)?, None)
        }
    } else {
        let prompt = build_review_prompt(meta, description, &board);
        let reply = provider.chat_ex(
            &ChatRequest::new(vec![
                ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                ChatMessage::user(prompt),
            ])
            .json(),
        )?;
        (parse_review(&reply.content, &meta.cases)?, None)
    };

    retrace_counterexample(provider, meta, &board, &mut review);
    Ok(ReviewOutcome { review, claim })
}

/// Run Mode A against a board snapshot.
///
/// - With layout/ink/question text: perceive (if PNG) → claim → verdict only
///   when the claim is insufficient; optional code pass when `include_code`.
/// - Otherwise: single-call [`REVIEW_SYSTEM_PROMPT`] fallback.
///
/// GUI callers attach PNG / scene structure on `board`; TUI leaves those unset
/// and puts the typed question in `recognized_text` plus `solution.py` in
/// `pseudocode`.
pub fn review_submission(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    include_code: bool,
) -> Result<ReviewOutcome> {
    let has_layout =
        board.has_visual_evidence() || !board.recognized_text.trim().is_empty();
    let has_code = include_code
        && board
            .pseudocode
            .as_deref()
            .is_some_and(|p| p.trim().len() > 8);

    let staged = if has_layout {
        staged_board_review(provider, meta, description, board).ok()
    } else {
        None
    };

    let (mut review, claim) = match staged {
        Some((claim, board_review)) => {
            let review = if has_code {
                let code_prompt =
                    build_claim_code_review_prompt(meta, description, board, &claim);
                let code_reply = provider.chat_ex(
                    &ChatRequest::new(vec![
                        ChatMessage::system(CLAIM_CODE_SYSTEM_PROMPT),
                        ChatMessage::user(code_prompt),
                    ])
                    .json(),
                )?;
                let code = parse_review(&code_reply.content, &meta.cases)?;
                merge_layout_and_code_reviews(board_review, code)
            } else {
                board_review
            };
            (review, Some(claim))
        }
        None => {
            let prompt = build_review_prompt(meta, description, board);
            let reply = provider.chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(REVIEW_SYSTEM_PROMPT),
                    ChatMessage::user(prompt).with_images(board.images()),
                ])
                .json(),
            )?;
            (parse_review(&reply.content, &meta.cases)?, None)
        }
    };

    retrace_counterexample(provider, meta, board, &mut review);
    Ok(ReviewOutcome { review, claim })
}

/// Stages 1–3: describe the board, name its claim, and judge only when the
/// claim does not already decide the answer.
pub fn staged_board_review(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> Result<(Claim, ReviewResponse)> {
    let (claim, _) = perceive_and_claim(provider, meta, description, board)?;

    if claim.decides_the_answer() {
        return Ok((claim.clone(), on_track_review_from_claim(&claim)));
    }

    let prompt = build_verdict_prompt(meta, description, board, &claim);
    let reply = provider.chat_ex(
        &ChatRequest::new(vec![
            ChatMessage::system(VERDICT_SYSTEM_PROMPT),
            ChatMessage::user(prompt).with_images(board.images()),
        ])
        .json(),
    )?;
    let mut review = parse_review(&reply.content, &meta.cases)?;
    review.understood_approach = claim.understood_approach.clone();
    Ok((claim, review))
}

/// Stages 1 and 2. Stage 1 runs only when there is a PNG; text-only boards go
/// straight to the claim.
pub fn perceive_and_claim(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
) -> Result<(Claim, Option<Perception>)> {
    let perception = if board.png.is_some() {
        let prompt = build_perceive_prompt(meta, board);
        provider
            .chat_ex(
                &ChatRequest::new(vec![
                    ChatMessage::system(PERCEIVE_SYSTEM_PROMPT),
                    ChatMessage::user(prompt).with_images(board.images()),
                ])
                .json()
                .with_temperature(0.0),
            )
            .and_then(|reply| parse_perception(&reply.content))
            .ok()
    } else {
        None
    };

    let prompt = build_claim_prompt(meta, description, board, perception.as_ref());
    let mut message = ChatMessage::user(prompt);
    if perception.is_none() {
        message = message.with_images(board.images());
    }
    let reply = provider.chat_ex(
        &ChatRequest::new(vec![ChatMessage::system(CLAIM_SYSTEM_PROMPT), message]).json(),
    )?;
    let claim = parse_claim(&reply.content)?;
    Ok((claim, perception))
}

/// Re-derive `why_your_approach_fails` from a prompt that shows only the cited case.
pub fn retrace_counterexample(
    provider: &dyn LlmProvider,
    meta: &WorkspaceMeta,
    board: &BoardSnapshot,
    review: &mut ReviewResponse,
) {
    let Some(cited) = review.counterexample.as_ref() else {
        return;
    };
    let Some(case) = meta.cases.get(cited.case_index) else {
        return;
    };

    let prompt = build_trace_prompt(meta, board, case, cited.case_number);
    let request = ChatRequest::new(vec![
        ChatMessage::system(TRACE_SYSTEM_PROMPT),
        ChatMessage::user(prompt),
    ])
    .json()
    .with_temperature(0.0)
    .with_max_tokens(400);

    if let Ok(trace) = provider
        .chat_ex(&request)
        .and_then(|reply| parse_trace(&reply.content))
    {
        if let Some(cited) = review.counterexample.as_mut() {
            cited.why_your_approach_fails = trace;
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

fn verdict_label(v: Verdict) -> &'static str {
    match v {
        Verdict::OnTrack => "on track",
        Verdict::SubtlyWrong => "subtly wrong",
        Verdict::WrongTrack => "wrong track",
        Verdict::Unclear => "unclear",
    }
}

fn strip_review_tag_prefix(note: &str) -> String {
    note.trim()
        .strip_prefix("[layout] ")
        .or_else(|| note.trim().strip_prefix("[code] "))
        .map(str::to_string)
        .unwrap_or_else(|| note.trim().to_string())
}

/// The board as the staged path reads it: ink, layout, and canvas notes, with
/// the code dock stripped. Every stage before the code pass gets this, so a
/// stubby `solution.py` cannot seed the claim it is later judged against.
fn board_without_code(board: &BoardSnapshot) -> BoardSnapshot {
    let mut stripped = board.clone();
    stripped.pseudocode = None;
    stripped.pseudocode_delta = None;
    stripped.code_mode = None;
    stripped
}

fn write_perception(out: &mut String, perception: Option<&Perception>) {
    let Some(perception) = perception else {
        return;
    };
    let _ = writeln!(
        out,
        "\n## What was seen on the board (an earlier pass looked at the image)"
    );
    for item in &perception.observations {
        let _ = writeln!(out, "- {item}");
    }
    if !perception.transcribed_notes.is_empty() {
        let _ = writeln!(out, "\nText read off the board:");
        for note in &perception.transcribed_notes {
            let _ = writeln!(out, "- {note}");
        }
    }
    if !perception.illegible.is_empty() {
        let _ = writeln!(
            out,
            "\nCould not be read (do not assume these are empty or wrong):"
        );
        for region in &perception.illegible {
            let _ = writeln!(out, "- {region}");
        }
    }
}

/// The frozen claim, as every later stage sees it.
fn write_claim(out: &mut String, claim: &Claim) {
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

// ---------------------------------------------------------------------------
// Mode B — ambient nudges
// ---------------------------------------------------------------------------

pub const AMBIENT_SYSTEM_PROMPT: &str = "You are watching a student whiteboard a coding problem, \
over their shoulder, in real time. You speak rarely and briefly.\n\
\n\
Rules:\n\
- One or two sentences. This is a glance, not a review.\n\
- Do not repeat anything from \"already said\" — escalate instead of looping.\n\
- If the board is too sparse to judge, say so with low confidence and stay quiet.\n\
- Never write code or hand them the algorithm.\n\
- Reply with a single JSON object and nothing else.";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AmbientNudge {
    /// 0.0–1.0, how sure the coach is that it read the approach correctly.
    pub confidence: f32,
    pub guessed_approach: String,
    /// "cold" | "warm" | "close" | "there"
    pub closeness: String,
    pub nudge: String,
}

/// How hard the coach is allowed to push, derived from how many nudges this
/// session has already produced for the problem.
pub fn escalation_instruction(nudges_so_far: u32) -> &'static str {
    match nudges_so_far {
        0 => "This is your first nudge: ask one light question about their direction.",
        1 => "Second nudge: name the concept or invariant that matters, without solving it.",
        2 => "Third nudge: point at the shape of input that breaks or slows their approach.",
        _ => "They are stuck. Cite one concrete sample case by its index and what it does to \
              their approach — still no code.",
    }
}

pub fn build_ambient_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    already_said: &[String],
    nudges_so_far: u32,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);

    let _ = writeln!(out, "\n## Already said (do not repeat)");
    if already_said.is_empty() {
        let _ = writeln!(out, "\n(nothing yet — this is your first look)");
    } else {
        for line in already_said {
            let _ = writeln!(out, "- {}", clip(line, 300));
        }
    }

    let _ = writeln!(out, "\n## How hard to push\n\n{}", escalation_instruction(nudges_so_far));
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"confidence\": 0.0-1.0, \"guessed_approach\": \"one clause\", \
         \"closeness\": \"cold | warm | close | there\", \"nudge\": \"one or two sentences\"}}\n\
         ```"
    );
    out
}

pub fn parse_ambient(raw: &str) -> Result<AmbientNudge> {
    let mut nudge: AmbientNudge = parse_reply(raw, "ambient")?;
    nudge.confidence = nudge.confidence.clamp(0.0, 1.0);
    Ok(nudge)
}

// ---------------------------------------------------------------------------
// Mode A, second pass — pin the trace to the cited case
// ---------------------------------------------------------------------------

pub const TRACE_SYSTEM_PROMPT: &str = "You trace one algorithm on one input. Nothing else.\n\
\n\
Rules:\n\
- You are given exactly one test case. Every value you mention must come from it.\n\
- Walk the student's approach on that input, step by step, and stop at the point where it produces \
something other than the expected output.\n\
- Do not mention any other input, do not invent a clearer example, and do not generalize.\n\
- Four sentences at most. Reply with a single JSON object and nothing else.";

/// A one-case trace prompt.
///
/// Why this exists: an 8B local model given a dozen numbered cases will happily
/// cite a real index and then illustrate its point with an input it made up.
/// The student runs the cited case and sees something different. Narrowing the
/// prompt to the single cited case removes the wandering room — the model
/// cannot reference the other cases because it is not shown them.
pub fn build_trace_prompt(
    meta: &WorkspaceMeta,
    board: &BoardSnapshot,
    case: &IoCase,
    case_number: u32,
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# Problem: {}", meta.task_id);
    let _ = writeln!(
        out,
        "\n## The one case you are tracing (case {case_number})\n\n\
         - input:    `{}`\n- expected: `{}`",
        clip(&case.input, MAX_CASE),
        clip(&case.output, MAX_CASE)
    );
    // Both halves of what they wrote: the recognized ink *and* anything they
    // typed. Reading only the ink meant a pseudocode-only board looked empty
    // and the trace opened with "the student's approach is missing".
    let _ = writeln!(out, "\n## The student's approach");
    let approach = board.approach_text();
    let _ = writeln!(
        out,
        "\n```\n{}\n```",
        if approach.is_empty() {
            "(nothing legible — say so rather than guessing an approach)"
        } else {
            &approach
        }
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"trace\": \"run their approach on the input above, using only its values, and say \
         where it diverges from the expected output\"}}\n\
         ```"
    );
    out
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct TraceReply {
    trace: String,
}

pub fn parse_trace(raw: &str) -> Result<String> {
    let reply: TraceReply = parse_reply(raw, "trace")?;
    if reply.trace.trim().is_empty() {
        anyhow::bail!("the coach returned an empty trace");
    }
    Ok(reply.trace.trim().to_string())
}

// ---------------------------------------------------------------------------
// Mode D — diagrams and animations, via tool calls
// ---------------------------------------------------------------------------

pub const VIZ_SYSTEM_PROMPT: &str = "You draw on a student's whiteboard to explain a data \
structure or trace an algorithm.\n\
\n\
You draw by calling tools, never by describing pixels. You do not know where anything is on the \
board and you must not guess coordinates — the client lays your structures out for you.\n\
\n\
Rules:\n\
- One diagram per idea. To show change over time call `animate_trace` once with many frames; do \
NOT call `draw_structure` repeatedly to show the same structure at different moments.\n\
- For algorithm / pointer traces prefer about three frames (start → key middle → end); add more \
only when a step would be unclear without it.\n\
- Every frame carries the FULL state at that step, not a diff.\n\
- Reuse the same `id` when you mean the same structure, so it is updated rather than duplicated.\n\
- `cite_test_case` only accepts indices into the sample cases you were shown.\n\
- Keep any prose reply to one sentence; the drawing is the answer.";

/// Prompt for the `viz` mode. `ask` is what the student (or the review) wants
/// drawn; an empty `ask` means "pick whatever would help most".
pub fn build_viz_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    ask: &str,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    board.write_into(&mut out);

    let _ = writeln!(out, "\n## What to draw");
    if ask.trim().is_empty() {
        let _ = writeln!(
            out,
            "\nPick the one diagram that would most help them right now, and draw it."
        );
    } else {
        let _ = writeln!(out, "\n{}", clip(ask.trim(), 1000));
    }
    out
}

/// A note the coach attached to one of the board's regions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Annotation {
    pub region: String,
    pub text: String,
    pub tone: String,
}

/// A validated pointer at one sample case.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Citation {
    pub case_index: usize,
    /// 1-based, matching `lc test --case N`.
    pub case_number: u32,
    pub input: String,
    pub expected: String,
    pub why: String,
}

/// A read-only highlight over student elements (coach-owned overlay).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Highlight {
    pub ids: Vec<String>,
    pub tone: String,
    pub note: String,
}

/// Resolve a `cite_test_case` call against the real cases, or drop it.
pub fn validate_citation(raw: &serde_json::Value, cases: &[IoCase]) -> Option<Citation> {
    let case_index = raw.get("case_index")?.as_u64()? as usize;
    let case = cases.get(case_index)?;
    Some(Citation {
        case_index,
        case_number: case_index as u32 + 1,
        input: case.input.clone(),
        expected: case.output.clone(),
        why: raw
            .get("why")
            .and_then(|w| w.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Resolve `highlight_student_work` against truncated ids in `scene_structure`.
pub fn validate_highlight(raw: &serde_json::Value, board: &BoardSnapshot) -> Option<Highlight> {
    let requested: Vec<String> = raw
        .get("ids")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .take(6)
        .collect();
    if requested.is_empty() {
        return None;
    }
    let known = scene_structure_ids(board);
    let resolved: Vec<String> = requested
        .into_iter()
        .filter(|id| {
            known.iter().any(|known_id| {
                known_id == id
                    || known_id.starts_with(id.as_str())
                    || id.starts_with(known_id.as_str())
            })
        })
        .collect();
    if resolved.is_empty() {
        return None;
    }
    let note = raw
        .get("note")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .chars()
        .take(240)
        .collect::<String>();
    if note.trim().is_empty() {
        return None;
    }
    Some(Highlight {
        ids: resolved,
        tone: raw
            .get("tone")
            .and_then(|t| t.as_str())
            .unwrap_or("warning")
            .to_string(),
        note,
    })
}

fn scene_structure_ids(board: &BoardSnapshot) -> Vec<String> {
    let Some(structure) = &board.scene_structure else {
        return Vec::new();
    };
    let Some(arr) = structure.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|el| el.get("id").and_then(|id| id.as_str()).map(str::to_string))
        .collect()
}

// ---------------------------------------------------------------------------
// Mode C — the bridge, after an explicit reveal
// ---------------------------------------------------------------------------

pub const BRIDGE_SYSTEM_PROMPT: &str = "The student has explicitly asked to see how their own \
approach connects to a working one. You have been given a reference solution. Do NOT dump it.\n\
\n\
Your job is a stepwise refactor path from where they already are:\n\
- Name the parts of their approach that are already correct, concretely.\n\
- Identify the single missing idea, and why the reference needs it.\n\
- Give the smallest edit that moves them one step, then the next, in order.\n\
- Each step should be something they could have written themselves.\n\
- Reply with a single JSON object and nothing else.";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeStep {
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgeResponse {
    /// What their approach already gets right.
    pub already_yours: String,
    /// The one idea they are missing.
    pub missing_piece: String,
    pub steps: Vec<BridgeStep>,
    /// The smallest single edit that makes progress today.
    pub smallest_edit: String,
}

/// Build the bridge prompt.
///
/// `reference` is reference-solution text and must only ever come from
/// [`crate::reveal::SolutionReveal`], which is constructed from an explicit
/// user reveal. Nothing in the review or ambient path calls this.
pub fn build_bridge_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    reference: &str,
    failing: &[CaseResult],
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    board.write_into(&mut out);

    if !failing.is_empty() {
        let _ = writeln!(out, "\n## Cases their current code fails");
        for result in failing.iter().take(3) {
            let _ = writeln!(out, "\n### Case {}", result.case);
            let _ = writeln!(out, "- input:    `{}`", clip(&result.input, MAX_CASE));
            let _ = writeln!(out, "- expected: `{}`", clip(&result.expected, MAX_CASE));
            if let Some(actual) = &result.actual {
                let _ = writeln!(out, "- actual:   `{}`", clip(actual, MAX_CASE));
            }
        }
    }

    let _ = writeln!(
        out,
        "\n## Reference solution (the student asked for this — use it to plan the path, \
         do not paste it back)\n\n```python\n{}\n```",
        clip(reference.trim(), MAX_REFERENCE)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"already_yours\": \"...\", \"missing_piece\": \"...\", \
         \"steps\": [{{\"title\": \"...\", \"detail\": \"...\"}}], \
         \"smallest_edit\": \"the one change to make right now\"}}\n\
         ```"
    );
    out
}

pub fn parse_bridge(raw: &str) -> Result<BridgeResponse> {
    parse_reply(raw, "bridge")
}

// ---------------------------------------------------------------------------
// Lazy fill — write the parts of solution.py the student already earned
// ---------------------------------------------------------------------------

pub const LAZY_FILL_SYSTEM_PROMPT: &str = "The student is drawing on a tablet and turned on Lazy \
fill. Treat the whiteboard as the only source of truth — ignore a sparse or empty code dock.\n\
\n\
Your job: write the Python that implements the claim their board makes. When a claim is given to \
you, it is the specification — an earlier stage already read the board to produce it, so implement \
that, not an approach of your own.\n\
\n\
Rules:\n\
- Read ink, layout, and recognized text charitably; tablet handwriting is noisy.\n\
- If the board shows a correct insight (even without full code), implement that insight fully in \
`filled_code` — do not leave the earned part as TODO.\n\
- Only leave `pass` / `# TODO:` for ideas the board has not earned yet. When the claim lists what it \
has not decided, those items are the only TODOs allowed.\n\
- Prefer a short correct solution that matches their insight over a longer textbook dump.\n\
- Do NOT invent an unrelated full reference solution that contradicts their approach.\n\
- Reply with a single JSON object and nothing else.";

pub const LAZY_HINT_SYSTEM_PROMPT: &str = "The student confirmed a Lazy hint after drawing. The \
board is primary. You may look at the reference only to flesh out syntax for parts they already \
earned on the board.\n\
\n\
Rules:\n\
- Interpret the drawing first; fill the correct earned pieces into solution.py.\n\
- Leave only the unearned idea as TODO/pass.\n\
- Do not paste the full reference when their board only earned part of it.\n\
- Reply with a single JSON object and nothing else.";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LazyFillResponse {
    /// Full `solution.py` text to write into the workspace.
    pub filled_code: String,
    /// Short note of what was filled vs left for the student.
    pub note: String,
}

/// Lazy fill without a reference (composer Lazy flag).
///
/// `claim` is the claim the staged review already froze for this board. Passing
/// it is what makes Lazy fill *implement the drawing* rather than re-interpret
/// it: the same understanding the student just saw on their review card is the
/// thing that gets written into `solution.py`. `None` means no review has been
/// run for this board yet, and the model reads the board directly.
pub fn build_lazy_fill_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    claim: Option<&Claim>,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    // Board only — ignore whatever is in the code dock.
    board_without_code(board).write_into(&mut out);
    if let Some(claim) = claim {
        write_claim(&mut out, claim);
    }
    let _ = writeln!(
        out,
        "\n## Task\n\n{}\n\n\
         ## Your reply\n\n\
         ```json\n\
         {{\"filled_code\": \"# full solution.py text\\n...\", \
         \"note\": \"one or two sentences: what you filled from the board vs left as TODO\"}}\n\
         ```",
        if claim.is_some() {
            "Write `filled_code`: full working Python for the claim above. Every step the claim \
             justifies must be implemented, not left as a TODO — only what the claim says it has \
             not decided may stay `pass` / `# TODO:`."
        } else {
            "Interpret the drawing. Write `filled_code` that correctly implements what the board \
             already justifies (full working code for those parts). Leave only unearned ideas as \
             TODO/pass."
        }
    );
    out
}

/// Lazy fill after Hint confirm — reference is allowed for the earned parts only.
pub fn build_lazy_hint_prompt(
    meta: &WorkspaceMeta,
    description: Option<&str>,
    board: &BoardSnapshot,
    reference: &str,
) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    board.write_into(&mut out);
    let _ = writeln!(
        out,
        "\n## Reference solution (use only to flesh out what they already earned)\n\n\
         ```python\n{}\n```",
        clip(reference.trim(), MAX_REFERENCE)
    );
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         ```json\n\
         {{\"filled_code\": \"# full solution.py text\\n...\", \
         \"note\": \"what you filled vs left for them\"}}\n\
         ```"
    );
    out
}

pub fn parse_lazy_fill(raw: &str) -> Result<LazyFillResponse> {
    let mut parsed: LazyFillResponse = parse_reply(raw, "lazy fill")?;
    parsed.filled_code = parsed.filled_code.trim().to_string();
    if parsed.filled_code.is_empty() {
        anyhow::bail!("lazy fill returned empty filled_code");
    }
    Ok(parsed)
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

fn prefix_notes(tag: &str, notes: &[String]) -> Vec<String> {
    notes
        .iter()
        .filter(|n| !n.trim().is_empty())
        .map(|n| format!("[{tag}] {n}"))
        .collect()
}

/// Board-first merge: a correct layout is not dragged down by thin code.
fn prefer_layout_verdict(layout: Verdict, code: Verdict) -> Verdict {
    use Verdict::*;
    match layout {
        OnTrack => OnTrack,
        Unclear => code,
        // Keep the board's criticism; incomplete code shouldn't soften a wrong board.
        SubtlyWrong | WrongTrack => layout,
    }
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

fn write_problem_header(out: &mut String, meta: &WorkspaceMeta, description: Option<&str>) {
    let _ = writeln!(out, "# Problem: {}", meta.task_id);
    if let Some(q) = &meta.question_id {
        let _ = writeln!(out, "LeetCode question id: {q}");
    }
    if let Some(d) = &meta.difficulty {
        let _ = writeln!(out, "Difficulty: {d}");
    }
    if !meta.tags.is_empty() {
        let _ = writeln!(out, "Tags: {}", meta.tags.join(", "));
    }
    if let Some(desc) = description {
        let _ = writeln!(out, "\n## Statement\n\n{}", clip(desc, MAX_DESCRIPTION));
    }
}

/// The numbered sample cases a counterexample must be cited from. These are
/// sample I/O out of `.lc/meta.json`, not reference solutions, so showing them
/// preserves the redaction invariant.
fn write_cases(out: &mut String, cases: &[IoCase]) {
    if cases.is_empty() {
        let _ = writeln!(
            out,
            "\n## Sample cases\n\n(none in the corpus for this problem — you cannot cite a \
             counterexample; set it to null)"
        );
        return;
    }
    let _ = writeln!(
        out,
        "\n## Sample cases (cite counterexamples by these 0-based indices)"
    );
    for (i, case) in cases.iter().take(MAX_CASES_SHOWN).enumerate() {
        let _ = writeln!(
            out,
            "- [{i}] input: `{}` → expected: `{}`",
            clip(&case.input, MAX_CASE),
            clip(&case.output, MAX_CASE)
        );
    }
    if cases.len() > MAX_CASES_SHOWN {
        let _ = writeln!(
            out,
            "\n(only the first {MAX_CASES_SHOWN} of {} cases are shown; cite one of these)",
            cases.len()
        );
    }
}

/// Extract and deserialize a coach reply.
///
/// Deliberately lenient about the ways a small local model malforms JSON, and
/// strict about nothing except "is the payload usable". In particular it goes
/// via [`serde_json::Value`], which makes a **duplicate field last-wins**
/// instead of a hard error — an 8B model that emits
/// `why_your_approach_fails` twice should not cost the student their whole
/// review.
fn parse_reply<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T> {
    let json = extract_json(raw)
        .with_context(|| format!("the coach did not return JSON: {}", clip(raw, 400)))?;
    let value: serde_json::Value = serde_json::from_str(json)
        .with_context(|| format!("bad {what} JSON: {}", clip(json, 400)))?;
    serde_json::from_value(value)
        .with_context(|| format!("unexpected {what} shape: {}", clip(json, 400)))
}

/// Pull the JSON object out of a reply, tolerating markdown fences and the
/// leading chatter small local models like to add.
pub fn extract_json(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }
    // Balanced scan, so a `}` inside a string value doesn't cut it short.
    let bytes = trimmed.as_bytes();
    let start = trimmed.find('{')?;
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for i in start..bytes.len() {
        let c = bytes[i];
        if in_string {
            match c {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&trimmed[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta_with_cases(n: usize) -> WorkspaceMeta {
        WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: "two-sum".into(),
            question_id: Some("1".into()),
            difficulty: Some("Easy".into()),
            tags: vec!["Array".into()],
            entry_point: Some("twoSum".into()),
            json_path: "corpus.jsonl".into(),
            cases: (0..n)
                .map(|i| IoCase {
                    input: format!("nums = [{i}]"),
                    output: format!("[{i}]"),
                })
                .collect(),
            test: None,
        }
    }

    #[test]
    fn extract_json_survives_fences_and_chatter() {
        let raw = "Sure! Here you go:\n```json\n{\"verdict\": \"on_track\"}\n```\nHope that helps.";
        assert_eq!(extract_json(raw), Some("{\"verdict\": \"on_track\"}"));
    }

    #[test]
    fn extract_json_ignores_braces_inside_strings() {
        let raw = r#"{"nudge": "try a set like {1,2}", "closeness": "warm"}"#;
        assert_eq!(extract_json(raw), Some(raw));
    }

    #[test]
    fn valid_case_index_is_backfilled_from_the_corpus() {
        // The model cites a real index but misquotes the contents.
        let raw = r#"{"verdict": "subtly_wrong",
                      "counterexample": {"case_index": 2, "input": "MADE UP",
                                         "expected": "ALSO MADE UP",
                                         "why_your_approach_fails": "duplicate values"}}"#;
        let review = parse_review(raw, &meta_with_cases(4).cases).unwrap();
        let cited = review.counterexample.expect("kept");
        assert_eq!(cited.case_index, 2);
        assert_eq!(cited.case_number, 3, "case_number is 1-based for `lc test --case`");
        assert_eq!(cited.input, "nums = [2]", "input came from the corpus, not the model");
        assert_eq!(cited.expected, "[2]");
        assert!(review.counterexample_rejected.is_none());
    }

    #[test]
    fn fabricated_case_index_is_rejected() {
        let raw = r#"{"verdict": "wrong_track",
                      "counterexample": {"case_index": 99, "input": "nums = [1,2,3]",
                                         "expected": "[0,1]",
                                         "why_your_approach_fails": "invented"}}"#;
        let review = parse_review(raw, &meta_with_cases(4).cases).unwrap();
        assert!(review.counterexample.is_none(), "hallucinated case must not survive");
        let note = review.counterexample_rejected.expect("rejection is reported");
        assert!(note.contains("99") && note.contains('4'), "note names the bad index: {note}");
    }

    #[test]
    fn typed_pseudocode_reaches_the_prompt_and_is_marked_exact() {
        let meta = meta_with_cases(2);
        let board = BoardSnapshot {
            pseudocode: Some("for i, x in enumerate(nums):\n    seen[x] = i".into()),
            ..Default::default()
        };
        assert!(!board.is_empty(), "pseudocode alone is enough to review");

        let prompt = build_review_prompt(&meta, None, &board);
        assert!(prompt.contains("seen[x] = i"));
        assert!(
            prompt.contains("exact, not recognized"),
            "the coach must not second-guess typed text the way it does OCR"
        );
    }

    /// The trace second pass reads the whole approach, not just the ink — a
    /// pseudocode-only board used to reach it looking blank.
    #[test]
    fn the_trace_prompt_sees_typed_pseudocode_too() {
        let meta = meta_with_cases(3);
        let typed_only = BoardSnapshot {
            pseudocode: Some("nums.sort()\ni, j = 0, len(nums)-1".into()),
            ..Default::default()
        };
        let prompt = build_trace_prompt(&meta, &typed_only, &meta.cases[0], 1);
        assert!(prompt.contains("nums.sort()"), "typed approach must reach the trace");
        assert!(!prompt.contains("nothing legible"));

        let both = BoardSnapshot {
            recognized_text: "two pointers".into(),
            pseudocode: Some("i, j = 0, n-1".into()),
            ..Default::default()
        };
        assert_eq!(both.approach_text(), "two pointers\n\ni, j = 0, n-1");

        // And an actually-blank board says so rather than inviting a guess.
        let blank = build_trace_prompt(&meta, &BoardSnapshot::default(), &meta.cases[0], 1);
        assert!(blank.contains("nothing legible"));
    }

    /// A browser build sends no transcribed ink at all, so a board full of
    /// hand-drawn boxes arrives with an empty `recognized_text`. The prompt has
    /// to point the coach at the layout instead of letting it announce a blank
    /// board and demand they go implement something.
    #[test]
    fn an_untranscribed_board_is_described_by_its_layout_not_called_blank() {
        let meta = meta_with_cases(2);
        let drawn = BoardSnapshot {
            scene_structure: Some(serde_json::json!([
                {"id": "aaa", "type": "rectangle", "x": 10, "y": 10, "w": 80, "h": 40},
                {"id": "bbb", "type": "arrow", "x": 90, "y": 30, "w": 60, "h": 4},
            ])),
            ..Default::default()
        };
        assert!(drawn.has_visual_evidence());
        let prompt = build_review_prompt(&meta, None, &drawn);
        assert!(prompt.contains("does not transcribe ink"));
        assert!(prompt.contains("Do NOT tell them the board is blank"));

        // Nothing at all still reads as nothing at all.
        let nothing = BoardSnapshot::default();
        assert!(!nothing.has_visual_evidence());
        let prompt = build_review_prompt(&meta, None, &nothing);
        assert!(prompt.contains("no recognized handwriting yet"));
        assert!(!prompt.contains("does not transcribe ink"));
    }

    /// A sparse early board should get interview opening help, not a failure grade.
    #[test]
    fn the_review_prompt_asks_for_opening_hints_on_a_sparse_board() {
        assert!(REVIEW_SYSTEM_PROMPT.contains("sparse"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("start coding"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("problem-specific"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("Do NOT hunt for criticism"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("Prefer the whiteboard layout"));
    }

    fn sufficient_claim() -> Claim {
        Claim {
            understood_approach: "trailing zeros mean the double reversal cannot round-trip".into(),
            key_steps: vec![
                "reverse the digits once".into(),
                "note that a trailing zero is lost and cannot come back".into(),
            ],
            claim_sufficient: true,
            why_sufficient_or_not: "The zero-loss argument settles every input the problem allows."
                .into(),
            unresolved: vec![],
            confirming_question: "Which input would you run to see the zero disappear?".into(),
        }
    }

    /// The gate the whole redesign turns on. A claim that decides the answer must
    /// clear it; a model that answers the field without reading a board must not.
    #[test]
    fn the_sufficiency_gate_needs_a_real_named_approach() {
        assert!(sufficient_claim().decides_the_answer());

        // Terse but real: two words is a legitimate approach name.
        assert!(Claim {
            understood_approach: "two pointers".into(),
            claim_sufficient: true,
            ..Default::default()
        }
        .decides_the_answer());

        for junk in ["yes", "ok", "sort", "   "] {
            assert!(
                !Claim {
                    understood_approach: junk.into(),
                    claim_sufficient: true,
                    ..Default::default()
                }
                .decides_the_answer(),
                "{junk:?} is not a claim that can short-circuit a student to on_track"
            );
        }

        // And saying so is not optional: an unsufficient claim never gates out.
        assert!(!Claim {
            claim_sufficient: false,
            ..sufficient_claim()
        }
        .decides_the_answer());
    }

    /// A model that answers "this is enough" *and* lists what is missing is
    /// contradicting itself; the parser keeps the answer and drops the list.
    #[test]
    fn a_sufficient_claim_cannot_also_carry_unresolved_items() {
        let raw = r#"{"understood_approach": "count trailing zeros",
                      "key_steps": ["  reverse once  ", "", "spot the lost zero"],
                      "claim_sufficient": true,
                      "why_sufficient_or_not": "the argument decides it",
                      "unresolved": ["they have not written the reversal loop"],
                      "confirming_question": "which case shows it?"}"#;
        let claim = parse_claim(raw).unwrap();
        assert!(claim.unresolved.is_empty(), "sufficient means nothing is left open");
        assert_eq!(claim.key_steps, vec!["reverse once", "spot the lost zero"]);
        assert!(claim.decides_the_answer());

        // When it says no, the list survives — that is what stage 3 reads.
        let insufficient = parse_claim(
            r#"{"understood_approach": "reverse the digits", "claim_sufficient": false,
                "unresolved": ["nothing decides what happens on overflow"]}"#,
        )
        .unwrap();
        assert_eq!(insufficient.unresolved.len(), 1);

        // A reply that names no approach is not a claim at all.
        assert!(parse_claim(r#"{"claim_sufficient": true}"#).is_err());
    }

    /// Acceptance criterion 1: the correct insight-only board. It reaches the
    /// student as `on_track` with no gaps, and nothing in the card is a fresh
    /// judgement — every line is copied from the claim.
    #[test]
    fn the_on_track_card_is_built_from_the_claim_and_invents_nothing() {
        let claim = sufficient_claim();
        let review = on_track_review_from_claim(&claim);

        assert_eq!(review.verdict, Verdict::OnTrack);
        assert!(review.gaps.is_empty(), "an on-track board has no gaps to list");
        assert!(review.counterexample.is_none(), "and nothing to cite against it");
        assert!(!review.offer_bridge, "nor a reason to offer the reference");
        assert_eq!(review.understood_approach, claim.understood_approach);
        assert_eq!(review.socratic_question, claim.confirming_question);
        assert_eq!(review.rating.correctness, 5);
        assert_eq!(review.layout_verdict, Some(Verdict::OnTrack));
        // The reason it is sufficient, then the steps, read back as strengths.
        assert_eq!(review.strengths[0], claim.why_sufficient_or_not);
        assert!(review.strengths.contains(&claim.key_steps[1]));

        // With no question offered, the card still asks something specific.
        let quiet = on_track_review_from_claim(&Claim {
            confirming_question: String::new(),
            ..claim
        });
        assert!(quiet.socratic_question.contains("trailing zeros"));
    }

    #[test]
    fn format_review_card_is_plain_text_without_json() {
        let review = on_track_review_from_claim(&sufficient_claim());
        let text = format_review_card(&review);
        assert!(text.contains("Verdict: on track"));
        assert!(text.contains("Approach:"));
        assert!(text.contains("Next:"));
        assert!(!text.contains('{'), "no raw JSON for the TUI");
    }

    /// Stage 1 describes; it is given nothing to have an opinion about. No
    /// statement, no sample cases, no code dock — and a system prompt that says
    /// so out loud.
    #[test]
    fn the_perceive_stage_sees_the_board_and_nothing_to_judge_it_against() {
        let meta = meta_with_cases(3);
        let board = BoardSnapshot {
            recognized_text: "reverse digits, zeros vanish".into(),
            pseudocode: Some("def solve(): pass  # HALF TYPED".into()),
            png: Some("base64".into()),
            ..Default::default()
        };
        let prompt = build_perceive_prompt(&meta, &board);

        assert!(prompt.contains("reverse digits, zeros vanish"));
        assert!(!prompt.contains("HALF TYPED"), "the code dock is not board evidence");
        assert!(!prompt.contains("- [0] input:"), "no cases to reason from");
        assert!(!prompt.contains("## Statement"));
        assert!(PERCEIVE_SYSTEM_PROMPT.contains("You do not judge it"));
        assert!(PERCEIVE_SYSTEM_PROMPT.contains("No verdict, no gaps"));

        assert!(parse_perception(r#"{"observations": [], "transcribed_notes": []}"#).is_err());
        let seen = parse_perception(
            r#"{"observations": ["  a box labelled n  ", ""], "illegible": ["bottom right"]}"#,
        )
        .unwrap();
        assert_eq!(seen.observations, vec!["a box labelled n"]);
        assert!(!seen.is_blank());
    }

    /// Stage 2 gets the problem, the cases, and stage 1's description — but still
    /// not the code dock, so a stubby `solution.py` cannot seed the claim it is
    /// later judged against.
    #[test]
    fn the_claim_stage_reads_the_board_and_the_perception_but_not_the_code() {
        let meta = meta_with_cases(3);
        let board = BoardSnapshot {
            recognized_text: "reverse digits".into(),
            pseudocode: Some("def solve(): pass  # HALF TYPED".into()),
            ..Default::default()
        };
        let perception = Perception {
            observations: vec!["two boxes joined by an arrow".into()],
            transcribed_notes: vec!["120 -> 021".into()],
            illegible: vec!["a smudge under the arrow".into()],
        };

        let prompt = build_claim_prompt(&meta, Some("Reverse an integer."), &board, Some(&perception));
        assert!(prompt.contains("Reverse an integer."));
        assert!(prompt.contains("- [0] input:"), "stage 2 may cite from the cases later");
        assert!(prompt.contains("two boxes joined by an arrow"));
        assert!(prompt.contains("120 -> 021"));
        assert!(prompt.contains("do not assume these are empty or wrong"));
        assert!(!prompt.contains("HALF TYPED"));
        assert!(prompt.contains("\"claim_sufficient\""));

        // On a text-only build there is no perception section at all.
        let text_only = build_claim_prompt(&meta, None, &board, None);
        assert!(!text_only.contains("an earlier pass looked at the image"));
        assert!(text_only.contains("reverse digits"));

        assert!(CLAIM_SYSTEM_PROMPT.contains("An insight that removes work counts"));
        assert!(CLAIM_SYSTEM_PROMPT.contains("are NOT reasons to answer false"));
    }

    /// Stage 3a is the only stage allowed to look for what is missing, and it is
    /// handed the claim rather than the board's raw ink to re-interpret.
    #[test]
    fn the_verdict_stage_is_handed_a_frozen_claim() {
        let meta = meta_with_cases(3);
        let claim = Claim {
            claim_sufficient: false,
            why_sufficient_or_not: "nothing says what happens when the input is negative".into(),
            unresolved: vec!["negative inputs".into()],
            ..sufficient_claim()
        };
        let prompt = build_verdict_prompt(&meta, None, &BoardSnapshot::default(), &claim);

        assert!(prompt.contains("frozen — read it as given"));
        assert!(prompt.contains("trailing zeros mean the double reversal cannot round-trip"));
        assert!(prompt.contains("does this already decide the answer? no"));
        assert!(prompt.contains("- not decided by the board yet:"));
        assert!(prompt.contains("negative inputs"));
        assert!(prompt.contains("- [2] input:"), "a counterexample needs real indices");

        assert!(VERDICT_SYSTEM_PROMPT.contains("The claim is fixed"));
        assert!(VERDICT_SYSTEM_PROMPT.contains("never pad the list"));
        assert!(VERDICT_SYSTEM_PROMPT.contains("must be null"));
    }

    /// The code pass asks whether the code matches the claim. It is never asked
    /// what approach the stub suggests — that question is how half-typed tablet
    /// code used to talk the coach out of a correct board.
    #[test]
    fn the_code_pass_is_conditioned_on_the_claim() {
        let meta = meta_with_cases(2);
        let board = BoardSnapshot {
            pseudocode: Some("def solve(n):\n    pass".into()),
            app_messages: vec!["Run tests — 1/2 passed".into()],
            ..Default::default()
        };
        let prompt =
            build_claim_code_review_prompt(&meta, None, &board, &sufficient_claim());

        assert!(prompt.contains("Does this code implement the claim above?"));
        assert!(prompt.contains("The claim the board makes"));
        assert!(prompt.contains("def solve(n):"));
        assert!(prompt.contains("1/2 passed"), "test results are facts the pass may cite");
        assert!(CLAIM_CODE_SYSTEM_PROMPT.contains("The claim is the specification"));
        assert!(CLAIM_CODE_SYSTEM_PROMPT.contains("are not gaps"));
    }

    /// Acceptance criterion 2: Lazy implements the claim, and the code dock is
    /// not the source of truth.
    #[test]
    fn lazy_fill_implements_the_frozen_claim() {
        let meta = meta_with_cases(2);
        let board = BoardSnapshot {
            recognized_text: "zeros vanish".into(),
            pseudocode: Some("# WRONG OLD ATTEMPT".into()),
            ..Default::default()
        };
        let claim = sufficient_claim();

        let with_claim = build_lazy_fill_prompt(&meta, None, &board, Some(&claim));
        assert!(with_claim.contains("full working Python for the claim above"));
        assert!(with_claim.contains("reverse the digits once"));
        assert!(!with_claim.contains("WRONG OLD ATTEMPT"), "the dock is not the truth here");

        // No review yet for this board: fall back to reading the drawing.
        let without = build_lazy_fill_prompt(&meta, None, &board, None);
        assert!(without.contains("Interpret the drawing"));
        assert!(!without.contains("The claim the board makes"));
        assert!(!without.contains("WRONG OLD ATTEMPT"));

        assert!(LAZY_FILL_SYSTEM_PROMPT.contains("it is the specification"));
    }

    #[test]
    fn merge_prefers_on_track_board_over_thin_code() {
        let layout = ReviewResponse {
            understood_approach: "trailing zeros break double reversal".into(),
            verdict: Verdict::OnTrack,
            strengths: vec!["key insight".into()],
            gaps: vec![],
            ..Default::default()
        };
        let code = ReviewResponse {
            understood_approach: "stub".into(),
            verdict: Verdict::SubtlyWrong,
            gaps: vec!["does not implement the actual reversal logic".into()],
            offer_bridge: true,
            ..Default::default()
        };
        let merged = merge_layout_and_code_reviews(layout, code);
        assert_eq!(merged.verdict, Verdict::OnTrack);
        assert!(merged.gaps.iter().all(|g| !g.contains("reversal logic")));
        assert!(!merged.offer_bridge);
        assert_eq!(merged.layout_verdict, Some(Verdict::OnTrack));
        assert_eq!(merged.code_verdict, Some(Verdict::SubtlyWrong));
    }

    /// "Run tests" posts its results into the thread and they ride along with
    /// the next question, so asking "why did case 3 fail?" needs no
    /// copy-paste — and the coach must read them as fact, not as a claim.
    #[test]
    fn test_results_reach_the_prompt_as_the_apps_own_channel() {
        let meta = meta_with_cases(3);
        let board = BoardSnapshot {
            recognized_text: "two pointers".into(),
            app_messages: vec![
                "Run tests — 2/3 passed\n\ncase 3: nums = [2]\n  expected: [2]\n  got: []".into(),
            ],
            ..Default::default()
        };
        let prompt = build_review_prompt(&meta, None, &board);
        assert!(prompt.contains("From the app (not the student)"));
        assert!(prompt.contains("2/3 passed"));
        assert!(prompt.contains("Treat them as fact"));

        // And a board with no run says nothing about one.
        let quiet = build_review_prompt(&meta, None, &BoardSnapshot::default());
        assert!(!quiet.contains("From the app"));
    }

    #[test]
    fn a_board_with_neither_ink_nor_pseudocode_is_empty() {
        assert!(BoardSnapshot::default().is_empty());
        assert!(BoardSnapshot {
            pseudocode: Some("   ".into()),
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn a_cited_case_is_resolved_from_the_corpus_or_dropped() {
        let cases = meta_with_cases(3).cases;
        let good = serde_json::json!({"case_index": 1, "why": "duplicates"});
        let citation = validate_citation(&good, &cases).expect("kept");
        assert_eq!(citation.case_number, 2);
        assert_eq!(citation.input, "nums = [1]");
        assert_eq!(citation.expected, "[1]");
        assert_eq!(citation.why, "duplicates");

        // Out of range, negative, and missing all drop rather than render.
        for bad in [
            serde_json::json!({"case_index": 3, "why": "invented"}),
            serde_json::json!({"case_index": -1, "why": "invented"}),
            serde_json::json!({"why": "no index at all"}),
        ] {
            assert!(validate_citation(&bad, &cases).is_none(), "{bad} should drop");
        }
    }

    #[test]
    fn highlight_keeps_only_ids_present_on_the_board() {
        let board = BoardSnapshot {
            scene_structure: Some(serde_json::json!([
                {"id": "el_44abc", "type": "text", "text": "O(n)"},
                {"id": "el_55def", "type": "text", "text": "hash"}
            ])),
            ..Default::default()
        };
        let good = serde_json::json!({
            "ids": ["el_44abc", "missing", "el_55"],
            "tone": "warning",
            "note": "inner loop rescans"
        });
        let highlight = validate_highlight(&good, &board).expect("partially valid");
        assert_eq!(highlight.ids, vec!["el_44abc", "el_55"]);
        assert!(validate_highlight(
            &serde_json::json!({"ids": ["nope"], "note": "x"}),
            &board
        )
        .is_none());
    }

    #[test]
    fn the_viz_prompt_forbids_coordinates_and_numbers_the_cases() {
        let meta = meta_with_cases(2);
        let prompt = build_viz_prompt(&meta, None, &BoardSnapshot::default(), "show the scan");
        assert!(prompt.contains("show the scan"));
        assert!(prompt.contains("- [0] input:"));
        assert!(VIZ_SYSTEM_PROMPT.contains("must not guess coordinates"));
        assert!(VIZ_SYSTEM_PROMPT.contains("about three frames"));
    }

    /// Observed from granite-4.1-8b: it emitted `why_your_approach_fails`
    /// twice, and strict serde threw away an otherwise-good review.
    #[test]
    fn a_duplicated_field_does_not_cost_the_whole_review() {
        let raw = r#"{
            "understood_approach": "sort then two pointers",
            "verdict": "wrong_track",
            "counterexample": {"case_index": 1,
                               "why_your_approach_fails": "first attempt",
                               "why_your_approach_fails": "second attempt"}
        }"#;
        let review = parse_review(raw, &meta_with_cases(4).cases).expect("survives duplicates");
        assert_eq!(review.verdict, Verdict::WrongTrack);
        let cited = review.counterexample.expect("citation kept");
        assert_eq!(
            cited.why_your_approach_fails, "second attempt",
            "a duplicate field is last-wins, not fatal"
        );
    }

    /// The second pass exists because a model given a dozen cases cites one and
    /// then traces a different, invented input. Its prompt therefore shows the
    /// cited case and nothing else.
    #[test]
    fn the_trace_prompt_shows_one_case_and_no_others() {
        let meta = meta_with_cases(8);
        let board = BoardSnapshot {
            recognized_text: "sort then two pointers".into(),
            ..Default::default()
        };
        let prompt = build_trace_prompt(&meta, &board, &meta.cases[5], 6);

        assert!(prompt.contains("case 6"));
        assert!(prompt.contains("nums = [5]"), "the cited case is present");
        for other in [0, 1, 2, 3, 4, 6, 7] {
            assert!(
                !prompt.contains(&format!("nums = [{other}]")),
                "case {other} must not be visible — that is the wandering room this removes"
            );
        }
        assert!(prompt.contains("sort then two pointers"), "their approach is present");
        assert!(TRACE_SYSTEM_PROMPT.contains("Do not mention any other input"));
    }

    #[test]
    fn a_trace_reply_is_read_and_an_empty_one_rejected() {
        assert_eq!(
            parse_trace(r#"{"trace": "  sorting gives [0,0,3,4]  "}"#).unwrap(),
            "sorting gives [0,0,3,4]"
        );
        assert!(parse_trace(r#"{"trace": "   "}"#).is_err());
        assert!(parse_trace("no json here").is_err());
    }

    #[test]
    fn unknown_verdict_degrades_instead_of_failing() {
        let review = parse_review(r#"{"verdict": "kinda_ok", "rating": {"correctness": 9}}"#, &[])
            .unwrap();
        assert_eq!(review.verdict, Verdict::Unclear);
        assert_eq!(review.rating.correctness, 5, "ratings are clamped to 0-5");
    }

    #[test]
    fn ratings_accept_floats_and_numeric_strings() {
        let review = parse_review(
            r#"{"verdict":"unclear","rating":{"correctness":2.0,"complexity":"3","clarity":1}}"#,
            &[],
        )
        .unwrap();
        assert_eq!(review.rating.correctness, 2);
        assert_eq!(review.rating.complexity, 3);
        assert_eq!(review.rating.clarity, 1);
    }

    #[test]
    fn review_prompt_numbers_the_cases_it_allows_citing() {
        let meta = meta_with_cases(3);
        let prompt = build_review_prompt(&meta, Some("Find two numbers."), &BoardSnapshot::default());
        assert!(prompt.contains("- [0] input:"));
        assert!(prompt.contains("- [2] input:"));
        assert!(!prompt.contains("- [3] input:"));
    }

    /// Structural half of the reveal gate: the review and ambient builders must
    /// not so much as mention the reveal path. Everything between the "Mode A"
    /// and "Mode C" banners is the non-privileged half of this file.
    #[test]
    fn the_review_and_ambient_builders_cannot_reach_a_reveal() {
        let source = include_str!("coach.rs");
        let start = source
            .find("// Mode A — submit for review")
            .expect("Mode A banner");
        let end = source
            .find("// Mode C — the bridge")
            .expect("Mode C banner");
        let unprivileged = &source[start..end];

        for forbidden in ["SolutionReveal", "UserConsent", "reveal::", "completion"] {
            assert!(
                !unprivileged.contains(forbidden),
                "the review/ambient half of coach.rs must not mention {forbidden:?}"
            );
        }
        // And the privileged half does, so the test is actually discriminating.
        assert!(source[end..].contains("SolutionReveal"));
    }

    /// Behavioural half: feed the builders a problem whose corpus record has a
    /// reference solution and confirm none of it can appear.
    #[test]
    fn no_prompt_built_from_workspace_meta_can_carry_a_solution() {
        let record = r#"{"task_id": "two-sum", "difficulty": "Easy",
            "problem_description": "Find two numbers.",
            "completion": "SECRET_SOLUTION_BODY", "response": "SECRET_RESPONSE",
            "query": "SECRET_QUERY",
            "input_output": [{"input": "nums = [2,7]", "output": "[0,1]"}]}"#;
        let problem: crate::problem::Problem = serde_json::from_str(record).unwrap();
        let meta = WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: problem.task_id.clone(),
            question_id: problem.question_id.clone(),
            difficulty: problem.difficulty.clone(),
            tags: problem.tags.clone(),
            entry_point: problem.entry_point.clone(),
            json_path: "corpus.jsonl".into(),
            cases: problem.input_output.clone(),
            test: problem.test.clone(),
        };
        let board = BoardSnapshot {
            recognized_text: "sort then two pointers".into(),
            ..Default::default()
        };
        let description = problem.problem_description.as_deref();

        let review = build_review_prompt(&meta, description, &board);
        let ambient = build_ambient_prompt(&meta, description, &board, &[], 0);
        for prompt in [&review, &ambient] {
            assert!(prompt.contains("Find two numbers."), "statement still gets through");
            assert!(!prompt.contains("SECRET"), "solution text leaked into a prompt");
        }
    }

    #[test]
    fn ambient_prompt_escalates_and_does_not_repeat_itself() {
        let meta = meta_with_cases(2);
        let said = vec!["Have you considered the sorted order?".to_string()];
        let prompt = build_ambient_prompt(&meta, None, &BoardSnapshot::default(), &said, 3);
        assert!(prompt.contains("Already said (do not repeat)"));
        assert!(prompt.contains("sorted order"));
        assert!(prompt.contains("Cite one concrete sample case"));
    }
}
