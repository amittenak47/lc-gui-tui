use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use colored::Colorize;
use comfy_table::Table;
use std::path::{Path, PathBuf};

// The CLI and `whiteboard serve` are both shells over the same library crate.
use whiteboard::{
    config, dataset, generator, index, lists, llm, loader, problem, runner, serve, session, stats,
    tui,
};

use config::Config;
use index::{ProblemRow, SearchSort};
use runner::CaseResult;
use session::Session;

#[derive(Parser)]
#[command(
    name = "whiteboard",
    version,
    about = "LeetCode practice harness: index a local JSON corpus, load problems into a Python workspace, run tests, and ask an LLM tutor (which never sees reference solutions)."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Interactive practice session (default when no subcommand is given)
    #[command(name = "tui")]
    Tui,
    /// Session progress for the current practice run
    Stats {
        /// Show corpus-wide totals instead of the active session scope
        #[arg(long)]
        corpus: bool,
    },
    /// Reset the current practice session counters
    Session {
        #[command(subcommand)]
        cmd: SessionCmd,
    },
    /// Get or set configuration values
    #[command(subcommand)]
    Config(ConfigCmd),
    /// Build or update the SQLite index of the JSON problem corpus
    Index {
        /// Drop everything and re-index from scratch
        #[arg(long)]
        rebuild: bool,
        /// Index only this problem set (default: every dataset with a corpus folder)
        #[arg(long)]
        dataset: Option<String>,
    },
    /// List the problem sets and how many problems each has indexed
    Datasets {
        /// Report what each corpus file really contains and what the adapter
        /// made of it — the columns, which fields came out empty, and which
        /// columns nothing reads. Use it when a column in the browser is blank.
        #[arg(long)]
        inspect: bool,
        /// Inspect one problem set instead of all of them
        #[arg(long)]
        dataset: Option<String>,
    },
    /// Search indexed problems
    Search {
        /// Problem set to search (default: leetcode)
        #[arg(long)]
        dataset: Option<String>,
        /// Filter by difficulty (Easy / Medium / Hard)
        #[arg(long)]
        difficulty: Option<String>,
        /// Filter by tag (e.g. "Graph", "Dynamic Programming")
        #[arg(long)]
        tag: Option<String>,
        /// Substring match on the task_id slug
        #[arg(short, long)]
        query: Option<String>,
        #[arg(long, default_value_t = 25)]
        limit: u32,
        /// Sort key: task_id, question, difficulty, cases, tags
        #[arg(long, default_value = "task_id")]
        sort: String,
    },
    /// Pick random problem(s), optionally filtered
    Random {
        #[arg(long)]
        dataset: Option<String>,
        #[arg(short = 'n', long = "count", default_value_t = 1)]
        count: u32,
        #[arg(long)]
        difficulty: Option<String>,
        #[arg(long)]
        tag: Option<String>,
    },
    /// Materialize a problem into the workspace (README.md, solution.py, run_tests.py)
    Load {
        /// task_id slug, LeetCode question id, or unique slug prefix
        id: String,
        /// Problem set the id belongs to (default: leetcode)
        #[arg(long)]
        dataset: Option<String>,
        /// Open the generated folder in Cursor
        #[arg(long)]
        open: bool,
        /// Overwrite an existing solution.py (your edits are otherwise preserved)
        #[arg(long)]
        force: bool,
    },
    /// Run the Python test suite for a problem
    Test {
        /// task_id / question id; defaults to the workspace in the current directory
        id: Option<String>,
        /// Problem set the id belongs to (default: leetcode)
        #[arg(long)]
        dataset: Option<String>,
        /// Run a single case (1-indexed)
        #[arg(long)]
        case: Option<u32>,
        /// Run the original full assert suite instead of per-case checks
        #[arg(long)]
        full: bool,
        /// Show full tracebacks and captured stdout for failures
        #[arg(short, long)]
        verbose: bool,
    },
    /// Ask an LLM tutor about failing test cases (reference solutions are never sent)
    Ask {
        /// task_id / question id; defaults to the workspace in the current directory
        id: Option<String>,
        /// Ask about one specific case from the last `lc test` run
        #[arg(long)]
        case: Option<u32>,
        /// Override the configured provider: local | groq
        #[arg(long)]
        provider: Option<String>,
        /// Copy the redacted prompt to the clipboard instead of calling an API
        #[arg(long)]
        clipboard: bool,
    },
    /// Run the daemon the whiteboard coach client talks to
    Serve {
        /// Port to listen on (defaults to the `serve.port` config value)
        #[arg(long)]
        port: Option<u16>,
        /// Bind all interfaces so a tablet on the LAN can connect. Requires a
        /// pairing token, printed as a QR code on first use.
        #[arg(long)]
        lan: bool,
    },
    /// Manage named problem lists
    #[command(subcommand)]
    List(ListCmd),
    /// (not implemented in v1) Submit to leetcode.com
    Submit,
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// Set a value. Keys: data-dir, workspace, python, llm.provider,
    /// llm.local.base_url, llm.local.model, llm.groq.model,
    /// llm.modes.{ambient,review,bridge,viz}, serve.port, serve.token
    Set { key: String, value: String },
    /// Print one value
    Get { key: String },
    /// Print the whole config as TOML
    Show,
    /// Print the config file path
    Path,
}

