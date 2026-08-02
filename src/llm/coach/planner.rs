//! One structured call that catalogs the approaches a problem admits.
//!
//! The rest of the coach runs on whatever model the user has locally, and a 7B
//! model is good at the staged work — describe this board, does this claim
//! decide the answer, does this code match that claim — because each stage is
//! small and grounded in something concrete. What it is *not* good at is the
//! question that needs breadth: which families of solution does this problem
//! admit, and what does each cost?
//!
//! So that question gets asked once, of whichever model the user points
//! `llm.modes.planner` at, and the answer is cached for the task. Everything
//! downstream stays local.
//!
//! Two invariants, both enforced by what this module can reach rather than by
//! asking the model nicely:
//!
//! - **No solution.** The planner is built from [`WorkspaceMeta`], the problem
//!   statement, and the sample cases — the same redacted sources `lc ask` uses.
//!   The corpus's reference answer is unreachable from this module, and a test
//!   in `serve::coach` asserts it stays that way.
//! - **Families, not answers.** A catalog entry names an approach and says when
//!   it is the right one. [`parse_plan`] drops entries that arrive as code.

use std::fmt::Write as _;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::generator::WorkspaceMeta;
use crate::llm::helpers::{clip, parse_reply, write_cases, write_problem_header};

use super::approach::ApproachCandidate;

pub const PLANNER_SYSTEM_PROMPT: &str = "\
You are planning how a coach should think about one programming problem. You are not \
solving it, and the student will never see your output — it is context for a smaller \
model that coaches them through their own attempt.

Name the FAMILIES of approach the problem admits: \"two pointers on a sorted array\", \
\"hash map of complements\", \"binary search on the answer\". Two or three is usually \
right; more than four means you are listing variations, not families.

Rules:
- Never write solution code, pseudocode, or a line-by-line algorithm. `sketch_steps` \
  is the SHAPE of an approach — three or four phrases a student could have drawn.
- Include the approach a beginner would reach for first, even when it is too slow. \
  Students draw it, and a coach that has never heard of it reads their board as a \
  mistake instead of a starting point.
- `weaknesses` is what the approach costs, not whether it is 'wrong'. Several of \
  these will be correct.
- Return only JSON.";

/// What the drawing model should reach for on this problem.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct VizPlan {
    /// Tool names worth calling — `draw_structure`, `animate_trace`, …
    pub recommended_tools: Vec<String>,
    /// Structure kind the diagrams should use ("array", "tree", …).
    pub viz: String,
    /// The frames a trace would want, named.
    pub frames_outline: Vec<String>,
}

impl VizPlan {
    pub fn is_empty(&self) -> bool {
        self.recommended_tools.is_empty() && self.viz.trim().is_empty()
            && self.frames_outline.is_empty()
    }
}

/// The planner's whole answer for one task.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ApproachPlan {
    pub problem_restatement: String,
    pub candidate_approaches: Vec<ApproachCandidate>,
    pub viz_plan: VizPlan,
    /// Standing instructions for the local coach — e.g. not to flip approaches.
    pub coaching_cautions: Vec<String>,
}

/// How many families are worth carrying. Past this the catalog stops being a
/// shortlist and starts being a menu the coach browses mid-session.
const MAX_APPROACHES: usize = 4;
const MAX_FIELD: usize = 400;
const MAX_LIST_ITEM: usize = 200;
const MAX_LIST: usize = 5;

/// Markers that a "sketch step" is actually code. A catalog entry carrying an
/// implementation is exactly the leak the redaction rules exist to prevent, and
/// the cheapest place to catch it is on the way in.
const CODE_MARKERS: [&str; 8] = ["def ", "return ", "for (", "while (", "```", "();", "->", "=="];

fn looks_like_code(text: &str) -> bool {
    CODE_MARKERS.iter().any(|marker| text.contains(marker))
}

pub fn build_planner_prompt(meta: &WorkspaceMeta, description: Option<&str>) -> String {
    let mut out = String::new();
    write_problem_header(&mut out, meta, description);
    write_cases(&mut out, &meta.cases);
    let _ = writeln!(
        out,
        "\n## Your reply\n\n\
         Return exactly this JSON shape:\n\n\
         ```json\n\
         {{\n  \
           \"problem_restatement\": \"one sentence — what is actually being asked\",\n  \
           \"candidate_approaches\": [\n    \
             {{\n      \
               \"id\": \"A\",\n      \
               \"name\": \"short name for the family\",\n      \
               \"when_to_use\": \"the condition that makes this the right one\",\n      \
               \"strengths\": [\"...\"],\n      \
               \"weaknesses\": [\"what it costs — time, space, or a case it handles badly\"],\n      \
               \"sketch_steps\": [\"the shape of it, three or four phrases, no code\"]\n    \
             }}\n  \
           ],\n  \
           \"viz_plan\": {{\n    \
             \"recommended_tools\": [\"draw_structure\", \"animate_trace\"],\n    \
             \"viz\": \"array | tree | graph | grid | stack | queue | linked_list\",\n    \
             \"frames_outline\": [\"what each frame of a trace would show\"]\n  \
           }},\n  \
           \"coaching_cautions\": [\"what a coach should avoid doing on this problem\"]\n\
         }}\n\
         ```"
    );
    out
}

