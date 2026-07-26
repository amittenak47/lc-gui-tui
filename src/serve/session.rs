//! Per-coaching-session state, held server-side.
//!
//! The "already told you" history lives here rather than on the client so the
//! ambient coach escalates — hint, stronger hint, counterexample — instead of
//! looping. It is deliberately in memory only: it is conversation state, not
//! progress, and `session::Session` on disk already owns the latter.

use std::collections::HashMap;

/// What the coach has already said about one problem, in one sitting.
#[derive(Debug, Clone, Default)]
pub struct CoachSession {
    pub task_id: String,
    /// Nudges already delivered, oldest first. Fed back into the prompt.
    pub said: Vec<String>,
    /// Scene fingerprint at the last analysis, so an unchanged board costs
    /// nothing. The client also checks this; the server is the backstop.
    pub last_scene_hash: Option<u64>,
    /// Reviews submitted this session, for the escalation ladder.
    pub reviews: u32,
    /// Reveals tapped this session.
    pub reveals: u32,
}

/// How many nudges to keep in the prompt. Older ones are dropped: the point is
/// "don't repeat yourself", and a local model's context is finite.
const MAX_HISTORY: usize = 6;

impl CoachSession {
    pub fn new(task_id: impl Into<String>) -> Self {
        Self {
            task_id: task_id.into(),
            ..Default::default()
        }
    }

    pub fn nudges_so_far(&self) -> u32 {
        self.said.len() as u32
    }

    pub fn record_nudge(&mut self, nudge: impl Into<String>) {
        let nudge = nudge.into();
        if nudge.trim().is_empty() {
            return;
        }
        self.said.push(nudge);
        if self.said.len() > MAX_HISTORY {
            self.said.remove(0);
        }
    }

    /// True when the board has changed since the last analysis. Updates the
    /// stored fingerprint as a side effect.
    pub fn scene_changed(&mut self, hash: u64) -> bool {
        let changed = self.last_scene_hash != Some(hash);
        self.last_scene_hash = Some(hash);
        changed
    }

    /// Switching problems mid-session resets the ladder — nothing the coach
    /// said about the last problem applies to the next one.
    pub fn retarget(&mut self, task_id: &str) {
        if self.task_id != task_id {
            *self = CoachSession::new(task_id);
        }
    }
}

#[derive(Debug, Default)]
pub struct SessionStore {
    sessions: HashMap<String, CoachSession>,
}

impl SessionStore {
    /// Get or create the session for a client-supplied id, retargeted to the
    /// problem currently on the board.
    pub fn entry(&mut self, session_id: &str, task_id: &str) -> &mut CoachSession {
        let session = self
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(|| CoachSession::new(task_id));
        session.retarget(task_id);
        session
    }

    pub fn get(&self, session_id: &str) -> Option<&CoachSession> {
        self.sessions.get(session_id)
    }

    pub fn end(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_escalates_then_forgets_the_oldest() {
        let mut session = CoachSession::new("two-sum");
        for i in 0..(MAX_HISTORY + 2) {
            session.record_nudge(format!("nudge {i}"));
        }
        assert_eq!(session.said.len(), MAX_HISTORY);
        assert_eq!(session.said[0], "nudge 2", "oldest nudges roll off");
        assert_eq!(session.nudges_so_far(), MAX_HISTORY as u32);
    }

    #[test]
    fn empty_nudges_are_not_recorded() {
        let mut session = CoachSession::new("two-sum");
        session.record_nudge("   ");
        assert!(session.said.is_empty());
    }

    #[test]
    fn an_unchanged_scene_is_detected() {
        let mut session = CoachSession::new("two-sum");
        assert!(session.scene_changed(42), "first look always counts");
        assert!(!session.scene_changed(42), "same board, no new work");
        assert!(session.scene_changed(43));
    }

    #[test]
    fn switching_problems_clears_what_was_said() {
        let mut store = SessionStore::default();
        store.entry("s1", "two-sum").record_nudge("think about sorting");
        assert_eq!(store.entry("s1", "two-sum").said.len(), 1);
        assert!(
            store.entry("s1", "valid-parentheses").said.is_empty(),
            "advice about the last problem must not follow them to the next"
        );
        assert_eq!(store.len(), 1, "same session, retargeted rather than leaked");
    }
}
