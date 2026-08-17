//! The problem-set registry.
//!
//! Every problem in `lc` belongs to exactly one **dataset**. Datasets are kept
//! in *separate SQLite tables* rather than sharing one with a discriminator
//! column, because they are separate corpora: their ids collide (`two-sum`
//! exists in three of them), their difficulty scales are unrelated, and a
//! rebuild of one must not touch another.
//!
//! A dataset is therefore three things:
//!
//! - a **slug** the wire format and the UI tab use (`kodcode`);
//! - a **table pair** (`problems_kodcode`, `problem_tags_kodcode`);
//! - a **corpus directory**, normally `<data-dir>/<slug>/`.
//!
//! The original LeetCode corpus keeps the unprefixed `problems` /
//! `problem_tags` tables and may live directly in `<data-dir>`, so an existing
//! install keeps its index, its workspaces, and its session history.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::config::Config;

/// Slug of the corpus `lc` shipped with: `newfacade/LeetCodeDataset`.
pub const DEFAULT_DATASET: &str = "leetcode";

/// How a corpus record is shaped, and therefore which adapter reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Already in `lc`'s canonical field names — no adaptation needed.
    Canonical,
    KodCode,
    MorganStanleyPythonQ,
    DeepSeekLeetCode,
    LeetCodeWithTests,
}

#[derive(Debug, Clone, Copy)]
pub struct Dataset {
    /// Wire/UI slug. Stable — it is stored in `session.json` keys.
    pub id: &'static str,
    /// What the tab says.
    pub label: &'static str,
    /// Where the corpus came from, for docs and the UI's tooltip.
    pub source: &'static str,
    pub shape: Shape,
    /// One line on what this corpus's columns mean, for the tab's tooltip.
    ///
    /// Worth carrying because these corpora do not agree on what a "tag" is:
    /// KodCode's are a seed family and a phrasing style, not topics, and
    /// nothing in the browser would otherwise say so.
    pub notes: &'static str,
    /// SQLite table holding the indexed rows.
    pub table: &'static str,
    /// SQLite table holding `(tag, task_id)` pairs.
    pub tag_table: &'static str,
}

/// Every dataset `lc` knows how to index, in tab order.
pub const DATASETS: [Dataset; 5] = [
    Dataset {
        id: DEFAULT_DATASET,
        label: "LeetCode",
        source: "newfacade/LeetCodeDataset",
        shape: Shape::Canonical,
        table: "problems",
        tag_table: "problem_tags",
        notes: "The original corpus: LeetCode problems with topic tags and sample cases.",
    },
    Dataset {
        id: "kodcode",
        label: "KodCode",
        source: "KodCode/KodCode-V1",
        shape: Shape::KodCode,
        table: "problems_kodcode",
        tag_table: "problem_tags_kodcode",
        notes: "Synthetic problems. Only Complete rows are indexed — Instruct duplicates and online_judge (stdin/stdout) rows are skipped. Tags are the seed family (Algorithm, Docs, Leetcode, …). Difficulty is the corpus's own rating; sample cases are read off its pytest suite.",
    },
    Dataset {
        id: "ms-python-q",
        label: "MS Python/Q",
        source: "morganstanley/sft-python-q-problems",
        shape: Shape::MorganStanleyPythonQ,
        table: "problems_ms_python_q",
        tag_table: "problem_tags_ms_python_q",
        notes: "LeetCode-style problems with structured test cases and topic tags.",
    },
    Dataset {
        id: "deepseek-leetcode",
        label: "DeepSeek LC",
        source: "davidheineman/deepseek-leetcode",
        shape: Shape::DeepSeekLeetCode,
        table: "problems_deepseek_leetcode",
        tag_table: "problem_tags_deepseek_leetcode",
        notes: "DeepSeek-Coder's contest benchmark. Cases are extracted from its assert suite; the tag is LeetCode's category.",
    },
    Dataset {
        id: "leetcode-with-tests",
        label: "LC + Tests",
        source: "kr4t0n/leetcode-with-tests",
        shape: Shape::LeetCodeWithTests,
        table: "problems_leetcode_with_tests",
        tag_table: "problem_tags_leetcode_with_tests",
        notes: "Community re-packaging of LeetCode with test code. Columns vary between dumps, so fields are read through candidate names.",
    },
];

/// The dataset for a slug, or an error naming the ones that exist.
pub fn get(id: &str) -> Result<&'static Dataset> {
    let trimmed = id.trim();
    match DATASETS.iter().find(|d| d.id == trimmed) {
        Some(dataset) => Ok(dataset),
        None => bail!(
            "unknown dataset {trimmed:?} — expected one of {}",
            DATASETS
                .iter()
                .map(|d| d.id)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// The dataset for an optional slug; `None` and `""` mean the default corpus.
pub fn resolve(id: Option<&str>) -> Result<&'static Dataset> {
    match id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(slug) => get(slug),
        None => get(DEFAULT_DATASET),
    }
}

