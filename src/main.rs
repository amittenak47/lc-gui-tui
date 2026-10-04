use anyhow::Result;
use clap::{CommandFactory, Parser, Subcommand};
use colored::Colorize;
use comfy_table::Table;

// The CLI is a shell over the same library crate the Tauri GUI embeds.
use whiteboard::{config, dataset, datasets, index};

use config::Config;
#[derive(Parser)]
#[command(
    name = "lc",
    version,
    about = "Maintenance tools for Pen Island: index problem sets, inspect datasets, edit config.toml"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
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
    match cli.cmd {
        None => {
            Cli::command().print_help()?;
            println!();
            Ok(())
        }
        Some(cmd) => run_cmd(cmd),
    }
}

fn run_cmd(cmd: Cmd) -> Result<()> {
    match cmd {
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

/// `lc datasets --inspect`: the corpus as it is on disk, not as the adapter
/// hopes it is. See `src/datasets/inspect.rs` for why this exists.
fn inspect_datasets(cfg: &Config, only: Option<&str>) -> Result<()> {
    let targets: Vec<&'static dataset::Dataset> = match only {
        Some(id) => vec![dataset::get(id)?],
        None => dataset::DATASETS.iter().collect(),
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
        let reports = datasets::inspect::inspect(cfg, dataset)?;
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

fn print_datasets(infos: &[dataset::DatasetInfo]) {
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
