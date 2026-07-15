use anyhow::{bail, Context, Result};
use colored::Colorize;
use comfy_table::Table;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::generator::WorkspaceMeta;
use crate::{index, loader};

/// One line of JSON emitted by run_tests.py.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseResult {
    pub case: u32,
    #[serde(default)]
    pub pass: bool,
    #[serde(default)]
    pub input: String,
    #[serde(default)]
    pub expected: String,
    #[serde(default)]
    pub actual: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub suite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LastRun {
    pub task_id: String,
    pub workspace_dir: String,
    pub timestamp: u64,
    pub results: Vec<CaseResult>,
}

pub fn last_run_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("last_run.json"))
}

pub fn load_last_run() -> Result<Option<LastRun>> {
    let path = last_run_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&raw).ok())
}

pub fn read_meta(dir: &Path) -> Result<WorkspaceMeta> {
    let path = dir.join(".lc").join("meta.json");
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("invalid meta {}", path.display()))
}

/// Workspace dir for an explicit id, or the current directory if it is one.
pub fn locate_workspace(cfg: &Config, id: Option<&str>) -> Result<PathBuf> {
    if let Some(id) = id {
        let conn = index::open_db()?;
        let row = loader::resolve(&conn, id)?;
        let dir = cfg.workspace_dir().join(&row.task_id);
        if !dir.join(".lc").join("meta.json").exists() {
            bail!(
                "no workspace for {} yet — run `lc load {}` first",
                row.task_id,
                row.task_id
            );
        }
        Ok(dir)
    } else {
        let cwd = std::env::current_dir()?;
        if cwd.join(".lc").join("meta.json").exists() {
            Ok(cwd)
        } else {
            bail!(
                "the current directory is not an lc workspace (no .lc/meta.json) — \
                 cd into one or pass a task id"
            )
        }
    }
}

/// Run the workspace's tests. Returns true when every case passed.
pub fn cmd_test(
    cfg: &Config,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
    verbose: bool,
) -> Result<bool> {
    cmd_test_inner(cfg, id, case, full, verbose, false)
}

pub fn cmd_test_quiet(
    cfg: &Config,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
) -> Result<bool> {
    cmd_test_inner(cfg, id, case, full, false, true)
}

fn cmd_test_inner(
    cfg: &Config,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
    verbose: bool,
    quiet: bool,
) -> Result<bool> {
    let dir = locate_workspace(cfg, id)?;
    let meta = read_meta(&dir)?;

    let mut cmd = Command::new(&cfg.python.executable);
    cmd.arg("run_tests.py").current_dir(&dir);
    if let Some(n) = case {
        cmd.args(["--case", &n.to_string()]);
    }
    if full {
        cmd.arg("--full");
    }
    let output = cmd.output().with_context(|| {
        format!(
            "failed to launch {:?} — if Python lives elsewhere, run \
             `lc config set python <path-to-python>`",
            cfg.python.executable
        )
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results: Vec<CaseResult> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(result) = serde_json::from_str::<CaseResult>(line) {
            results.push(result);
        }
    }
    if results.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("the test runner produced no results\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    if !quiet {
        render(&results, verbose);
    }
    save_last_run(&meta.task_id, &dir, &results)?;
    if let Ok(mut session) = crate::session::Session::load_or_new() {
        let passed = results.iter().filter(|r| r.pass).count() as u32;
        let _ = session.mark_tested(&meta.task_id, passed, results.len() as u32);
    }
    Ok(results.iter().all(|r| r.pass))
}

fn save_last_run(task_id: &str, dir: &Path, results: &[CaseResult]) -> Result<()> {
    let run = LastRun {
        task_id: task_id.to_string(),
        workspace_dir: dir.display().to_string(),
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        results: results.to_vec(),
    };
    let path = last_run_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&run)?)?;
    Ok(())
}

fn render(results: &[CaseResult], verbose: bool) {
    let mut table = Table::new();
    table.load_preset(comfy_table::presets::UTF8_FULL_CONDENSED);
    table.set_header(["Case", "Result", "Input", "Expected", "Actual"]);
    for r in results {
        let status = if r.pass {
            "PASS".green().to_string()
        } else {
            "FAIL".red().to_string()
        };
        let actual = match (&r.actual, &r.error) {
            (_, Some(err)) => format!("error: {}", last_line(err)),
            (Some(a), None) => a.clone(),
            (None, None) => String::new(),
        };
        let label = if r.suite {
            "suite".to_string()
        } else {
            r.case.to_string()
        };
        table.add_row([
            label,
            status,
            trunc(&r.input, 40),
            trunc(&r.expected, 24),
            trunc(&actual, 36),
        ]);
    }
    println!("{table}");

    let passed = results.iter().filter(|r| r.pass).count();
    let total = results.len();
    let summary = format!("{passed}/{total} passed");
    println!(
        "{}",
        if passed == total {
            summary.green()
        } else {
            summary.red()
        }
    );

    let any_failed = passed != total;
    if verbose {
        for r in results.iter().filter(|r| !r.pass) {
            println!("\n{} case {}", "──".dimmed(), r.case);
            println!("input:    {}", r.input);
            println!("expected: {}", r.expected);
            if let Some(a) = &r.actual {
                println!("actual:   {a}");
            }
            if let Some(e) = &r.error {
                println!("{}", e.trim_end());
            }
            if let Some(o) = &r.stdout {
                if !o.trim().is_empty() {
                    println!("stdout:\n{o}");
                }
            }
        }
    } else if any_failed {
        println!("Re-run with --verbose for tracebacks, or `lc ask --case N` for help.");
    }
}

fn last_line(text: &str) -> String {
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn trunc(text: &str, max: usize) -> String {
    let flat = text.replace('\n', " ");
    if flat.chars().count() <= max {
        flat
    } else {
        let head: String = flat.chars().take(max).collect();
        format!("{head}…")
    }
}
