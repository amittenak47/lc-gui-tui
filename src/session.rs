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
}

impl Session {
    pub fn new() -> Self {
        Self {
            started_at: now(),
            active_list: None,
            problems: HashMap::new(),
            queue: Vec::new(),
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
        Ok(serde_json::from_str(&raw).ok())
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

    pub fn mark_loaded(&mut self, task_id: &str) -> Result<()> {
        self.problems.insert(
            task_id.to_string(),
            ProblemProgress {
                state: ProblemState::Loaded,
                passed_cases: 0,
                total_cases: 0,
                updated_at: now(),
            },
        );
        self.save()
    }

    pub fn mark_tested(&mut self, task_id: &str, passed: u32, total: u32) -> Result<()> {
        let state = if passed == total && total > 0 {
            ProblemState::Passed
        } else {
            ProblemState::Failed
        };
        self.problems.insert(
            task_id.to_string(),
            ProblemProgress {
                state,
                passed_cases: passed,
                total_cases: total,
                updated_at: now(),
            },
        );
        self.save()
    }

    pub fn progress(&self, task_id: &str) -> Option<&ProblemProgress> {
        self.problems.get(task_id)
    }

    pub fn add_to_queue(&mut self, task_id: &str) -> Result<()> {
        if !self.queue.iter().any(|t| t == task_id) {
            self.queue.push(task_id.to_string());
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
