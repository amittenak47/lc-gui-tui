//! `WS /coach/session` — Mode B (the ambient coach) and interactive runs.
//!
//! The 15-second cadence lives on the *client*: it hashes the scene, skips
//! unchanged boards, and only then sends a frame. That is the main cost
//! control, and it means an idle board costs nothing at all. The server's job
//! is the part the client cannot do: hold the "already said" ladder so the
//! coach escalates instead of repeating itself, and re-check the fingerprint as
//! a backstop against a client that forgets to.
//!
//! ## Interactive runs
//!
//! Ask / Review / Draw / Lazy also arrive here, as [`ClientFrame::Run`] frames
//! carrying a client-generated `request_id`. They exist because the answer is
//! not the only thing worth sending: a staged review makes three or four
//! blocking model calls, and until now the chat filled that silence with a
//! timer that guessed at the phases. Now each stage boundary is a real frame.
//!
//! Two frames share one socket, so routing is by `request_id`: interactive
//! frames always carry it, ambient frames never do. One run is allowed in
//! flight per socket; a second is refused rather than queued, because the
//! client that sent it has one composer and one placeholder turn to fill.
//!
//! `POST /coach/*` stays as it was — same handlers, same envelopes, just
//! [`EventSink::none`] instead of a live sink.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{self, UnboundedSender};

use super::common::{description_for, load_meta};
use super::{board_session, coach, viz, AppError, Shared};
use crate::llm::coach::{
    build_ambient_prompt, parse_ambient, AmbientNudge, BoardSnapshot, CoachEvent, EventSink,
};
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest, LlmProvider};

/// What an interactive `run` frame is asking for. Bridge / Reveal are
/// deliberately absent: they sit behind a confirmation dialog and stay on HTTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunAction {
    Ask,
    Review,
    Viz,
    Lazy,
    /// The post-render check on a diagram the client already drew.
    DrawReview,
}

impl RunAction {
    fn as_str(self) -> &'static str {
        match self {
            RunAction::Ask => "ask",
            RunAction::Review => "review",
            RunAction::Viz => "viz",
            RunAction::Lazy => "lazy",
            RunAction::DrawReview => "draw_review",
        }
    }
}

/// Frames the client sends.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    /// Opens the session and names the problem on the board.
    Hello {
        session_id: String,
        task_id: String,
        #[serde(default)]
        dataset: Option<String>,
    },
    /// One interactive coach job. `payload` is the same body the matching
    /// `POST /coach/*` endpoint takes, so the two transports cannot diverge.
    Run {
        request_id: String,
        action: RunAction,
        #[serde(default)]
        payload: serde_json::Value,
    },
    /// Stop the run with this id. Late stages are dropped; no `result` follows.
    Cancel { request_id: String },
    /// A board snapshot worth looking at. The client only sends these when its
    /// own scene hash changed and enough new strokes accumulated.
    Snapshot {
        session_id: String,
        task_id: String,
        #[serde(default)]
        dataset: Option<String>,
        /// Fingerprint of the scene, from Excalidraw's element version counters.
        scene_hash: u64,
        #[serde(flatten)]
        board: BoardSnapshot,
    },
    /// Drop the escalation ladder for this session.
    Reset { session_id: String },
}

/// Frames the server sends.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Ready {
        session_id: String,
        task_id: String,
        provider: String,
        nudges_so_far: u32,
    },
    /// The board did not change; nothing was sent to a model.
    Skipped { reason: String },
    /// The coach is thinking, so the panel can show it without blocking the pen.
    Thinking,
    Nudge {
        #[serde(flatten)]
        nudge: AmbientNudge,
        nudges_so_far: u32,
    },
    /// An interactive run entered a named stage. `detail` is a short human
    /// string; the client is free to show its own label for a known stage.
    Stage {
        request_id: String,
        stage: String,
        detail: String,
    },
    /// One diagram tool call, as it was proposed / accepted / dropped.
    ToolEvent {
        request_id: String,
        name: String,
        status: String,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// The finished run. `body` is the same envelope `POST /coach/<action>`
    /// returns, unchanged.
    Result {
        request_id: String,
        action: String,
        body: serde_json::Value,
    },
    Error {
        /// Present for interactive failures, absent for ambient ones — that is
        /// how the client knows which turn to put the message on.
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        message: String,
    },
}

