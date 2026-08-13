use anyhow::{bail, Context, Result};
use minijinja::{context, Environment};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::dataset::{self, Dataset};
use crate::problem::{IoCase, Problem};

const README_TMPL: &str = include_str!("../../templates/README.md.jinja");
const SOLUTION_TMPL: &str = include_str!("../../templates/solution.py.jinja");
/// Embedded test runner — also rewritten into existing workspaces on each run.
pub const RUN_TESTS_PY: &str = include_str!("../../templates/run_tests.py");

/// Everything the workspace (and later `lc test` / `lc ask`) needs, written to
/// `<workspace>/<task_id>/.lc/meta.json`. Built from `Problem`, which cannot
/// carry `completion`/`response`, so no solution text can end up here.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    /// Which corpus this workspace came from. Defaults to the original
    /// LeetCode dataset so `.lc/meta.json` files written before datasets
    /// existed keep loading.
    #[serde(default = "default_dataset_id")]
    pub dataset: String,
    pub task_id: String,
    pub question_id: Option<String>,
    pub difficulty: Option<String>,
    pub tags: Vec<String>,
    pub entry_point: Option<String>,
    pub json_path: String,
    pub cases: Vec<IoCase>,
    pub test: Option<String>,
}

fn default_dataset_id() -> String {
    dataset::DEFAULT_DATASET.to_string()
}

impl WorkspaceMeta {
    /// The dataset this workspace belongs to, falling back to the default
    /// corpus if the recorded slug is no longer known.
    pub fn dataset(&self) -> &'static Dataset {
        dataset::get(&self.dataset).unwrap_or_else(|_| dataset::default())
    }

    /// `dataset/task_id` — the key `session.json` uses.
    pub fn key(&self) -> String {
        self.dataset().key(&self.task_id)
    }
}

