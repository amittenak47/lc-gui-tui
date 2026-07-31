use crate::generator::WorkspaceMeta;
use crate::llm::helpers::clip;

const MAX_DESCRIPTION: usize = 4000;

/// User prompt for problem-specific board region scaffolding.
pub fn build_scaffold_prompt(meta: &WorkspaceMeta, description: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("# Problem\n");
    out.push_str(&format!("task_id: {}\n", meta.task_id));
    if let Some(q) = &meta.question_id {
        out.push_str(&format!("question_id: {q}\n"));
    }
    if let Some(d) = &meta.difficulty {
        out.push_str(&format!("difficulty: {d}\n"));
    }
    if !meta.tags.is_empty() {
        out.push_str(&format!("tags: {}\n", meta.tags.join(", ")));
    }
    if let Some(desc) = description {
        out.push_str("\n## Statement\n\n");
        out.push_str(&clip(desc, MAX_DESCRIPTION));
        out.push('\n');
    }
    out.push_str(
        "\n## Task\n\n\
Write short scaffolding prompts for three whiteboard regions. Return JSON only:\n\
{\"approach\":\"...\",\"complexity\":\"...\",\"walkthrough\":\"...\"}\n",
    );
    out
}