pub fn parse_plan(raw: &str) -> Result<ApproachPlan> {
    let mut plan: ApproachPlan = parse_reply(raw, "plan")?;
    plan.problem_restatement = clip(plan.problem_restatement.trim(), MAX_FIELD);
    tidy(&mut plan.coaching_cautions);
    tidy(&mut plan.viz_plan.recommended_tools);
    tidy(&mut plan.viz_plan.frames_outline);
    plan.viz_plan.viz = plan.viz_plan.viz.trim().to_ascii_lowercase();

    for (index, entry) in plan.candidate_approaches.iter_mut().enumerate() {
        entry.name = clip(entry.name.trim(), MAX_FIELD);
        entry.when_to_use = clip(entry.when_to_use.trim(), MAX_FIELD);
        tidy(&mut entry.strengths);
        tidy(&mut entry.weaknesses);
        tidy(&mut entry.sketch_steps);
        // A step that arrived as code is dropped, not cleaned up: half a
        // solution is still a solution reaching a student who did not ask.
        entry.sketch_steps.retain(|step| !looks_like_code(step));
        if entry.id.trim().is_empty() {
            // Ids are how a claim refers back to a family, so every entry needs
            // one whether or not the model bothered.
            entry.id = char::from(b'A' + (index as u8).min(25)).to_string();
        } else {
            entry.id = clip(entry.id.trim(), 8);
        }
    }
    plan.candidate_approaches
        .retain(|entry| !entry.name.is_empty());
    plan.candidate_approaches.truncate(MAX_APPROACHES);

    if plan.candidate_approaches.is_empty() {
        anyhow::bail!("the planner named no approaches");
    }
    Ok(plan)
}

fn tidy(list: &mut Vec<String>) {
    list.retain(|item| !item.trim().is_empty());
    for item in list.iter_mut() {
        *item = clip(item.trim(), MAX_LIST_ITEM);
    }
    list.truncate(MAX_LIST);
}

/// The catalog, as the claim stage sees it.
///
/// Deliberately framed as "families that are known to work", not as options to
/// choose between: the claim stage's job is to read the board, and a list of
/// approaches is only there so it can *recognize* one, never so it can pick a
/// nicer one than the student drew.
pub fn write_catalog(out: &mut String, catalog: &[ApproachCandidate]) {
    if catalog.is_empty() {
        return;
    }
    let _ = writeln!(
        out,
        "\n## Approach families that are known to work on this problem"
    );
    let _ = writeln!(
        out,
        "\nReference only. The student's board may argue for one of these, or for \
         something not listed — both are fine. Do not prefer an approach because it \
         appears here, and do not tell the student about this list."
    );
    for entry in catalog {
        let _ = writeln!(out, "\n- **{}** ({})", entry.name, entry.id);
        if !entry.when_to_use.is_empty() {
            let _ = writeln!(out, "  - fits when: {}", entry.when_to_use);
        }
        for weakness in &entry.weaknesses {
            let _ = writeln!(out, "  - costs: {weakness}");
        }
    }
}

