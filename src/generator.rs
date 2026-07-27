use anyhow::{Context, Result};
use minijinja::{context, Environment};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::problem::{IoCase, Problem};

const README_TMPL: &str = include_str!("../templates/README.md.jinja");
const SOLUTION_TMPL: &str = include_str!("../templates/solution.py.jinja");
const RUN_TESTS_PY: &str = include_str!("../templates/run_tests.py");

/// Everything the workspace (and later `lc test` / `lc ask`) needs, written to
/// `<workspace>/<task_id>/.lc/meta.json`. Built from `Problem`, which cannot
/// carry `completion`/`response`, so no solution text can end up here.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub entry_point: Option<String>,
    pub json_path: String,
    pub cases: Vec<IoCase>,
    pub test: Option<String>,
}

pub fn generate(cfg: &Config, problem: &Problem, json_path: &Path, force: bool) -> Result<PathBuf> {
    let dir = cfg.workspace_dir().join(&problem.task_id);
    fs::create_dir_all(dir.join(".lc"))
        .with_context(|| format!("cannot create workspace {}", dir.display()))?;

    let mut env = Environment::new();
    env.add_template("readme", README_TMPL)?;
    env.add_template("solution", SOLUTION_TMPL)?;

    let entry_point = problem
        .entry_point
        .clone()
        .unwrap_or_else(|| "?".to_string());
    let examples: Vec<&IoCase> = problem.input_output.iter().take(3).collect();

    let readme = env.get_template("readme")?.render(context! {
        title => title_from_slug(&problem.task_id),
        task_id => problem.task_id,
        question_id => problem.question_id,
        difficulty => problem.difficulty,
        tags => problem.tags,
        description => problem.problem_description.as_deref().unwrap_or("(no description in the source JSON)"),
        examples => examples,
        total_cases => problem.input_output.len(),
    })?;
    fs::write(dir.join("README.md"), readme)?;

    let solution = env.get_template("solution")?.render(context! {
        task_id => problem.task_id,
        question_id => problem.question_id,
        difficulty => problem.difficulty,
        entry_point => entry_point,
        code_body => code_body(problem),
    })?;
    let solution_path = dir.join("solution.py");
    if !solution_path.exists() || force {
        fs::write(&solution_path, solution)?;
    } else {
        eprintln!("solution.py already exists — left untouched (pass --force to overwrite)");
    }

    fs::write(dir.join("run_tests.py"), RUN_TESTS_PY)?;

    let meta = WorkspaceMeta {
        task_id: problem.task_id.clone(),
        question_id: problem.question_id.clone(),
        difficulty: problem.difficulty.clone(),
        tags: problem.tags.clone(),
        entry_point: problem.entry_point.clone(),
        json_path: json_path.display().to_string(),
        cases: problem.input_output.clone(),
        test: problem.test.clone(),
    };
    fs::write(
        dir.join(".lc").join("meta.json"),
        serde_json::to_string_pretty(&meta)?,
    )?;

    Ok(dir)
}

/// `prompt` usually holds imports/helpers and `starter_code` the class skeleton;
/// concatenate them, but don't duplicate the skeleton if `prompt` already ends with it.
fn code_body(problem: &Problem) -> String {
    let prompt = problem.prompt.as_deref().unwrap_or("").trim_end();
    let starter = problem.starter_code.as_deref().unwrap_or("").trim();
    if starter.is_empty() {
        return prompt.to_string();
    }
    if prompt.contains(starter) {
        return prompt.to_string();
    }
    if prompt.is_empty() {
        return starter.to_string();
    }
    format!("{prompt}\n\n\n{starter}")
}

pub(crate) fn title_from_slug(slug: &str) -> String {
    slug.split('-')
        .filter(|word| !word.is_empty())
        .map(title_word)
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_word(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    if is_roman_segment(&lower) {
        return lower.to_ascii_uppercase();
    }
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// LeetCode slug tails like `-ii` / `-iii` should render as `II` / `III`.
fn is_roman_segment(word: &str) -> bool {
    matches!(
        word,
        "i" | "ii"
            | "iii"
            | "iv"
            | "v"
            | "vi"
            | "vii"
            | "viii"
            | "ix"
            | "x"
            | "xi"
            | "xii"
            | "xiii"
            | "xiv"
            | "xv"
            | "xvi"
            | "xvii"
            | "xviii"
            | "xix"
            | "xx"
    )
}

#[cfg(test)]
mod title_tests {
    use super::title_from_slug;

    #[test]
    fn roman_numeral_tails_are_fully_uppercased() {
        assert_eq!(
            title_from_slug("longest-uncommon-subsequence-ii"),
            "Longest Uncommon Subsequence II"
        );
        assert_eq!(
            title_from_slug("house-robber-iii"),
            "House Robber III"
        );
        assert_eq!(title_from_slug("n-queens-ii"), "N Queens II");
    }

    #[test]
    fn ordinary_words_stay_title_case() {
        assert_eq!(title_from_slug("two-sum"), "Two Sum");
        assert_eq!(
            title_from_slug("1-bit-and-2-bit-characters"),
            "1 Bit And 2 Bit Characters"
        );
    }
}

/// Open `solution.py` in the current Cursor/VS Code window (`-r` / `--reuse-window`).
pub fn open_in_editor(dir: &Path) {
    open_in_editor_impl(dir, false);
}

/// Same as [`open_in_editor`] but without stdout messages (for TUI).
pub fn open_in_editor_quiet(dir: &Path) {
    open_in_editor_impl(dir, true);
}

fn open_in_editor_impl(dir: &Path, quiet: bool) {
    let target = dir.join("solution.py");
    let target = if target.is_file() {
        target
    } else {
        dir.to_path_buf()
    };
    let path = target.display().to_string();

    let editors = ["cursor", "code"];
    for editor in editors {
        if launch_editor(editor, &path) {
            if !quiet {
                println!("Opened in {editor} (reuse window).");
            }
            return;
        }
    }

    if !quiet {
        eprintln!(
            "Could not launch cursor/code — open manually: {}",
            target.display()
        );
    }
}

fn launch_editor(editor: &str, path: &str) -> bool {
    let status = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", editor, "-r", path])
            .status()
    } else {
        std::process::Command::new(editor).args(["-r", path]).status()
    };
    matches!(status, Ok(s) if s.success())
}
