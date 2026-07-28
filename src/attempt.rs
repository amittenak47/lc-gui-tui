//! What survives leaving a problem, and what does not.
//!
//! A workspace holds three things the student built: the **layout**
//! (`board.json`), the **code** (`solution.py`), and the **agent session**
//! (`.lc/agent.json`, the coach transcript). When they step away, they choose
//! what to keep, and the rules differ depending on whether the problem is
//! solved:
//!
//! | | layout | code | agent session |
//! | --- | --- | --- | --- |
//! | unsolved, **save** | kept | kept | kept |
//! | unsolved, **discard** | cleared | reset to starter | cleared |
//! | solved, **save attempt** | archived, then cleared | kept | archived, then cleared |
//! | solved, **clear attempt** | cleared | reset to starter | archived, then cleared |
//!
//! Two rules are worth spelling out because they are not symmetric.
//!
//! **The agent session is always saved once a problem is solved** — even when
//! the attempt is cleared — so the reasoning that got there is never thrown
//! away. It goes to `.lc/attempts/<timestamp>/agent.json`.
//!
//! **Re-attempting a solved problem always starts from a fresh layout and a
//! fresh agent session**, whatever was chosen. That is why "save" archives
//! rather than leaves in place: keeping the old board would mean re-solving a
//! problem while looking at the answer you already drew.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Coach transcript for one workspace, as the client stores it.
///
/// The message shape is the client's: this is a store, not a schema. The
/// daemon never interprets it, so the panel can evolve without a wire change.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentSession {
    #[serde(default)]
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub updated_at: u64,
}

/// What the last visit to this workspace left behind.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AttemptState {
    /// Every case passed at least once in this workspace.
    pub solved: bool,
    /// The student chose to keep their work when they last stepped away.
    pub saved: bool,
    /// Archived attempt folders, newest last.
    pub archives: Vec<String>,
    pub updated_at: u64,
}

fn lc_dir(workspace: &Path) -> PathBuf {
    workspace.join(".lc")
}

fn agent_path(workspace: &Path) -> PathBuf {
    lc_dir(workspace).join("agent.json")
}

fn state_path(workspace: &Path) -> PathBuf {
    lc_dir(workspace).join("attempt.json")
}

fn board_path(workspace: &Path) -> PathBuf {
    workspace.join("board.json")
}

fn solution_path(workspace: &Path) -> PathBuf {
    workspace.join("solution.py")
}

