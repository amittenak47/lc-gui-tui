//! Stage and tool progress events, for the socket to relay while a run works.
//!
//! The coach pipeline is a sequence of blocking model calls. Before this module
//! the client could only know two things — "sent" and "answered" — so the chat
//! filled the gap with a timer that guessed at phases. A guess that is usually
//! wrong is worse than nothing: on a slow local model the fake "Preparing
//! response…" landed while the verdict stage had not started.
//!
//! An [`EventSink`] is what the pipeline reports through instead. It is a plain
//! callback, deliberately:
//!
//! - it costs nothing when absent ([`EventSink::none`] is what every HTTP
//!   handler and the TUI pass, and every emit is then a null check);
//! - it is called from inside `spawn_blocking`, so it must not be async;
//! - it can be cancelled from outside, which is how a disconnected socket stops
//!   a run that is between stages.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What a tool call did on its way to the board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    /// The model asked for it.
    Proposed,
    /// It validated and will be rendered.
    Accepted,
    /// It was dropped — `reason` says why.
    Rejected,
}

impl ToolStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolStatus::Proposed => "proposed",
            ToolStatus::Accepted => "accepted",
            ToolStatus::Rejected => "rejected",
        }
    }
}

/// One thing worth telling the student while they wait.
#[derive(Debug, Clone)]
pub enum CoachEvent {
    /// A named pipeline step started. `detail` is a short human string.
    Stage { stage: String, detail: String },
    Tool {
        name: String,
        status: ToolStatus,
        summary: String,
        reason: Option<String>,
    },
}

type Handler = dyn Fn(CoachEvent) + Send + Sync;

/// A cancellable progress channel handed down the pipeline.
///
/// Cloning is cheap and shares both the callback and the cancel flag, so a
/// nested stage can carry the same sink without threading lifetimes.
#[derive(Clone, Default)]
pub struct EventSink {
    handler: Option<Arc<Handler>>,
    cancelled: Option<Arc<AtomicBool>>,
}

impl std::fmt::Debug for EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventSink")
            .field("wired", &self.handler.is_some())
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl EventSink {
    /// The sink for every caller that has nowhere to send progress: the HTTP
    /// handlers, the TUI, and every test that only cares about the answer.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn new(handler: impl Fn(CoachEvent) + Send + Sync + 'static) -> Self {
        Self {
            handler: Some(Arc::new(handler)),
            cancelled: Some(Arc::new(AtomicBool::new(false))),
        }
    }

    /// A handle the socket keeps so a `cancel` frame — or a dropped connection —
    /// can stop the run at the next stage boundary.
    pub fn cancel_handle(&self) -> Option<Arc<AtomicBool>> {
        self.cancelled.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    /// Bail out of a stage sequence once the client stopped caring. Callers use
    /// this at stage boundaries; a model call already in flight still finishes,
    /// because the provider is blocking HTTP with its own timeout.
    pub fn cancelled_error(&self) -> Option<anyhow::Error> {
        self.is_cancelled()
            .then(|| anyhow::anyhow!("the coach run was cancelled"))
    }

    pub fn emit(&self, event: CoachEvent) {
        if let Some(handler) = self.handler.as_ref() {
            handler(event);
        }
    }

    pub fn stage(&self, stage: &str, detail: impl Into<String>) {
        if self.handler.is_none() {
            return;
        }
        self.emit(CoachEvent::Stage {
            stage: stage.to_string(),
            detail: detail.into(),
        });
    }

    pub fn tool(
        &self,
        name: &str,
        status: ToolStatus,
        summary: impl Into<String>,
        reason: Option<String>,
    ) {
        if self.handler.is_none() {
            return;
        }
        self.emit(CoachEvent::Tool {
            name: name.to_string(),
            status,
            summary: summary.into(),
            reason,
        });
    }
}

/// Stage names the client knows how to label. Kept here so the server and the
/// UI cannot drift apart silently — the WS contract lists exactly these.
pub const STAGE_NAMES: [&str; 12] = [
    "perceive",
    "claim",
    "verdict",
    "code",
    "retrace",
    "plan_approaches",
    "commit_approach",
    "draw_tools",
    "validate",
    "draw_review",
    "draw_fix",
    "done",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The sink every non-socket caller uses must be free: no allocation per
    /// emit, and nothing observable.
    #[test]
    fn a_sink_with_no_handler_swallows_everything() {
        let sink = EventSink::none();
        sink.stage("claim", "naming the approach");
        sink.tool("draw_structure", ToolStatus::Accepted, "array", None);
        assert!(!sink.is_cancelled());
        assert!(sink.cancelled_error().is_none());
        assert!(sink.cancel_handle().is_none());
    }

    #[test]
    fn events_arrive_in_order_and_clones_share_the_channel() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorder = Arc::clone(&seen);
        let sink = EventSink::new(move |event| {
            let line = match event {
                CoachEvent::Stage { stage, .. } => format!("stage:{stage}"),
                CoachEvent::Tool { name, status, .. } => {
                    format!("tool:{name}:{}", status.as_str())
                }
            };
            recorder.lock().unwrap().push(line);
        });

        sink.stage("perceive", "reading the board");
        let nested = sink.clone();
        nested.stage("claim", "naming the approach");
        nested.tool("draw_structure", ToolStatus::Rejected, "array", Some("no frames".into()));

        assert_eq!(
            *seen.lock().unwrap(),
            vec!["stage:perceive", "stage:claim", "tool:draw_structure:rejected"]
        );
    }

    #[test]
    fn cancelling_through_the_handle_is_visible_to_every_clone() {
        let sink = EventSink::new(|_| {});
        let nested = sink.clone();
        let handle = sink.cancel_handle().expect("a wired sink is cancellable");

        assert!(nested.cancelled_error().is_none());
        handle.store(true, Ordering::Relaxed);
        assert!(nested.is_cancelled());
        assert!(nested.cancelled_error().is_some());
    }
}