/// The default dataset, which is always present.
pub fn default() -> &'static Dataset {
    &DATASETS[0]
}

impl Dataset {
    pub fn is_default(&self) -> bool {
        self.id == DEFAULT_DATASET
    }

    /// Where this dataset's JSON/JSONL files live.
    ///
    /// An explicit `data.datasets.<id>` config entry wins. Otherwise it is
    /// `<data-dir>/<id>/`, except for the default corpus, which falls back to
    /// `<data-dir>` itself so an existing single-corpus install keeps working.
    pub fn corpus_dir(&self, cfg: &Config) -> Result<PathBuf> {
        if let Some(explicit) = cfg.dataset_dir(self.id) {
            return Ok(crate::config::expand_tilde(&explicit));
        }
        let root = cfg.json_dir()?;
        let nested = root.join(self.id);
        if nested.is_dir() || !self.is_default() {
            return Ok(nested);
        }
        Ok(root)
    }

    /// Workspace folder for one problem.
    ///
    /// The default corpus keeps `<workspace>/<task_id>` so existing solve
    /// folders are found unchanged; every other dataset is namespaced, because
    /// `two-sum` means a different problem in each of them.
    pub fn workspace_dir(&self, cfg: &Config, task_id: &str) -> PathBuf {
        let root = cfg.workspace_dir();
        if self.is_default() {
            root.join(task_id)
        } else {
            root.join(self.id).join(task_id)
        }
    }

    /// Key for `session.json` and any other per-problem store.
    ///
    /// Always qualified, so a `failed` badge on `kodcode/two-sum` never shows
    /// up on the LeetCode tab's `two-sum`.
    pub fn key(&self, task_id: &str) -> String {
        format!("{}/{}", self.id, task_id)
    }
}

/// Split a `dataset/task_id` session key. A bare key is a pre-datasets record
/// and belongs to the default corpus.
pub fn split_key(key: &str) -> (&str, &str) {
    match key.split_once('/') {
        Some((dataset, task_id))
            if (DATASETS.iter().any(|d| d.id == dataset)
                || crate::pad::is_pad_dataset_slug(dataset))
                && !task_id.is_empty() =>
        {
            (dataset, task_id)
        }
        _ => (DEFAULT_DATASET, key),
    }
}

/// Whether `path` sits inside a *different* dataset's subdirectory of the
/// corpus root. The default corpus indexes `<data-dir>` itself, so its walk has
/// to step over the other datasets' folders rather than swallowing them.
pub fn belongs_to_other_dataset(root: &Path, path: &Path, me: &Dataset) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let Some(first) = relative.components().next() else {
        return false;
    };
    let name = first.as_os_str().to_string_lossy();
    DATASETS.iter().any(|d| d.id != me.id && d.id == name)
}

/// Delete one dataset's files on disk.
///
/// Nested corpora (`<data-dir>/kodcode/`) can go as a whole directory. The
/// default LeetCode corpus may live *in* `<data-dir>` itself, next to those
/// subfolders — `remove_dir_all` on that path would wipe every DLC at once.
pub fn remove_corpus_dir(dataset: &Dataset, dest: &Path, json_root: &Path) -> Result<()> {
    if !dest.exists() {
        return Ok(());
    }
    if dest == json_root {
        let entries = match std::fs::read_dir(dest) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
        };
        for entry in entries {
            let path = entry?.path();
            if path.is_dir() {
                if belongs_to_other_dataset(dest, &path, dataset) {
                    continue;
                }
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_zip_part = name.starts_with(&format!(".{}", dataset.id))
                && name.ends_with(".zip.part");
            let is_json = matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("json" | "jsonl")
            );
            if is_json || is_zip_part {
                std::fs::remove_file(&path)?;
            }
        }
        return Ok(());
    }
    std::fs::remove_dir_all(dest)?;
    Ok(())
}

/// Whether this dataset has JSON/JSONL of its own under `dir`.
///
/// The default corpus lives in the data-dir root, so a naive recursive walk
/// would treat KodCode's files as LeetCode still being installed.
pub fn dir_has_own_corpus_files(dir: &Path, me: &Dataset) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if belongs_to_other_dataset(dir, &path, me) {
                continue;
            }
            if dir_has_own_corpus_files(&path, me) {
                return true;
            }
            continue;
        }
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("json" | "jsonl") => return true,
            _ => {}
        }
    }
    false
}

