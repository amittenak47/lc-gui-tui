use anyhow::{bail, Context, Result};
use colored::Colorize;
use comfy_table::Table;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "leetcode")]
use rustpython::{InterpreterBuilder, InterpreterBuilderExt};
#[cfg(feature = "leetcode")]
use std::time::Duration;

/// Default Windows/debug stack overflows inside `Interpreter::build()`.
#[cfg(feature = "leetcode")]
const RUSTPYTHON_STACK: usize = 32 * 1024 * 1024;
/// Give up waiting on the interpreter thread. The native thread cannot be
/// killed; a stuck run is abandoned rather than blocking the GUI forever.
#[cfg(feature = "leetcode")]
const RUN_JOIN_TIMEOUT: Duration = Duration::from_secs(60);

use crate::config::Config;
use crate::dataset::{self, Dataset};
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
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    Ok(Some(serde_json::from_str(&raw)?))
}

/// Plain-text report for the coach thread (TUI / daemon), mirroring the GUI
/// `formatTestReport` helper.
pub fn format_test_report(results: &[CaseResult], kind: &str) -> String {
    const MAX_REPORTED_FAILURES: usize = 5;
    let passed = results.iter().filter(|r| r.pass).count();
    let total = results.len();
    let header = format!(
        "{} - {passed}/{total} passed",
        if kind == "submit" {
            "Submit"
        } else {
            "Run tests"
        }
    );
    if total > 0 && passed == total {
        return format!("{header}\nAll cases passed.");
    }

    let failures: Vec<&CaseResult> = results.iter().filter(|r| !r.pass).collect();
    let shown: Vec<String> = failures
        .iter()
        .take(MAX_REPORTED_FAILURES)
        .map(|result| {
            let mut lines = vec![
                format!(
                    "{}: {}",
                    if result.suite {
                        "suite".to_string()
                    } else {
                        format!("case {}", result.case)
                    },
                    result.input
                ),
                format!("  expected: {}", result.expected),
            ];
            if let Some(actual) = &result.actual {
                lines.push(format!("  got:      {actual}"));
            }
            if let Some(error) = &result.error {
                let last = error
                    .trim_end()
                    .lines()
                    .last()
                    .unwrap_or("")
                    .trim();
                lines.push(format!("  error:    {last}"));
            }
            lines.join("\n")
        })
        .collect();

    let mut parts = vec![header];
    parts.push(shown.join("\n\n"));
    if failures.len() > shown.len() {
        parts.push(format!(
            "...and {} more failing cases.",
            failures.len() - shown.len()
        ));
    }
    parts.join("\n\n")
}

pub fn read_meta(dir: &Path) -> Result<WorkspaceMeta> {
    let path = dir.join(".lc").join("meta.json");
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("invalid meta {}", path.display()))
}

/// Keep `run_tests.py` on the embedded template so older workspaces pick up
/// entry-point cleaning without a full `lc load`.
fn refresh_runner_script(dir: &Path) -> Result<()> {
    std::fs::write(dir.join("run_tests.py"), crate::generator::RUN_TESTS_PY)
        .with_context(|| format!("cannot refresh run_tests.py in {}", dir.display()))
}

/// Rewrite `meta.json` when the corpus stored `Solution().foo` as the entry point.
fn sanitize_workspace_meta(dir: &Path, meta: &mut WorkspaceMeta) -> Result<()> {
    let Some(raw) = meta.entry_point.clone() else {
        return Ok(());
    };
    let cleaned = crate::datasets::clean_entry_point(&raw);
    if cleaned == raw {
        return Ok(());
    }
    meta.entry_point = if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    };
    let path = dir.join(".lc").join("meta.json");
    std::fs::write(&path, serde_json::to_string_pretty(meta)?)
        .with_context(|| format!("cannot update {}", path.display()))
}

/// Workspace dir for an explicit id in the default corpus, or the current
/// directory if it is one.
pub fn locate_workspace(cfg: &Config, id: Option<&str>) -> Result<PathBuf> {
    locate_workspace_in(cfg, dataset::default(), id)
}