impl ServerFrame {
    fn ambient_error(message: impl Into<String>) -> Self {
        ServerFrame::Error {
            request_id: None,
            message: message.into(),
        }
    }
}

pub async fn session(
    State(state): State<Shared>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, AppError> {
    Ok(upgrade.on_upgrade(move |socket| drive(state, socket)))
}

/// The interactive run this socket is currently working on.
struct InFlight {
    request_id: String,
    cancel: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl InFlight {
    /// Stop the run and forget it. The flag is what a stage boundary checks;
    /// the abort is what stops the task if it is waiting on the blocking pool
    /// handoff rather than inside a provider call.
    fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.task.abort();
    }
}

async fn drive(state: Shared, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    // Outgoing frames go through a channel so a run's stage events can be
    // written while the read loop is still waiting for the next client frame.
    let (outgoing, mut queued) = mpsc::unbounded_channel::<ServerFrame>();
    let writer = tokio::spawn(async move {
        while let Some(frame) = queued.recv().await {
            if send(&mut sink, frame).await.is_err() {
                break;
            }
        }
    });

    let mut in_flight: Option<InFlight> = None;
    // The glance in progress, if any — see the `Snapshot` arm below.
    let mut ambient: Option<tokio::task::JoinHandle<()>> = None;

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            // Ping/Pong are handled by axum; binary frames aren't part of the
            // protocol.
            _ => continue,
        };

        let frame: ClientFrame = match serde_json::from_str(&text) {
            Ok(frame) => frame,
            Err(err) => {
                let _ = outgoing.send(ServerFrame::ambient_error(format!(
                    "cannot parse frame: {err}"
                )));
                continue;
            }
        };

        match frame {
            ClientFrame::Cancel { request_id } => {
                if let Some(running) = in_flight.take_if_matching(&request_id) {
                    running.cancel();
                    let _ = outgoing.send(ServerFrame::Error {
                        request_id: Some(request_id),
                        message: "cancelled".into(),
                    });
                }
            }

            ClientFrame::Run {
                request_id,
                action,
                payload,
            } => {
                // One composer, one placeholder turn: a second run while one is
                // working is a mistake to report, not work to queue.
                if in_flight.as_ref().is_some_and(|run| !run.task.is_finished()) {
                    let _ = outgoing.send(ServerFrame::Error {
                        request_id: Some(request_id),
                        message: "busy — the coach is still working on the previous request".into(),
                    });
                    continue;
                }
                in_flight = Some(spawn_run(
                    state.clone(),
                    outgoing.clone(),
                    request_id,
                    action,
                    payload,
                ));
            }

            /*
             * An ambient glance must not stop the socket being read.
             *
             * This used to be awaited inline, on the grounds that the
             * escalation ladder is read and written per nudge and two at once
             * would order it wrongly. That is true, and it is not what awaiting
             * here bought: `ambient_nudge` calls a model, whose HTTP client
             * allows three minutes, and for all of that the loop above is not
             * reading. A `run` frame sent during a glance therefore sat unread
             * in the socket buffer — no stage frames, no error, nothing to
             * cancel — which is a chat turn stuck on "Working…" for as long as
             * the glance takes. Annotate makes it likely rather than rare: the
             * board export delays the send by seconds, straight into the
             * window where a tick is already in flight.
             *
             * Still one at a time. A snapshot that lands while one is running
             * is skipped, which is what the client's own gate already does and
             * exactly what `Skipped` exists to say.
             */
            frame @ ClientFrame::Snapshot { .. } => {
                if ambient.as_ref().is_some_and(|task| !task.is_finished()) {
                    let _ = outgoing.send(ServerFrame::Skipped {
                        reason: "still looking at the last board".into(),
                    });
                    continue;
                }
                let state = state.clone();
                let outgoing = outgoing.clone();
                ambient = Some(tokio::spawn(async move {
                    let reply = handle(&state, frame).await;
                    let _ = outgoing.send(reply);
                }));
            }

            // Hello and Reset answer from memory and a lock — cheap enough to
            // stay on the loop, and Hello owes its `ready` before anything else.
            other => {
                let reply = handle(&state, other).await;
                if outgoing.send(reply).is_err() {
                    break;
                }
            }
        }
    }

    // A dropped connection is an implicit cancel: no `result` frame is owed to
    // a client that is no longer there, and a glance answering into a closed
    // socket is a model call nobody will read.
    if let Some(running) = in_flight {
        running.cancel();
    }
    if let Some(glance) = ambient {
        glance.abort();
    }
    drop(outgoing);
    let _ = writer.await;
}