#[derive(Subcommand)]
enum ListCmd {
    /// Create an empty list
    Create { name: String },
    /// Delete a list and its items
    Delete { name: String },
    /// Add problems (by slug, question id, or unique prefix)
    Add { name: String, ids: Vec<String> },
    /// Remove problems from a list
    Remove { name: String, ids: Vec<String> },
    /// Show a list's problems in order
    Show { name: String },
    /// Randomize a list's order
    Shuffle { name: String },
    /// Export a list as JSON ({"name": ..., "task_ids": [...]})
    Export {
        name: String,
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Import a list from a JSON export
    Import { file: PathBuf },
    /// Show all lists
    Ls,
    /// Breakdown for a named list (optionally merged with session progress)
    Stats { name: String },
}

#[derive(Subcommand)]
enum SessionCmd {
    /// Clear session progress and start fresh
    Reset,
}

fn main() {
    #[cfg(windows)]
    let _ = colored::control::set_virtual_terminal(true);

    let cli = Cli::parse();
    if let Err(err) = run(cli) {
        eprintln!("{} {err:#}", "error:".red());
        std::process::exit(2);
    }
}

fn run(cli: Cli) -> Result<()> {
    let cfg = Config::load()?;
    match cli.cmd {
        None | Some(Cmd::Tui) => tui::run(&cfg),
        Some(cmd) => run_cmd(cmd),
    }
}

fn run_cmd(cmd: Cmd) -> Result<()> {
    match cmd {
        Cmd::Tui => {
            let cfg = Config::load()?;
            tui::run(&cfg)
        }
        Cmd::Stats { corpus } => {
            let conn = index::open_db()?;
            if corpus {
                stats::corpus(&conn)
            } else {
                let session = Session::load_or_new()?;
                stats::session(&conn, &session)
            }
        }
        Cmd::Session { cmd } => match cmd {
            SessionCmd::Reset => {
                Session::reset()?;
                println!("session reset");
                Ok(())
            }
        },
        Cmd::Config(cmd) => cmd_config(cmd),
        Cmd::Index { rebuild, dataset } => {
            let cfg = Config::load()?;
            let only = match dataset.as_deref() {
                Some(slug) => Some(dataset::get(slug)?),
                None => None,
            };
            index::cmd_index(&cfg, rebuild, only)
        }
        Cmd::Datasets {
            inspect,
            dataset: dataset_id,
        } => {
            let cfg = Config::load()?;
            if inspect {
                return inspect_datasets(&cfg, dataset_id.as_deref());
            }
            let conn = index::open_db()?;
            print_datasets(&index::dataset_infos(&conn, &cfg)?);
            Ok(())
        }
        Cmd::Search {
            dataset: dataset_id,
            difficulty,
            tag,
            query,
            limit,
            sort,
        } => {
            let sort = parse_sort(&sort)?;
            let conn = index::open_db()?;
            let rows = index::search(
                &conn,
                dataset::resolve(dataset_id.as_deref())?,
                difficulty.as_deref(),
                tag.as_deref(),
                query.as_deref(),
                limit,
                false,
                sort,
            )?;
            print_problem_rows(&rows);
            Ok(())
        }
        Cmd::Random {
            dataset: dataset_id,
            count,
            difficulty,
            tag,
        } => {
            let conn = index::open_db()?;
            let rows = index::search(
                &conn,
                dataset::resolve(dataset_id.as_deref())?,
                difficulty.as_deref(),
                tag.as_deref(),
                None,
                count,
                true,
                SearchSort::TaskId,
            )?;
            print_problem_rows(&rows);
            if let Some(first) = rows.first() {
                println!("\nStart with: lc load {} --open", first.task_id);
            }
            Ok(())
        }
        Cmd::Load {
            id,
            dataset: dataset_id,
            open,
            force,
        } => {
            let cfg = Config::load()?;
            let dataset = dataset::resolve(dataset_id.as_deref())?;
            let conn = index::open_db()?;
            let row = loader::resolve_in(&conn, dataset, &id)?;
            let json_path = Path::new(&row.json_path);
            let prob = problem::load_task_for(dataset, json_path, &row.task_id)?;
            let dir = generator::generate(&cfg, dataset, &prob, json_path, force)?;
            Session::load_or_new()?.mark_loaded(&row.key())?;
            println!("Loaded {} → {}", prob.task_id.bold(), dir.display());
            println!(
                "  README.md · solution.py · run_tests.py ({} test cases)",
                prob.input_output.len()
            );
            if open {
                generator::open_in_editor(&dir);
            } else {
                println!("Next: edit solution.py there, then run `lc test` in that folder.");
            }
            Ok(())
        }
        Cmd::Test {
            id,
            dataset: dataset_id,
            case,
            full,
            verbose,
        } => {
            let cfg = Config::load()?;
            let dataset = dataset::resolve(dataset_id.as_deref())?;
            let all_passed =
                runner::cmd_test_in(&cfg, dataset, id.as_deref(), case, full, verbose)?;
            if !all_passed {
                std::process::exit(1);
            }
            Ok(())
        }
        Cmd::Ask {
            id,
            case,
            provider,
            clipboard,
        } => {
            let cfg = Config::load()?;
            cmd_ask(&cfg, id.as_deref(), case, provider.as_deref(), clipboard)
        }
        Cmd::Serve { port, lan } => {
            let cfg = Config::load()?;
            serve::run(cfg, port, lan)
        }
        Cmd::List(cmd) => cmd_list(cmd),
        Cmd::Submit => {
            println!(
                "`lc submit` is not implemented in v1 — paste solution.py into leetcode.com manually."
            );
            Ok(())
        }
    }
}

fn cmd_config(cmd: ConfigCmd) -> Result<()> {
    match cmd {
        ConfigCmd::Set { key, value } => {
            let mut cfg = Config::load()?;
            cfg.set(&key, &value)?;
            cfg.save()?;
            println!("{key} = {value}");
        }
        ConfigCmd::Get { key } => println!("{}", Config::load()?.get(&key)?),
        ConfigCmd::Show => print!("{}", toml::to_string_pretty(&Config::load()?)?),
        ConfigCmd::Path => println!("{}", config::config_path()?.display()),
    }
    Ok(())
}

fn cmd_list(cmd: ListCmd) -> Result<()> {
    let conn = index::open_db()?;
    match cmd {
        ListCmd::Create { name } => lists::create_or_get(&conn, &name),
        ListCmd::Delete { name } => lists::delete(&conn, &name),
        ListCmd::Add { name, ids } => lists::add(&conn, &name, &ids),
        ListCmd::Remove { name, ids } => lists::remove(&conn, &name, &ids),
        ListCmd::Show { name } => lists::show(&conn, &name),
        ListCmd::Shuffle { name } => lists::shuffle(&conn, &name),
        ListCmd::Export { name, output } => lists::export(&conn, &name, output.as_deref()),
        ListCmd::Import { file } => lists::import(&conn, &file),
        ListCmd::Ls => lists::ls(&conn),
        ListCmd::Stats { name } => {
            let session = Session::load()?;
            stats::list(&conn, &name, session.as_ref())
        }
    }
}

fn parse_sort(raw: &str) -> Result<SearchSort> {
    SearchSort::parse(raw).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown sort {raw:?} — expected task_id, question, difficulty, cases, or tags"
        )
    })
}

