//! `WS /coach/session` — Mode B, the ambient coach.
//!
//! The 15-second cadence lives on the *client*: it hashes the scene, skips
//! unchanged boards, and only then sends a frame. That is the main cost
//! control, and it means an idle board costs nothing at all. The server's job
//! is the part the client cannot do: hold the "already said" ladder so the
//! coach escalates instead of repeating itself, and re-check the fingerprint as
//! a backstop against a client that forgets to.

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use super::routes::{description_for, load_meta};
use super::{AppError, Shared};
use crate::llm::coach::{build_ambient_prompt, parse_ambient, AmbientNudge, BoardSnapshot};
use crate::llm::{make_provider_for_mode, ChatMessage, ChatRequest, LlmProvider};

/// Frames the client sends.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    /// Opens the session and names the problem on the board.
    Hello {
        session_id: String,
        task_id: String,
    },
    /// A board snapshot worth looking at. The client only sends these when its
    /// own scene hash changed and enough new strokes accumulated.
    Snapshot {
        session_id: String,
        task_id: String,
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
    Error { message: String },
}

pub async fn session(
    State(state): State<Shared>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, AppError> {
    Ok(upgrade.on_upgrade(move |socket| drive(state, socket)))
}

async fn drive(state: Shared, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

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
                let _ = send(&mut sink, ServerFrame::Error {
                    message: format!("cannot parse frame: {err}"),
                })
                .await;
                continue;
            }
        };

        let reply = handle(&state, frame).await;
        let closed = send(&mut sink, reply).await.is_err();
        if closed {
            break;
        }
    }
}

async fn handle(state: &Shared, frame: ClientFrame) -> ServerFrame {
    match frame {
        ClientFrame::Hello {
            session_id,
            task_id,
        } => {
            let nudges_so_far = {
                let mut sessions = state.sessions.lock().await;
                sessions.entry(&session_id, &task_id).nudges_so_far()
            };
            let provider = crate::llm::make_provider_for_mode(&state.cfg, "ambient")
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

        ClientFrame::Snapshot {
            session_id,
            task_id,
            scene_hash,
            board,
        } => {
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

            match ambient_nudge(state, &task_id, board, already_said, nudges_so_far).await {
                Ok(nudge) => {
                    let mut sessions = state.sessions.lock().await;
                    let session = sessions.entry(&session_id, &task_id);
                    session.record_nudge(nudge.nudge.clone());
                    ServerFrame::Nudge {
                        nudges_so_far: session.nudges_so_far(),
                        nudge,
                    }
                }
                Err(err) => ServerFrame::Error {
                    message: format!("{err:#}"),
                },
            }
        }
    }
}

async fn ambient_nudge(
    state: &Shared,
    task_id: &str,
    board: BoardSnapshot,
    already_said: Vec<String>,
    nudges_so_far: u32,
) -> Result<AmbientNudge> {
    let cfg = state.cfg.clone();
    let task_id = task_id.to_string();
    tokio::task::spawn_blocking(move || {
        let meta = load_meta(&cfg, &task_id)?;
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
}