pub fn generate(
    cfg: &Config,
    dataset: &Dataset,
    problem: &Problem,
    json_path: &Path,
    force: bool,
) -> Result<PathBuf> {
    let dir = dataset.workspace_dir(cfg, &problem.task_id);
    fs::create_dir_all(dir.join(".lc"))
        .with_context(|| format!("cannot create workspace {}", dir.display()))?;

    let mut env = Environment::new();
    env.add_template("readme", README_TMPL)?;
    env.add_template("solution", SOLUTION_TMPL)?;

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

    let solution = solution_stub(problem);
    let solution_path = dir.join("solution.py");
    if !solution_path.exists() || force {
        fs::write(&solution_path, solution)?;
    }
    // Existing solution.py stays. Never print here: `eprintln!` on a closed
    // stderr pipe (Windows os error 232, common when `lc serve` is hosted
    // under Cursor) panics the spawn_blocking task, `/problems/:id/load`
    // returns 500, and reopening the same problem after returning to the
    // picker fails.

    fs::write(dir.join("run_tests.py"), RUN_TESTS_PY)?;

    let meta = WorkspaceMeta {
        dataset: dataset.id.to_string(),
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

/// The `solution.py` a fresh `lc load` writes.
///
/// Public because discarding an attempt resets the file to exactly this — see
/// [`crate::attempt::finish`]. Rendering it again beats remembering it: the
/// stub is derived from the corpus, and the corpus is what a re-attempt should
/// start from.
pub fn solution_stub(problem: &Problem) -> String {
    let mut env = Environment::new();
    // The template is embedded at compile time and its context is fixed, so a
    // render failure here is not something a caller could act on.
    env.add_template("solution", SOLUTION_TMPL)
        .expect("embedded solution template parses");
    env.get_template("solution")
        .expect("template was just added")
        .render(context! {
            task_id => problem.task_id,
            question_id => problem.question_id,
            difficulty => problem.difficulty,
            entry_point => problem.entry_point.clone().unwrap_or_else(|| "?".to_string()),
            code_body => code_body(problem),
        })
        .unwrap_or_else(|_| code_body(problem))
}

/// `prompt` usually holds imports/helpers and `starter_code` the class skeleton;
/// concatenate them, but don't duplicate the skeleton if `prompt` already ends with it.
///
/// Helper classes in `prompt` that the starter never mentions (common kitchen-sink
/// preambles with `ListNode` / `TreeNode` on array problems) are dropped.
pub fn code_body(problem: &Problem) -> String {
    let prompt = problem.prompt.as_deref().unwrap_or("").trim_end();
    let starter = problem.starter_code.as_deref().unwrap_or("").trim();
    if starter.is_empty() {
        return filter_unreferenced_helpers(prompt, "");
    }
    if prompt.is_empty() {
        return starter.to_string();
    }
    if prompt.contains(starter) {
        return filter_unreferenced_helpers(prompt, starter);
    }
    let helpers = filter_unreferenced_helpers(prompt, starter);
    if helpers.is_empty() {
        return starter.to_string();
    }
    format!("{helpers}\n\n\n{starter}")
}

/// Drop top-level `class` / `def` blocks from a Python preamble unless `starter`
/// (or another kept block) references their name.
fn filter_unreferenced_helpers(prompt: &str, starter: &str) -> String {
    if prompt.trim().is_empty() {
        return String::new();
    }
    let blocks = split_python_top_level(prompt);
    if blocks.iter().all(|b| b.name.is_none()) {
        return prompt.trim_end().to_string();
    }

    let mut keep: Vec<bool> = blocks
        .iter()
        .map(|b| match &b.name {
            None => true,
            // Always keep Solution — it is the problem skeleton.
            Some(name) if name == "Solution" => true,
            Some(name) => name_referenced(name, starter),
        })
        .collect();

    // Transitive references between helper blocks (e.g. a helper mentioning ListNode).
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..blocks.len() {
            if keep[i] {
                continue;
            }
            let Some(name) = blocks[i].name.as_deref() else {
                continue;
            };
            let referenced = keep.iter().enumerate().any(|(j, &kept)| {
                kept && name_referenced(name, &blocks[j].text)
            });
            if referenced {
                keep[i] = true;
                changed = true;
            }
        }
    }

    let mut out = String::new();
    for (block, &kept) in blocks.iter().zip(keep.iter()) {
        if !kept {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(block.text.trim_end());
    }
    out
}

struct PyBlock {
    /// `Some("ListNode")` for `class ListNode`, `Some("foo")` for top-level `def foo`.
    name: Option<String>,
    text: String,
}

fn split_python_top_level(src: &str) -> Vec<PyBlock> {
    let mut blocks = Vec::new();
    let mut cur_name: Option<String> = None;
    let mut cur = String::new();

    let flush = |blocks: &mut Vec<PyBlock>, name: &mut Option<String>, text: &mut String| {
        let trimmed = text.trim_end();
        if trimmed.is_empty() {
            text.clear();
            *name = None;
            return;
        }
        blocks.push(PyBlock {
            name: name.take(),
            text: trimmed.to_string(),
        });
        text.clear();
    };

    for line in src.lines() {
        let class_name = line
            .strip_prefix("class ")
            .and_then(|rest| rest.split([':', '(']).next())
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        let def_name = if line.starts_with("def ") {
            line.trim_start_matches("def ")
                .split('(')
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        } else {
            None
        };

        if class_name.is_some() || def_name.is_some() {
            flush(&mut blocks, &mut cur_name, &mut cur);
            cur_name = class_name.or(def_name).map(str::to_string);
            cur.push_str(line);
            cur.push('\n');
            continue;
        }

        cur.push_str(line);
        cur.push('\n');
    }
    flush(&mut blocks, &mut cur_name, &mut cur);
    blocks
}

fn name_referenced(name: &str, haystack: &str) -> bool {
    if haystack.is_empty() {
        return false;
    }
    // Word-boundary style check so `TreeNode` does not match `TreeNodeX`.
    let bytes = haystack.as_bytes();
    let needle = name.as_bytes();
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let before_ok = i == 0 || !is_ident_byte(bytes[i - 1]);
            let after = i + needle.len();
            let after_ok = after == bytes.len() || !is_ident_byte(bytes[after]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
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

#[cfg(test)]
mod code_body_tests {
    use super::code_body;
    use crate::problem::Problem;

    fn problem(prompt: &str, starter: &str) -> Problem {
        Problem {
            task_id: "demo".into(),
            question_id: None,
            difficulty: None,
            tags: vec![],
            problem_description: None,
            prompt: Some(prompt.into()),
            starter_code: Some(starter.into()),
            entry_point: None,
            test: None,
            input_output: vec![],
            estimated_date: None,
        }
    }

    #[test]
    fn drops_tree_helpers_on_array_starters() {
        let prompt = "\
from typing import List\n\
\n\
class ListNode:\n\
    def __init__(self, val=0, next=None):\n\
        self.val = val\n\
        self.next = next\n\
\n\
class TreeNode:\n\
    def __init__(self, val=0, left=None, right=None):\n\
        self.val = val\n\
        self.left = left\n\
        self.right = right\n";
        let starter = "class Solution:\n    def fourSumCount(self, nums1: List[int], nums2: List[int], nums3: List[int], nums4: List[int]) -> int:\n        pass\n";
        let body = code_body(&problem(prompt, starter));
        assert!(body.contains("from typing import List"));
        assert!(body.contains("class Solution"));
        assert!(body.contains("fourSumCount"));
        assert!(!body.contains("class ListNode"));
        assert!(!body.contains("class TreeNode"));
    }

    #[test]
    fn keeps_list_helpers_when_starter_mentions_them() {
        let prompt = "\
class ListNode:\n\
    def __init__(self, val=0, next=None):\n\
        self.val = val\n\
        self.next = next\n\
\n\
class TreeNode:\n\
    def __init__(self, val=0):\n\
        self.val = val\n";
        let starter =
            "class Solution:\n    def reverseList(self, head: ListNode) -> ListNode:\n        pass\n";
        let body = code_body(&problem(prompt, starter));
        assert!(body.contains("class ListNode"));
        assert!(body.contains("reverseList"));
        assert!(!body.contains("class TreeNode"));
    }
}

#[cfg(test)]
mod generate_tests {
    use super::generate;
    use crate::config::Config;
    use crate::dataset;
    use crate::problem::Problem;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn second_generate_leaves_existing_solution() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "lc-generate-reopen-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut cfg = Config::default();
        cfg.workspace.dir = root.display().to_string();
        let problem = Problem {
            task_id: "reopen-demo".into(),
            question_id: None,
            difficulty: None,
            tags: vec![],
            problem_description: Some("demo".into()),
            prompt: None,
            starter_code: Some("class Solution:\n    pass\n".into()),
            entry_point: None,
            test: None,
            input_output: vec![],
            estimated_date: None,
        };
        let json = root.join("reopen-demo.json");
        let dataset = dataset::default();
        let dir = generate(&cfg, dataset, &problem, &json, false).unwrap();
        fs::write(dir.join("solution.py"), "# keep me\n").unwrap();
        let again = generate(&cfg, dataset, &problem, &json, false).unwrap();
        assert_eq!(dir, again);
        assert_eq!(
            fs::read_to_string(again.join("solution.py")).unwrap(),
            "# keep me\n"
        );
        let _ = fs::remove_dir_all(&root);
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
        let _ = writeln!(
            std::io::stderr(),
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

/// Open a file in a blocking terminal editor (`$VISUAL` / `$EDITOR`, then nvim/vim/vi).
///
/// Callers that own a ratatui session must suspend the alternate screen first so
/// the child inherits a normal tty; see `tui::with_suspended_tui`.
pub fn open_in_terminal_editor(path: &Path) -> Result<()> {
    use std::process::{Command, Stdio};

    let path_str = path.display().to_string();
    let mut candidates: Vec<String> = Vec::new();
    for key in ["VISUAL", "EDITOR"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(trimmed.to_string());
            }
        }
    }
    for editor in ["nvim", "vim", "vi"] {
        candidates.push(editor.to_string());
    }
    #[cfg(windows)]
    candidates.push("notepad".to_string());

    let mut last_err = None;
    for editor in &candidates {
        // `$EDITOR` is usually a single binary; ignore args for simplicity.
        let bin = editor.split_whitespace().next().unwrap_or(editor);
        let mut cmd = Command::new(bin);
        cmd.arg(&path_str)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        match cmd.status() {
            Ok(_) => return Ok(()),
            Err(err) => last_err = Some(format!("{bin}: {err}")),
        }
    }
    bail!(
        "no terminal editor found (set $EDITOR or install vim/nvim){}",
        last_err
            .map(|e| format!(" — last error: {e}"))
            .unwrap_or_default()
    );
}

/// Open the workspace folder in the OS file manager (non-blocking).
pub fn open_workspace_folder(dir: &Path) {
    let _ = {
        #[cfg(windows)]
        {
            std::process::Command::new("explorer").arg(dir).spawn()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(dir).spawn()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(dir).spawn()
        }
    };
}