/// The drawing hints, for the viz prompt.
pub fn write_viz_plan(out: &mut String, plan: &VizPlan) {
    if plan.is_empty() {
        return;
    }
    let _ = writeln!(out, "\n## Suggested diagram");
    if !plan.viz.is_empty() {
        let _ = writeln!(out, "\n- structure: {}", plan.viz);
    }
    if !plan.recommended_tools.is_empty() {
        let _ = writeln!(out, "- tools worth calling: {}", plan.recommended_tools.join(", "));
    }
    if !plan.frames_outline.is_empty() {
        let _ = writeln!(out, "- a trace would want these frames:");
        for frame in &plan.frames_outline {
            let _ = writeln!(out, "  - {frame}");
        }
    }
    let _ = writeln!(
        out,
        "\nThese are hints, not a specification — draw what would actually help."
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::problem::IoCase;

    fn meta() -> WorkspaceMeta {
        WorkspaceMeta {
            dataset: crate::dataset::DEFAULT_DATASET.into(),
            task_id: "two-sum".into(),
            question_id: Some("1".into()),
            difficulty: Some("Easy".into()),
            tags: vec!["Array".into()],
            entry_point: Some("twoSum".into()),
            json_path: "corpus.jsonl".into(),
            cases: vec![IoCase {
                input: "nums = [2,7,11,15], target = 9".into(),
                output: "[0,1]".into(),
            }],
            test: None,
        }
    }

    /// The invariant that matters most here: a catalog entry is the shape of an
    /// idea. An entry that arrives as code loses the code, not the entry — the
    /// family is still worth knowing about.
    #[test]
    fn a_sketch_step_that_is_really_code_is_dropped() {
        let plan = parse_plan(
            r#"{
                "problem_restatement": "find two indices summing to the target",
                "candidate_approaches": [{
                    "id": "A",
                    "name": "hash map of complements",
                    "sketch_steps": [
                        "walk the array once",
                        "def two_sum(nums, target):",
                        "look up target minus this value",
                        "return [seen[rest], i]"
                    ]
                }]
            }"#,
        )
        .unwrap();
        assert_eq!(
            plan.candidate_approaches[0].sketch_steps,
            vec!["walk the array once", "look up target minus this value"],
            "the shape survives; the implementation does not"
        );
    }

    #[test]
    fn entries_get_ids_and_the_catalog_stays_a_shortlist() {
        let many: Vec<String> = (0..8)
            .map(|i| format!(r#"{{"name": "approach {i}"}}"#))
            .collect();
        let plan = parse_plan(&format!(
            r#"{{"candidate_approaches": [{}]}}"#,
            many.join(", ")
        ))
        .unwrap();
        assert_eq!(plan.candidate_approaches.len(), MAX_APPROACHES);
        assert_eq!(
            plan.candidate_approaches
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "B", "C", "D"],
            "a claim refers back by id, so every entry needs one"
        );
    }

    #[test]
    fn a_plan_with_no_approaches_is_not_a_plan() {
        assert!(parse_plan(r#"{"problem_restatement": "add two numbers"}"#).is_err());
        assert!(parse_plan(r#"{"candidate_approaches": [{"name": "   "}]}"#).is_err());
    }

    /// The catalog is reference material for reading a board, and the prompt has
    /// to say so — otherwise the claim stage starts recommending from the list.
    #[test]
    fn the_catalog_block_forbids_preferring_a_listed_approach() {
        let mut out = String::new();
        write_catalog(
            &mut out,
            &[ApproachCandidate {
                id: "A".into(),
                name: "two pointers on a sorted array".into(),
                when_to_use: "when sorting is affordable".into(),
                weaknesses: vec!["loses the original indices".into()],
                ..Default::default()
            }],
        );
        assert!(out.contains("two pointers on a sorted array"));
        assert!(out.contains("fits when: when sorting is affordable"));
        assert!(out.contains("costs: loses the original indices"));
        assert!(out.contains("Do not prefer an approach because it"));
        assert!(out.contains("do not tell the student about this list"));

        // Nothing catalogued writes nothing at all — no empty heading.
        let mut empty = String::new();
        write_catalog(&mut empty, &[]);
        assert!(empty.is_empty());
    }

    #[test]
    fn the_planner_prompt_carries_the_problem_and_forbids_solutions() {
        let prompt = build_planner_prompt(&meta(), Some("Return indices of two numbers."));
        assert!(prompt.contains("Return indices of two numbers."));
        assert!(prompt.contains("nums = [2,7,11,15], target = 9"));
        assert!(PLANNER_SYSTEM_PROMPT.contains("Never write solution code"));
        assert!(
            PLANNER_SYSTEM_PROMPT.contains("too slow"),
            "a coach that has never heard of brute force misreads a beginner's board"
        );
    }

    #[test]
    fn an_empty_viz_plan_writes_nothing() {
        let mut out = String::new();
        write_viz_plan(&mut out, &VizPlan::default());
        assert!(out.is_empty());

        write_viz_plan(
            &mut out,
            &VizPlan {
                recommended_tools: vec!["animate_trace".into()],
                viz: "array".into(),
                frames_outline: vec!["init".into(), "found".into()],
            },
        );
        assert!(out.contains("structure: array"));
        assert!(out.contains("animate_trace"));
        assert!(out.contains("- init"));
        assert!(out.contains("hints, not a specification"));
    }
}