fn cmd_ask(
    cfg: &Config,
    id: Option<&str>,
    case: Option<u32>,
    provider: Option<&str>,
    clipboard: bool,
) -> Result<()> {
    let dir = runner::locate_workspace(cfg, id)?;
    let meta = runner::read_meta(&dir)?;
    let solution_src = std::fs::read_to_string(dir.join("solution.py"))
        .context("cannot read solution.py in the workspace")?;

    let last = runner::load_last_run()?
        .filter(|run| run.task_id == meta.task_id)
        .with_context(|| {
            format!(
                "no recorded test run for {} — run `lc test` first",
                meta.task_id
            )
        })?;

    let selected: Vec<&CaseResult> = match case {
        Some(n) => {
            let matched: Vec<&CaseResult> =
                last.results.iter().filter(|r| r.case == n).collect();
            if matched.is_empty() {
                bail!("case {n} was not part of the last test run — try `lc test --case {n}` first");
            }
            matched
        }
        None => {
            let failures: Vec<&CaseResult> =
                last.results.iter().filter(|r| !r.pass).collect();
            if failures.is_empty() {
                println!(
                    "All cases passed in the last run — nothing to debug. \
                     Use --case N to ask about a specific case anyway."
                );
                return Ok(());
            }
            failures
        }
    };

    // Description comes from the source JSON via the redacted Problem struct;
    // if the file moved since `lc load`, proceed without it.
    let description = problem::load_task(Path::new(&meta.json_path), &meta.task_id)
        .ok()
        .and_then(|p| p.problem_description);

    let user_prompt =
        llm::ask::build_user_prompt(&meta, description.as_deref(), &solution_src, &selected);

    if clipboard {
        let full = format!("{}\n\n---\n\n{}", llm::ask::SYSTEM_PROMPT, user_prompt);
        let copied = arboard::Clipboard::new().and_then(|mut cb| cb.set_text(full.clone()));
        match copied {
            Ok(()) => println!("Redacted prompt copied to the clipboard — paste it into Cursor chat."),
            Err(_) => println!("(clipboard unavailable — printing the prompt instead)\n\n{full}"),
        }
        return Ok(());
    }

    let provider = llm::make_provider(cfg, provider)?;
    eprintln!("Asking {}…", provider.label());
    let answer = provider.chat(llm::ask::SYSTEM_PROMPT, &user_prompt)?;
    println!("\n{answer}");
    Ok(())
}

