use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemState {
    Loaded,
    Passed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemProgress {
    pub state: ProblemState,
    #[serde(default)]
    pub passed_cases: u32,
    #[serde(default)]
    pub total_cases: u32,
    #[serde(default)]
    pub updated_at: u64,
}

/// Practice session state.
///
/// Every per-problem key here — `problems`, `queue`, `reveals` — is a
/// **dataset-qualified** `dataset/task_id`, because the same slug means a
/// different problem in each corpus and a `failed` badge must not bleed across
/// the browser's tabs. Session files written before datasets existed hold bare
/// task ids; [`Session::migrate`] rewrites them on load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub started_at: u64,
    #[serde(default)]
    pub active_list: Option<String>,
    #[serde(default)]
    pub problems: HashMap<String, ProblemProgress>,
    /// Problems added to the current practice session (in order).
    #[serde(default)]
    pub queue: Vec<String>,
    /// How many times the reference solution was revealed, per problem — i.e.
    /// how often the user tapped out. Written only by the `/coach/reveal` path.
    #[serde(default)]
    pub reveals: HashMap<String, u32>,
}

/// Per-dataset slice of [`Session`] used when the corpus is not installed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DatasetLeftover {
    pub loaded: u32,
    pub passed: u32,
    pub failed: u32,
    pub reveals: u32,
}

