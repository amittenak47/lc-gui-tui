//! Prompt builders and response types for the whiteboard coach.
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

pub const REVIEW_SYSTEM_PROMPT: &str = "You are a sharp, demanding whiteboard interviewer for \
competitive programming. The student has sketched an approach by hand — you are reading their \
handwriting, not their code. Your job is to work out what they intend, judge whether it actually \
works, and if it does not, find the specific sample test case that breaks it.\n\
\n\
Rules:\n\
- Infer the approach charitably: handwriting recognition is noisy and notation is abbreviated.\n\
- Judge the ALGORITHM, not the penmanship or the missing syntax.\n\
- If the approach is wrong or incomplete, you MUST cite a counterexample by its index into the \
numbered sample cases you are given. Never invent a case, an input, or an index — if none of the \
given cases breaks their approach, set \"counterexample\" to null and say so in \"gaps\".\n\
- Your explanation of the counterexample must trace THE CITED CASE. Use that case's actual values \
and no others. Do not introduce a different, easier, or made-up array to illustrate the point — a \
trace of some other input is worse than no trace, because the student will run the case you cited \
and see something different.\n\
- On a follow-up turn (when \"Since your last look\" is present), respond to what is new; do not \
repeat a point you already made.\n\
- Some devices cannot transcribe ink at all. Missing handwriting text is NOT an empty board: read \
the canvas layout — and the attached image when there is one — and work out what the boxes, \
arrows and positions mean before you judge anything. Never assert the board is blank when there \
are objects on it.\n\
- If the board is sparse or the session is early, you are opening an interview, not grading a \
failure. Do not say they have done nothing, do not tell them to \"start coding\" or to \"implement \
a solution\", and do not treat the attempt as failed. Instead put one or two concrete, \
problem-specific opening hints in \"gaps\": which constraint actually bites, a small input worth \
walking by hand, a data structure that fits the access pattern, an invariant worth chasing. \
Specific to THIS problem — no generic encouragement — and use \"unclear\" as the verdict while \
there is not yet an approach to judge.\n\
- Keep fields distinct: \"understood_approach\" is ONE short sentence naming their intended idea \
(or that they are still exploring) — do not list missing pieces there. \"gaps\" lists only concrete \
missing pieces or next building blocks — do not restate understood_approach. \
\"socratic_question\" is the most specific and actionable field: a direct next move or probe \
(which cell, which case, which invariant) that is more detailed than understood_approach.\n\
- Always score \"rating\" with integers 1–5 for correctness, complexity, and clarity. Use 1–2 when \
the board is sparse or the approach is unclear, 3 when partially formed, 4–5 when solid. Never \
return all zeros if the student wrote, asked, or sketched anything; reserve 0 only for a truly \
blank board.\n\
- Never write the corrected algorithm or working code. End with one Socratic question that leads \
them to the flaw themselves.\n\
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

    /// The pain point behind this: an early board got "you haven't done
    /// anything, go implement a solution" instead of a way in.
    #[test]
    fn the_review_prompt_asks_for_opening_hints_on_a_sparse_board() {
        assert!(REVIEW_SYSTEM_PROMPT.contains("opening hints"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("start coding"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("implement a solution"));
        assert!(REVIEW_SYSTEM_PROMPT.contains("problem-specific"));
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
