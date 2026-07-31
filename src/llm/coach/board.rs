use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::llm::helpers::clip;

use crate::llm::helpers::{MAX_BOARD, MAX_STRUCTURE};

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

    pub(super) fn write_into(&self, out: &mut String) {
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
pub(super) fn render_structure_by_region(structure: &serde_json::Value) -> String {
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