/// `Option<InFlight>::take()`, but only for the run the client named — a stale
/// `cancel` for a finished request must not stop the one that replaced it.
trait TakeIfMatching {
    fn take_if_matching(&mut self, request_id: &str) -> Option<InFlight>;
}

impl TakeIfMatching for Option<InFlight> {
    fn take_if_matching(&mut self, request_id: &str) -> Option<InFlight> {
        if self.as_ref().is_some_and(|run| run.request_id == request_id) {
            self.take()
        } else {
            None
        }
    }
}

fn spawn_run(
    state: Shared,
    outgoing: UnboundedSender<ServerFrame>,
    request_id: String,
    action: RunAction,
    payload: serde_json::Value,
) -> InFlight {
    let events = run_event_sink(outgoing.clone(), request_id.clone());
    let cancel = events
        .cancel_handle()
        .expect("a wired sink is always cancellable");

    let task = tokio::spawn({
        let request_id = request_id.clone();
        async move {
            let outcome = run_action(&state, action, payload, events.clone()).await;
            // A run that was cancelled already had its `error` frame sent, and
            // whatever it produced afterwards is for a turn the client closed.
            if events.is_cancelled() {
                return;
            }
            let _ = outgoing.send(match outcome {
                Ok(body) => ServerFrame::Result {
                    request_id,
                    action: action.as_str().to_string(),
                    body,
                },
                Err(err) => ServerFrame::Error {
                    request_id: Some(request_id),
                    message: err.message(),
                },
            });
        }
    });

    InFlight {
        request_id,
        cancel,
        task,
    }
}

/// Translate pipeline events into frames for one request id.
fn run_event_sink(outgoing: UnboundedSender<ServerFrame>, request_id: String) -> EventSink {
    EventSink::new(move |event| {
        let frame = match event {
            CoachEvent::Stage { stage, detail } => ServerFrame::Stage {
                request_id: request_id.clone(),
                stage,
                detail,
            },
            CoachEvent::Tool {
                name,
                status,
                summary,
                reason,
            } => ServerFrame::ToolEvent {
                request_id: request_id.clone(),
                name,
                status: status.as_str().to_string(),
                summary,
                reason,
            },
        };
        // A closed receiver means the socket is gone; the cancel flag is what
        // actually stops the run, so dropping the frame here is right.
        let _ = outgoing.send(frame);
    })
}

/// Dispatch to the same handler body the HTTP route uses.
async fn run_action(
    state: &Shared,
    action: RunAction,
    payload: serde_json::Value,
    events: EventSink,
) -> Result<serde_json::Value, AppError> {
    fn parse<T: serde::de::DeserializeOwned>(
        payload: serde_json::Value,
        what: &str,
    ) -> Result<T, AppError> {
        serde_json::from_value(payload).map_err(|err| {
            AppError::bad_request(anyhow::anyhow!("cannot read the {what} payload: {err}"))
        })
    }

    let body = match action {
        RunAction::Ask => {
            let envelope = coach::run_ask(state, parse(payload, "ask")?, events).await?;
            serde_json::to_value(envelope)
        }
        RunAction::Review => {
            let envelope = coach::run_review(state, parse(payload, "review")?, events).await?;
            serde_json::to_value(envelope)
        }
        RunAction::Viz => {
            let envelope = viz::run_viz(state, parse(payload, "viz")?, events).await?;
            serde_json::to_value(envelope)
        }
        RunAction::Lazy => {
            let envelope = coach::run_lazy_fill(state, parse(payload, "lazy")?, events).await?;
            serde_json::to_value(envelope)
        }
        RunAction::DrawReview => {
            let envelope =
                viz::run_draw_review(state, parse(payload, "draw review")?, events).await?;
            serde_json::to_value(envelope)
        }
    };
    Ok(body.map_err(anyhow::Error::from)?)
}