/// Workspace dir for an explicit id within `dataset`, or the current directory.
pub fn locate_workspace_in(
    cfg: &Config,
    dataset: &'static Dataset,
    id: Option<&str>,
) -> Result<PathBuf> {
    if let Some(id) = id {
        let conn = index::open_db()?;
        let row = loader::resolve_in(&conn, dataset, id)?;
        let dir = dataset.workspace_dir(cfg, &row.task_id);
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

/// Run `run_tests.py` in-process via RustPython and parse JSONL stdout.
///
/// Isolated per call: new interpreter on a 32MB stack thread so student code
/// cannot poison the next run, and Windows debug does not overflow in
/// `Interpreter::build()`.
pub fn execute_run_tests(dir: &Path, extra_argv: &[&str]) -> Result<(Vec<CaseResult>, String, String)> {
    #[cfg(not(feature = "leetcode"))]
    {
        let _ = (dir, extra_argv);
        bail!("this build was compiled without the leetcode feature — no test runner")
    }
    #[cfg(feature = "leetcode")]
    {
        execute_run_tests_vm(dir, extra_argv)
    }
}

#[cfg(feature = "leetcode")]
fn driver_source(workdir: &Path, extra_argv: &[&str]) -> String {
    let here = workdir.to_string_lossy().replace('\\', "/");
    let extras = extra_argv
        .iter()
        .map(|s| format!(", {s:?}"))
        .collect::<String>();
    format!(
        r#"
import io, os, runpy, sys, traceback
HERE = r"{here}"
os.chdir(HERE)
sys.argv = ["run_tests.py"{extras}]
out, err = io.StringIO(), io.StringIO()
sys.stdout, sys.stderr = out, err
code = 0
try:
    runpy.run_path(os.path.join(HERE, "run_tests.py"), run_name="__main__")
except SystemExit as e:
    if isinstance(e.code, int):
        code = e.code
    elif e.code:
        code = 1
except Exception:
    err.write(traceback.format_exc())
    code = 1
open(os.path.join(HERE, "_rp_stdout.txt"), "w", encoding="utf-8").write(out.getvalue())
open(os.path.join(HERE, "_rp_stderr.txt"), "w", encoding="utf-8").write(err.getvalue())
open(os.path.join(HERE, "_rp_exit.txt"), "w", encoding="utf-8").write(str(code))
"#
    )
}

#[cfg(feature = "leetcode")]
fn execute_run_tests_vm(dir: &Path, extra_argv: &[&str]) -> Result<(Vec<CaseResult>, String, String)> {
    let driver = driver_source(dir, extra_argv);
    let dir = dir.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("rustpython".into())
        .stack_size(RUSTPYTHON_STACK)
        .spawn(move || {
            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
                let interp = InterpreterBuilder::new().init_stdlib().build();
                let fail = interp.enter(|vm| {
                    if let Err(exc) = vm.run_simple_string(&driver) {
                        let mut buf = String::new();
                        let _ = vm.write_exception_inner(&mut buf, &exc);
                        Some(buf)
                    } else {
                        None
                    }
                });
                if let Some(buf) = fail {
                    bail!("RustPython failed before the runner finished:\n{buf}");
                }
                Ok(())
            }));
            let _ = tx.send(caught);
        })
        .context("cannot spawn rustpython thread")?;
    let join = match rx.recv_timeout(RUN_JOIN_TIMEOUT) {
        Ok(caught) => caught,
        Err(_) => bail!(
            "RustPython timed out after {}s",
            RUN_JOIN_TIMEOUT.as_secs()
        ),
    }
    .map_err(|_| anyhow::anyhow!("rustpython thread panicked"))?;
    match join {
        Ok(()) => {}
        Err(err) => return Err(err),
    }

    let stdout = std::fs::read_to_string(dir.join("_rp_stdout.txt")).unwrap_or_default();
    let stderr = std::fs::read_to_string(dir.join("_rp_stderr.txt")).unwrap_or_default();
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
    Ok((results, stdout, stderr))
}

/// Run the workspace's tests. Returns true when every case passed.
pub fn cmd_test(
    cfg: &Config,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
    verbose: bool,
) -> Result<bool> {
    cmd_test_inner(cfg, dataset::default(), id, case, full, verbose, false)
}

/// [`cmd_test`] scoped to one dataset.
pub fn cmd_test_in(
    cfg: &Config,
    dataset: &'static Dataset,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
    verbose: bool,
) -> Result<bool> {
    cmd_test_inner(cfg, dataset, id, case, full, verbose, false)
}

pub fn cmd_test_quiet(
    cfg: &Config,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
) -> Result<bool> {
    cmd_test_inner(cfg, dataset::default(), id, case, full, false, true)
}

pub fn cmd_test_quiet_in(
    cfg: &Config,
    dataset: &'static Dataset,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
) -> Result<bool> {
    cmd_test_inner(cfg, dataset, id, case, full, false, true)
}

fn cmd_test_inner(
    cfg: &Config,
    dataset: &'static Dataset,
    id: Option<&str>,
    case: Option<u32>,
    full: bool,
    verbose: bool,
    quiet: bool,
) -> Result<bool> {
    let dir = locate_workspace_in(cfg, dataset, id)?;
    let mut meta = read_meta(&dir)?;
    // Workspaces may predate entry-point cleaning / runner fixes — refresh both.
    refresh_runner_script(&dir)?;
    sanitize_workspace_meta(&dir, &mut meta)?;

    let mut extra: Vec<String> = Vec::new();
    if let Some(n) = case {
        extra.push("--case".into());
        extra.push(n.to_string());
    }
    if full {
        extra.push("--full".into());
    }
    // Settings → Tests. Off by default, so the results panel and the coach's
    // counterexample picking both see every case.
    if cfg.tests.stop_on_first_failure {
        extra.push("--stop-on-first-failure".into());
    }
    let extra_refs: Vec<&str> = extra.iter().map(|s| s.as_str()).collect();
    let (results, stdout, stderr) = execute_run_tests(&dir, &extra_refs)?;
    if results.is_empty() {
        bail!("the test runner produced no results\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    if !quiet {
        render(&results, verbose);
    }
    save_last_run(&meta.task_id, &dir, &results)?;
    if let Ok(mut session) = crate::session::Session::load_or_new() {
        let passed = results.iter().filter(|r| r.pass).count() as u32;
        // Dataset-qualified, so a fail on `kodcode/two-sum` does not badge
        // `leetcode/two-sum` in the browser.
        let _ = session.mark_tested(&meta.key(), passed, results.len() as u32);
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
