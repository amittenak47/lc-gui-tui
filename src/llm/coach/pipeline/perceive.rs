use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::parse_reply;

use super::super::board::BoardSnapshot;
use super::{board_without_code, tidy_list};

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