impl DatasetLeftover {
    pub fn any(&self) -> bool {
        self.loaded + self.passed + self.failed + self.reveals > 0
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            started_at: now(),
            active_list: None,
            problems: HashMap::new(),
            queue: Vec::new(),
            reveals: HashMap::new(),
        }
    }

    pub fn path() -> Result<PathBuf> {
        Ok(crate::config::config_dir()?.join("session.json"))
    }

    pub fn load() -> Result<Option<Self>> {
        let path = Self::path()?;
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path)?;
        Ok(serde_json::from_str::<Self>(&raw).ok().map(|mut session| {
            session.migrate();
            session
        }))
    }

    /// Rewrite bare `task_id` keys as `leetcode/task_id`.
    ///
    /// A session file written before datasets existed only ever held problems
    /// from the original corpus, so that is what its keys mean. Without this,
    /// every one of those problems would silently lose its pass/fail history
    /// the first time the browser asked for a dataset-qualified key.
    fn migrate(&mut self) {
        let qualify = |key: &str| {
            let (dataset, task_id) = crate::dataset::split_key(key);
            format!("{dataset}/{task_id}")
        };
        self.problems = self
            .problems
            .drain()
            .map(|(key, value)| (qualify(&key), value))
            .collect();
        self.reveals = self
            .reveals
            .drain()
            .map(|(key, value)| (qualify(&key), value))
            .collect();
        for entry in &mut self.queue {
            *entry = qualify(entry);
        }
    }

    pub fn load_or_new() -> Result<Self> {
        Ok(Self::load()?.unwrap_or_else(Self::new))
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, serde_json::to_string_pretty(self)?)
            .with_context(|| format!("cannot write {}", path.display()))?;
        Ok(())
    }

    pub fn reset() -> Result<Self> {
        let session = Self::new();
        session.save()?;
        Ok(session)
    }

    pub fn set_active_list(&mut self, name: Option<String>) -> Result<()> {
        self.active_list = name;
        self.save()
    }

    /// `key` is a dataset-qualified `dataset/task_id` — see [`Session`].
    pub fn mark_loaded(&mut self, key: &str) -> Result<()> {
        self.problems.insert(
            key.to_string(),
            ProblemProgress {
                state: ProblemState::Loaded,
                passed_cases: 0,
                total_cases: 0,
                updated_at: now(),
            },
        );
        self.save()
    }

    pub fn mark_tested(&mut self, key: &str, passed: u32, total: u32) -> Result<()> {
        let state = if passed == total && total > 0 {
            ProblemState::Passed
        } else {
            ProblemState::Failed
        };
        self.problems.insert(
            key.to_string(),
            ProblemProgress {
                state,
                passed_cases: passed,
                total_cases: total,
                updated_at: now(),
            },
        );
        self.save()
    }

    pub fn progress(&self, key: &str) -> Option<&ProblemProgress> {
        self.problems.get(key)
    }

    /// Record that the user revealed the reference solution, returning the new
    /// count for this problem.
    pub fn mark_revealed(&mut self, key: &str) -> Result<u32> {
        let count = self.reveals.entry(key.to_string()).or_insert(0);
        *count += 1;
        let count = *count;
        self.save()?;
        Ok(count)
    }

    pub fn reveal_count(&self, key: &str) -> u32 {
        self.reveals.get(key).copied().unwrap_or(0)
    }

    /// Pass/fail still on disk after DLC Remove (index empty, `session.json` kept).
    pub fn leftover_for_dataset(&self, dataset: &str) -> DatasetLeftover {
        let prefix = format!("{dataset}/");
        let mut out = DatasetLeftover::default();
        for (key, progress) in &self.problems {
            if !key.starts_with(&prefix) {
                continue;
            }
            match progress.state {
                ProblemState::Loaded => out.loaded += 1,
                ProblemState::Passed => out.passed += 1,
                ProblemState::Failed => out.failed += 1,
            }
        }
        for (key, count) in &self.reveals {
            if key.starts_with(&prefix) {
                out.reveals += *count;
            }
        }
        out
    }

    /// Problems the user tapped out on, and how many times, worst first.
    pub fn revealed_problems(&self) -> Vec<(&str, u32)> {
        let mut out: Vec<(&str, u32)> = self
            .reveals
            .iter()
            .map(|(task_id, count)| (task_id.as_str(), *count))
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        out
    }

    pub fn add_to_queue(&mut self, key: &str) -> Result<()> {
        if !self.queue.iter().any(|t| t == key) {
            self.queue.push(key.to_string());
        }
        self.save()
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this prevents: a pre-datasets `session.json` full of bare task
    /// ids would read as "nothing attempted", silently wiping a user's history
    /// the first time they opened the browser after upgrading.
    #[test]
    fn a_pre_datasets_session_keeps_its_history() {
        let raw = r#"{
            "started_at": 1,
            "problems": {"two-sum": {"state": "passed", "passed_cases": 3, "total_cases": 3,
                                     "updated_at": 2}},
            "queue": ["two-sum", "3sum"],
            "reveals": {"two-sum": 1}
        }"#;
        let mut session: Session = serde_json::from_str(raw).unwrap();
        session.migrate();

        assert!(session.progress("two-sum").is_none(), "bare keys are rewritten");
        let progress = session.progress("leetcode/two-sum").expect("history survives");
        assert_eq!(progress.state, ProblemState::Passed);
        assert_eq!(session.queue, vec!["leetcode/two-sum", "leetcode/3sum"]);
        assert_eq!(session.reveal_count("leetcode/two-sum"), 1);
    }

    #[test]
    fn already_qualified_keys_are_left_alone_and_stay_per_dataset() {
        let raw = r#"{
            "started_at": 1,
            "problems": {
                "kodcode/two-sum": {"state": "failed", "passed_cases": 1, "total_cases": 3,
                                    "updated_at": 2}
            },
            "queue": ["kodcode/two-sum"],
            "reveals": {}
        }"#;
        let mut session: Session = serde_json::from_str(raw).unwrap();
        session.migrate();

        assert_eq!(
            session.progress("kodcode/two-sum").map(|p| p.state),
            Some(ProblemState::Failed)
        );
        // The same slug in the LeetCode corpus is untouched by that failure.
        assert!(session.progress("leetcode/two-sum").is_none());
        assert_eq!(session.queue, vec!["kodcode/two-sum"]);
    }

    /// Migration must be idempotent — it runs on every load.
    #[test]
    fn migrating_twice_changes_nothing() {
        let mut session = Session::new();
        session.problems.insert(
            "two-sum".into(),
            ProblemProgress {
                state: ProblemState::Loaded,
                passed_cases: 0,
                total_cases: 0,
                updated_at: 0,
            },
        );
        session.migrate();
        let once = session.problems.keys().cloned().collect::<Vec<_>>();
        session.migrate();
        let twice = session.problems.keys().cloned().collect::<Vec<_>>();
        assert_eq!(once, twice);
        assert_eq!(once, vec!["leetcode/two-sum"]);
    }

    #[test]
    fn leftover_stats_survive_an_empty_index_for_that_dataset() {
        let mut session = Session::new();
        session.problems.insert(
            "kodcode/running-max".into(),
            ProblemProgress {
                state: ProblemState::Passed,
                passed_cases: 3,
                total_cases: 3,
                updated_at: 1,
            },
        );
        session.problems.insert(
            "leetcode/two-sum".into(),
            ProblemProgress {
                state: ProblemState::Failed,
                passed_cases: 0,
                total_cases: 2,
                updated_at: 1,
            },
        );
        session.reveals.insert("kodcode/running-max".into(), 2);
        let kodcode = session.leftover_for_dataset("kodcode");
        assert_eq!(
            kodcode,
            DatasetLeftover {
                loaded: 0,
                passed: 1,
                failed: 0,
                reveals: 2,
            }
        );
        assert!(kodcode.any());
        assert_eq!(session.leftover_for_dataset("ms-python-q"), DatasetLeftover::default());
        assert_eq!(session.progress("kodcode/running-max").map(|p| p.state), Some(ProblemState::Passed));
    }
}
