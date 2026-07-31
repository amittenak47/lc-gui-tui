use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;
use crate::problem::IoCase;

use super::board::BoardSnapshot;
use crate::llm::helpers::{write_cases, write_problem_header};

// ---------------------------------------------------------------------------
// Mode D — diagrams and animations, via tool calls
// ---------------------------------------------------------------------------


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