async fn handle(state: &Shared, frame: ClientFrame) -> ServerFrame {
    match frame {
        ClientFrame::Hello {
            session_id,
            task_id,
            dataset: _,
        } => {
            let nudges_so_far = {
                let mut sessions = state.sessions.lock().await;
                sessions.entry(&session_id, &task_id).nudges_so_far()
            };
            let provider = crate::llm::make_provider_for_mode(&state.cfg_snapshot(), "ambient")
                .map(|p| p.label())
                .unwrap_or_else(|err| format!("unavailable: {err:#}"));
            ServerFrame::Ready {
                session_id,
                task_id,
                provider,
                nudges_so_far,
            }
        }

        ClientFrame::Reset { session_id } => {
            state.sessions.lock().await.end(&session_id);
            ServerFrame::Skipped {
                reason: "session reset".into(),
            }
        }

        ClientFrame::Run { .. } | ClientFrame::Cancel { .. } => {
            unreachable!("interactive frames are dispatched in `drive`, not here")
        }

        ClientFrame::Snapshot {
            session_id,
            task_id,
            dataset,
            scene_hash,
            board,
        } => {
            let dataset = match crate::dataset::resolve(dataset.as_deref()) {
                Ok(dataset) => dataset,
                Err(err) => return ServerFrame::ambient_error(format!("{err:#}")),
            };
            let mut board = board;
            {
                let mut store = state.board_sessions.lock().await;
                let session = store.entry(&dataset.key(&task_id));
                board = board_session::resolve_board_snapshot(session, board);
                if let Some(pseudo) = board_session::resolve_pseudocode(session, &board) {
                    board.pseudocode = Some(pseudo);
                }
            }

            if board.is_empty() {
                return ServerFrame::Skipped {
                    reason: "nothing recognized on the board yet".into(),
                };
            }

            // Backstop for the client's own skip-if-unchanged check, and the
            // point where we read the ladder.
            let (already_said, nudges_so_far) = {
                let mut sessions = state.sessions.lock().await;
                let session = sessions.entry(&session_id, &task_id);
                if !session.scene_changed(scene_hash) {
                    return ServerFrame::Skipped {
                        reason: "board unchanged since the last look".into(),
                    };
                }
                (session.said.clone(), session.nudges_so_far())
            };

            match ambient_nudge(state, dataset, &task_id, board, already_said, nudges_so_far).await {
                Ok(nudge) => {
                    let mut sessions = state.sessions.lock().await;
                    let session = sessions.entry(&session_id, &task_id);
                    session.record_nudge(nudge.nudge.clone());
                    ServerFrame::Nudge {
                        nudges_so_far: session.nudges_so_far(),
                        nudge,
                    }
                }
                Err(err) => ServerFrame::ambient_error(format!("{err:#}")),
            }
        }
    }
}