/// The stored coach transcript, or an empty one.
pub fn read_agent(workspace: &Path) -> Result<AgentSession> {
    let path = agent_path(workspace);
    if !path.exists() {
        return Ok(AgentSession::default());
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    // A truncated transcript is not worth failing the whole problem load over.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

pub fn write_agent(workspace: &Path, messages: Vec<serde_json::Value>) -> Result<AgentSession> {
    let session = AgentSession {
        messages,
        updated_at: now(),
    };
    let dir = lc_dir(workspace);
    std::fs::create_dir_all(&dir)?;
    let path = agent_path(workspace);
    std::fs::write(&path, serde_json::to_string_pretty(&session)?)
        .with_context(|| format!("cannot write {}", path.display()))?;
    Ok(session)
}

pub fn read_state(workspace: &Path) -> Result<AttemptState> {
    let path = state_path(workspace);
    if !path.exists() {
        return Ok(AttemptState::default());
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn write_state(workspace: &Path, state: &AttemptState) -> Result<()> {
    std::fs::create_dir_all(lc_dir(workspace))?;
    let path = state_path(workspace);
    std::fs::write(&path, serde_json::to_string_pretty(state)?)
        .with_context(|| format!("cannot write {}", path.display()))?;
    Ok(())
}

/// Record that this workspace has been solved, so the next time the student
/// steps away they are asked the *solved* question, not the unsolved one.
pub fn mark_solved(workspace: &Path) -> Result<AttemptState> {
    let mut state = read_state(workspace)?;
    state.solved = true;
    state.updated_at = now();
    write_state(workspace, &state)?;
    Ok(state)
}

/// What [`finish`] did, so the client can say so rather than guess.
#[derive(Debug, Clone, Serialize)]
pub struct AttemptOutcome {
    pub solved: bool,
    pub saved: bool,
    /// Whether the layout, code, and transcript survive into the next attempt.
    pub kept_layout: bool,
    pub kept_code: bool,
    pub kept_agent_session: bool,
    /// Where the archived copy went, when one was made.
    pub archived_to: Option<String>,
    pub state: AttemptState,
}

/// Apply the student's choice on leaving a problem. See the module docs for
/// the table this implements.
///
/// `starter` is the code a discarded attempt resets to — the same stub
/// `lc load` would have written.
pub fn finish(
    workspace: &Path,
    solved: bool,
    save: bool,
    starter: Option<&str>,
) -> Result<AttemptOutcome> {
    let mut state = read_state(workspace)?;
    state.solved = state.solved || solved;
    state.saved = save && !solved;
    state.updated_at = now();

    // Solved problems always archive the transcript, and a saved solved
    // attempt archives the board and code alongside it.
    let mut archived_to = None;
    if solved {
        let stamp = format!("{}", now());
        let dir = lc_dir(workspace).join("attempts").join(&stamp);
        std::fs::create_dir_all(&dir)?;
        copy_if_present(&agent_path(workspace), &dir.join("agent.json"))?;
        if save {
            copy_if_present(&board_path(workspace), &dir.join("board.json"))?;
            copy_if_present(&solution_path(workspace), &dir.join("solution.py"))?;
        }
        state.archives.push(stamp.clone());
        archived_to = Some(dir.display().to_string());
    }

    // A fresh layout and a fresh agent session on the next attempt is
    // unconditional once solved; before that it follows the student's choice.
    let keep_live = save && !solved;
    if !keep_live {
        remove_if_present(&board_path(workspace))?;
        remove_if_present(&agent_path(workspace))?;
    }

    // Code is the one thing a saved solved attempt keeps in place — going back
    // to a problem you solved should not silently delete the solution.
    let kept_code = save;
    if !kept_code {
        if let Some(starter) = starter {
            std::fs::write(solution_path(workspace), starter).with_context(|| {
                format!("cannot reset {}", solution_path(workspace).display())
            })?;
        } else {
            remove_if_present(&solution_path(workspace))?;
        }
    }

    write_state(workspace, &state)?;
    Ok(AttemptOutcome {
        solved,
        saved: save,
        kept_layout: keep_live,
        kept_code,
        kept_agent_session: keep_live,
        archived_to,
        state,
    })
}

fn copy_if_present(from: &Path, to: &Path) -> Result<()> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to)
        .with_context(|| format!("cannot archive {} to {}", from.display(), to.display()))?;
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path)
            .with_context(|| format!("cannot remove {}", path.display()))?;
    }
    Ok(())
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

    struct Workspace(PathBuf);

    impl Workspace {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lc-attempt-{}-{name}-{}",
                std::process::id(),
                now()
            ));
            std::fs::create_dir_all(dir.join(".lc")).unwrap();
            std::fs::write(dir.join("board.json"), r#"{"v":1,"elements":[1]}"#).unwrap();
            std::fs::write(dir.join("solution.py"), "def solve():\n    return 42\n").unwrap();
            write_agent(&dir, vec![serde_json::json!({"role": "user"})]).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn has(&self, name: &str) -> bool {
            self.0.join(name).exists()
        }

        fn solution(&self) -> String {
            std::fs::read_to_string(self.0.join("solution.py")).unwrap()
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const STARTER: &str = "class Solution:\n    def solve(self):\n        pass\n";

    #[test]
    fn an_unsolved_save_resumes_layout_code_and_transcript() {
        let ws = Workspace::new("unsolved-save");
        let outcome = finish(ws.path(), false, true, Some(STARTER)).unwrap();

        assert!(outcome.kept_layout && outcome.kept_code && outcome.kept_agent_session);
        assert!(ws.has("board.json"), "the layout comes back next time");
        assert_eq!(ws.solution(), "def solve():\n    return 42\n");
        assert_eq!(
            read_agent(ws.path()).unwrap().messages.len(),
            1,
            "the coach thread continues"
        );
        assert!(read_state(ws.path()).unwrap().saved);
    }

    #[test]
    fn an_unsolved_discard_leaves_nothing_behind() {
        let ws = Workspace::new("unsolved-discard");
        let outcome = finish(ws.path(), false, false, Some(STARTER)).unwrap();

        assert!(!outcome.kept_layout && !outcome.kept_code && !outcome.kept_agent_session);
        assert!(!ws.has("board.json"), "next attempt starts on a clean board");
        assert_eq!(ws.solution(), STARTER, "code goes back to the starter stub");
        assert!(read_agent(ws.path()).unwrap().messages.is_empty());
        assert!(outcome.archived_to.is_none(), "nothing to archive");
    }

    /// The asymmetric rule: keeping a solved attempt still means the *next*
    /// attempt starts fresh, so the board and transcript are archived rather
    /// than left in place.
    #[test]
    fn a_saved_solved_attempt_is_archived_and_the_next_run_starts_fresh() {
        let ws = Workspace::new("solved-save");
        let outcome = finish(ws.path(), true, true, Some(STARTER)).unwrap();

        assert!(!outcome.kept_layout, "a re-attempt gets a fresh layout");
        assert!(!outcome.kept_agent_session, "and a fresh agent session");
        assert!(outcome.kept_code, "but the solution that passed is kept");

        assert!(!ws.has("board.json"));
        assert!(!ws.has(".lc/agent.json"));
        assert_eq!(ws.solution(), "def solve():\n    return 42\n");

        let archive = PathBuf::from(outcome.archived_to.expect("archived"));
        assert!(archive.join("board.json").exists(), "the layout was saved");
        assert!(archive.join("solution.py").exists());
        assert!(archive.join("agent.json").exists());
        assert!(read_state(ws.path()).unwrap().solved);
    }

    /// "Regardless of selection, the agent session should always be saved."
    #[test]
    fn clearing_a_solved_attempt_still_archives_the_agent_session() {
        let ws = Workspace::new("solved-clear");
        let outcome = finish(ws.path(), true, false, Some(STARTER)).unwrap();

        assert_eq!(ws.solution(), STARTER, "the attempt itself is cleared");
        assert!(!ws.has("board.json"));

        let archive = PathBuf::from(outcome.archived_to.expect("archived"));
        assert!(
            archive.join("agent.json").exists(),
            "the transcript survives even a cleared attempt"
        );
        assert!(
            !archive.join("board.json").exists(),
            "but the cleared work is not kept"
        );
    }

    #[test]
    fn solving_is_remembered_so_the_next_prompt_asks_the_right_question() {
        let ws = Workspace::new("mark-solved");
        assert!(!read_state(ws.path()).unwrap().solved);
        mark_solved(ws.path()).unwrap();
        assert!(read_state(ws.path()).unwrap().solved);
        // And it stays solved through a later unsolved-looking finish.
        finish(ws.path(), false, true, Some(STARTER)).unwrap();
        assert!(read_state(ws.path()).unwrap().solved);
    }
}