/// `lc datasets --inspect`: the corpus as it is on disk, not as the adapter
/// hopes it is. See `src/datasets/inspect.rs` for why this exists.
fn inspect_datasets(cfg: &Config, only: Option<&str>) -> Result<()> {
    let targets: Vec<&'static lc::dataset::Dataset> = match only {
        Some(id) => vec![lc::dataset::get(id)?],
        None => lc::dataset::DATASETS.iter().collect(),
    };
    for dataset in targets {
        let dir = dataset.corpus_dir(cfg).ok();
        println!(
            "{} ({})",
            dataset.id,
            dir.as_ref()
                .map(|d| d.display().to_string())
                .unwrap_or_else(|| "no corpus dir".into())
        );
        let reports = lc::datasets::inspect::inspect(cfg, dataset)?;
        if reports.is_empty() {
            println!("  no .json / .jsonl files — download it, e.g.");
            println!("    python scripts/fetch_dataset.py {}", dataset.id);
            continue;
        }
        for report in reports {
            for line in report.lines() {
                println!("{line}");
            }
        }
    }
    println!();
    println!("MISSING means the adapter produced nothing for that field across the sample.");
    println!("Check it against \"columns\" and \"not read by any adapter\" above: a field that is");
    println!("MISSING while an obvious column is unread is a mapping to add in src/datasets/.");
    Ok(())
}

fn print_datasets(infos: &[lc::dataset::DatasetInfo]) {
    let mut table = Table::new();
    table.load_preset(comfy_table::presets::UTF8_FULL_CONDENSED);
    table.set_header(["dataset", "problems", "source", "corpus dir"]);
    for info in infos {
        table.add_row([
            info.id.clone(),
            info.count.to_string(),
            info.source.clone(),
            info.corpus_dir.clone().unwrap_or_else(|| "(no data-dir set)".into()),
        ]);
    }
    println!("{table}");
    if infos.iter().all(|info| info.count == 0) {
        println!("nothing indexed yet — download a corpus into its folder, then `lc index`");
    }
}

fn print_problem_rows(rows: &[ProblemRow]) {
    if rows.is_empty() {
        println!("no matches — if the corpus changed, rebuild with `lc index`");
        return;
    }
    let mut table = Table::new();
    table.load_preset(comfy_table::presets::UTF8_FULL_CONDENSED);
    table.set_header(["q#", "task_id", "difficulty", "tags", "cases"]);
    for row in rows {
        table.add_row([
            row.question_id.clone().unwrap_or_default(),
            row.task_id.clone(),
            row.difficulty.clone().unwrap_or_default(),
            row.tags.join(", "),
            row.test_count.to_string(),
        ]);
    }
    println!("{table}");
}