async fn ambient_nudge(
    state: &Shared,
    dataset: &'static crate::dataset::Dataset,
    task_id: &str,
    board: BoardSnapshot,
    already_said: Vec<String>,
    nudges_so_far: u32,
) -> Result<AmbientNudge> {
    let cfg = state.cfg_snapshot();
    let task_id = task_id.to_string();
    tokio::task::spawn_blocking(move || {
        let meta = load_meta(&cfg, dataset, &task_id)?;
        let description = description_for(&meta);
        let prompt = build_ambient_prompt(
            &meta,
            description.as_deref(),
            &board,
            &already_said,
            nudges_so_far,
        );
        let provider: Box<dyn LlmProvider> = make_provider_for_mode(&cfg, "ambient")?;
        let messages = vec![
            ChatMessage::system(crate::llm::coach::AMBIENT_SYSTEM_PROMPT),
            ChatMessage::user(prompt).with_images(board.images()),
        ];
        // Short cap: this runs every 15s and a glance should stay a glance.
        let request = ChatRequest::new(messages)
            .json()
            .with_temperature(0.3)
            .with_max_tokens(300);
        let reply = provider.chat_ex(&request)?;
        parse_ambient(&reply.content)
    })
    .await
    .context("the ambient coach task panicked")?
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frame: ServerFrame,
) -> Result<()> {
    let text = serde_json::to_string(&frame)?;
    sink.send(Message::Text(text)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_frames_are_tagged_by_type() {
        let raw = r#"{"type": "snapshot", "session_id": "s1", "task_id": "two-sum",
                      "scene_hash": 99, "recognized_text": "two pointers"}"#;
        match serde_json::from_str::<ClientFrame>(raw).unwrap() {
            ClientFrame::Run { .. } | ClientFrame::Cancel { .. } => {
            unreachable!("interactive frames are dispatched in `drive`, not here")
        }

        ClientFrame::Snapshot {
                scene_hash, board, ..
            } => {
                assert_eq!(scene_hash, 99);
                assert_eq!(board.recognized_text, "two pointers");
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[test]
    fn server_frames_flatten_the_nudge() {
        let frame = ServerFrame::Nudge {
            nudge: AmbientNudge {
                confidence: 0.8,
                guessed_approach: "hash map".into(),
                closeness: "warm".into(),
                nudge: "what happens with duplicates?".into(),
            },
            nudges_so_far: 1,
        };
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(json["type"], "nudge");
        assert_eq!(json["closeness"], "warm");
        assert_eq!(json["nudges_so_far"], 1);
    }

    #[test]
    fn a_run_frame_carries_its_action_and_the_http_body_verbatim() {
        let raw = r#"{"type": "run", "request_id": "r-1", "action": "review",
                      "payload": {"task_id": "two-sum", "recognized_text": "hash map"}}"#;
        match serde_json::from_str::<ClientFrame>(raw).unwrap() {
            ClientFrame::Run {
                request_id,
                action,
                payload,
            } => {
                assert_eq!(request_id, "r-1");
                assert_eq!(action, RunAction::Review);
                // The payload is the `POST /coach/review` body, so it must
                // deserialize into the very struct that route takes.
                let request: coach::ReviewRequest = serde_json::from_value(payload).unwrap();
                assert_eq!(request.task_id, "two-sum");
                assert_eq!(request.board.recognized_text, "hash map");
            }
            other => panic!("expected a run, got {other:?}"),
        }

        assert!(
            serde_json::from_str::<ClientFrame>(
                r#"{"type": "run", "request_id": "r-2", "action": "bridge", "payload": {}}"#
            )
            .is_err(),
            "bridge stays behind the confirm dialog on HTTP — it is not a run action"
        );
    }

    /// The routing rule the client depends on: every interactive frame names
    /// its request, and no ambient frame does. Without that, a nudge that
    /// happens to land mid-review would overwrite the review's placeholder.
    #[test]
    fn interactive_frames_carry_a_request_id_and_ambient_frames_do_not() {
        let json = |frame: &ServerFrame| -> serde_json::Value {
            serde_json::from_str(&serde_json::to_string(frame).unwrap()).unwrap()
        };

        let stage = json(&ServerFrame::Stage {
            request_id: "r-1".into(),
            stage: "claim".into(),
            detail: "naming the approach".into(),
        });
        assert_eq!(stage["type"], "stage");
        assert_eq!(stage["request_id"], "r-1");

        let tool = json(&ServerFrame::ToolEvent {
            request_id: "r-1".into(),
            name: "draw_structure".into(),
            status: "rejected".into(),
            summary: "array".into(),
            reason: Some("no frames".into()),
        });
        assert_eq!(tool["status"], "rejected");
        assert_eq!(tool["reason"], "no frames");

        let result = json(&ServerFrame::Result {
            request_id: "r-1".into(),
            action: "review".into(),
            body: serde_json::json!({"verdict": "on_track"}),
        });
        assert_eq!(result["type"], "result");
        assert_eq!(result["body"]["verdict"], "on_track");

        let interactive_error = json(&ServerFrame::Error {
            request_id: Some("r-1".into()),
            message: "busy".into(),
        });
        assert_eq!(interactive_error["request_id"], "r-1");

        let ambient_error = json(&ServerFrame::ambient_error("the model is down"));
        assert_eq!(ambient_error["type"], "error");
        assert!(
            ambient_error.get("request_id").is_none(),
            "an ambient failure belongs to no chat turn: {ambient_error}"
        );
        assert!(json(&ServerFrame::Thinking).get("request_id").is_none());
    }

    /// A `cancel` naming a request that already finished must not stop the run
    /// that replaced it — the ids are the only thing keeping them apart.
    #[test]
    fn cancel_only_takes_the_run_it_names() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("a runtime to hang the join handle off");
        let run = |request_id: &str| InFlight {
            request_id: request_id.into(),
            cancel: Arc::new(AtomicBool::new(false)),
            task: runtime.spawn(std::future::ready(())),
        };

        let mut in_flight = Some(run("r-2"));
        assert!(in_flight.take_if_matching("r-1").is_none());
        assert!(in_flight.is_some(), "the live run survives a stale cancel");

        let taken = in_flight.take_if_matching("r-2").expect("its own cancel lands");
        taken.cancel();
        assert!(taken.cancel.load(Ordering::Relaxed));
        assert!(in_flight.is_none());
    }
}
