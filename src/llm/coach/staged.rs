use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::prompt::clip;
use crate::llm::{ChatMessage, ChatRequest, LlmProvider};

use super::board::BoardSnapshot;
use super::review::{
    build_review_prompt, merge_layout_and_code_reviews, parse_review, Rating, ReviewResponse,
    Verdict, REVIEW_SYSTEM_PROMPT,
};
use super::shared::{parse_reply, write_cases, write_problem_header, MAX_BOARD};
use super::trace::retrace_counterexample;

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

pub(super) fn tidy_list(list: &mut Vec<String>) {
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


/// The board as the staged path reads it: ink, layout, and canvas notes, with
/// the code dock stripped. Every stage before the code pass gets this, so a
/// stubby `solution.py` cannot seed the claim it is later judged against.
pub(super) fn board_without_code(board: &BoardSnapshot) -> BoardSnapshot {
    let mut stripped = board.clone();
    stripped.pseudocode = None;
    stripped.pseudocode_delta = None;
    stripped.code_mode = None;
    stripped
}

pub(super) fn write_perception(out: &mut String, perception: Option<&Perception>) {
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
pub(super) fn write_claim(out: &mut String, claim: &Claim) {
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