/// What `GET /datasets` and `lc datasets` report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetInfo {
    pub id: String,
    pub label: String,
    pub source: String,
    /// Indexed problems in this dataset's table.
    pub count: u32,
    /// Where its corpus files are expected, for the "run `lc index`" hint.
    pub corpus_dir: Option<String>,
    /// What this corpus's columns mean — the tab tooltip.
    #[serde(default)]
    pub notes: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_dataset_has_its_own_tables_and_slug() {
        let mut ids: Vec<&str> = DATASETS.iter().map(|d| d.id).collect();
        let mut tables: Vec<&str> = DATASETS.iter().map(|d| d.table).collect();
        let mut tag_tables: Vec<&str> = DATASETS.iter().map(|d| d.tag_table).collect();
        for list in [&mut ids, &mut tables, &mut tag_tables] {
            let before = list.len();
            list.sort_unstable();
            list.dedup();
            assert_eq!(list.len(), before, "datasets must not share names");
        }
        // Table names go straight into SQL, so they must be plain identifiers.
        for dataset in DATASETS {
            for name in [dataset.table, dataset.tag_table] {
                assert!(
                    name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                    "{name} is not a safe SQL identifier"
                );
            }
        }
    }

    #[test]
    fn the_original_corpus_keeps_the_unprefixed_tables() {
        let leetcode = get(DEFAULT_DATASET).unwrap();
        assert_eq!(leetcode.table, "problems");
        assert_eq!(leetcode.tag_table, "problem_tags");
        assert!(leetcode.is_default());
    }

    #[test]
    fn unknown_slugs_are_rejected_with_the_list() {
        let err = get("nope").unwrap_err().to_string();
        assert!(err.contains("kodcode"), "{err}");
        assert!(resolve(None).unwrap().is_default());
        assert!(resolve(Some("  ")).unwrap().is_default());
        assert_eq!(resolve(Some("kodcode")).unwrap().id, "kodcode");
    }

    /// The badge bug this prevents: `two-sum` exists in three corpora, and a
    /// `failed` mark earned in one must not appear on the others.
    #[test]
    fn session_keys_are_dataset_qualified() {
        let leetcode = get(DEFAULT_DATASET).unwrap();
        let kodcode = get("kodcode").unwrap();
        assert_ne!(leetcode.key("two-sum"), kodcode.key("two-sum"));
        assert_eq!(split_key(&kodcode.key("two-sum")), ("kodcode", "two-sum"));
        // A pre-datasets session file has bare task ids.
        assert_eq!(split_key("two-sum"), (DEFAULT_DATASET, "two-sum"));
        // And a task id that merely contains a slash is not a dataset key.
        assert_eq!(split_key("some/slug"), (DEFAULT_DATASET, "some/slug"));
    }

    #[test]
    fn the_default_walk_steps_over_the_other_corpora() {
        let root = Path::new("/corpus");
        let leetcode = get(DEFAULT_DATASET).unwrap();
        assert!(belongs_to_other_dataset(
            root,
            Path::new("/corpus/kodcode/train.jsonl"),
            leetcode
        ));
        assert!(!belongs_to_other_dataset(
            root,
            Path::new("/corpus/train.jsonl"),
            leetcode
        ));
        // …and a dataset indexing its own folder is not excluded from it.
        let kodcode = get("kodcode").unwrap();
        assert!(!belongs_to_other_dataset(
            root,
            Path::new("/corpus/kodcode/train.jsonl"),
            kodcode
        ));
    }

    #[test]
    fn remove_shared_root_leaves_sibling_corpora() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("train.jsonl"), "{}").unwrap();
        std::fs::write(root.join(".leetcode.zip.part"), "partial").unwrap();
        std::fs::create_dir(root.join("kodcode")).unwrap();
        std::fs::write(root.join("kodcode").join("k.jsonl"), "{}").unwrap();
        let leetcode = get(DEFAULT_DATASET).unwrap();
        remove_corpus_dir(leetcode, root, root).unwrap();
        assert!(!root.join("train.jsonl").exists());
        assert!(!root.join(".leetcode.zip.part").exists());
        assert!(root.join("kodcode").join("k.jsonl").exists());
        assert!(root.is_dir());
    }

    #[test]
    fn remove_nested_corpus_deletes_that_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let kod = root.join("kodcode");
        std::fs::create_dir(&kod).unwrap();
        std::fs::write(kod.join("k.jsonl"), "{}").unwrap();
        std::fs::write(root.join("train.jsonl"), "{}").unwrap();
        let kodcode = get("kodcode").unwrap();
        remove_corpus_dir(kodcode, &kod, root).unwrap();
        assert!(!kod.exists());
        assert!(root.join("train.jsonl").exists());
    }

    #[test]
    fn own_corpus_files_ignore_sibling_dataset_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("kodcode")).unwrap();
        std::fs::write(root.join("kodcode").join("k.jsonl"), "{}").unwrap();
        let leetcode = get(DEFAULT_DATASET).unwrap();
        assert!(
            !dir_has_own_corpus_files(root, leetcode),
            "kodcode jsonl must not count as LeetCode installed"
        );
        std::fs::write(root.join("train.jsonl"), "{}").unwrap();
        assert!(dir_has_own_corpus_files(root, leetcode));
    }
}
