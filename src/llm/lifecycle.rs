//! Start / stop the local OpenAI-compatible LLM process (typically `ollama serve`).
//!
//! Shared by the harness HTTP handlers and the TUI Settings menu so both UIs drive
//! the same child process bookkeeping.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::config::Config;

/// Process we spawned via [`start_local_llm`]. External Ollama instances we did
/// not start are never killed on stop.
pub static OWNED_LLM_CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
pub struct LlmStatus {
    pub running: bool,
    pub base_url: String,
    pub pid: Option<u32>,
    /// True when `lc` started the process (so Stop will kill it).
    pub owned: bool,
    pub detail: String,
}

/// Probe the configured local base URL. Ollama exposes `/api/tags` without the
/// `/v1` suffix; OpenAI-compat servers usually answer `/models`.
pub fn probe_reachable(base_url: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let root = base_url.trim_end_matches('/').trim_end_matches("/v1");
    for path in ["/api/tags", "/v1/models", "/models"] {
        let url = format!("{root}{path}");
        if client.get(&url).send().map(|r| r.status().is_success()).unwrap_or(false) {
            return true;
        }
    }
    false
}

pub fn status(cfg: &Config) -> LlmStatus {
    let base_url = cfg.llm.local.base_url.clone();
    let reachable = probe_reachable(&base_url);
    let mut guard = OWNED_LLM_CHILD.lock().unwrap_or_else(|e| e.into_inner());
    // Reap exited children.
    if let Some(child) = guard.as_mut() {
        if let Ok(Some(_)) = child.try_wait() {
            *guard = None;
        }
    }
    let (pid, owned) = match guard.as_ref() {
        Some(child) => (Some(child.id()), true),
        None => (None, false),
    };
    let detail = if reachable {
        if owned {
            "local LLM reachable (started by lc)".into()
        } else {
            "local LLM reachable (external process)".into()
        }
    } else if owned {
        "started by lc but not reachable yet".into()
    } else {
        "local LLM not reachable".into()
    };
    LlmStatus {
        running: reachable || owned,
        base_url,
        pid,
        owned,
        detail,
    }
}

pub fn start_local_llm(cfg: &Config) -> Result<LlmStatus> {
    let base_url = cfg.llm.local.base_url.clone();
    if probe_reachable(&base_url) {
        return Ok(status(cfg));
    }

    let mut guard = OWNED_LLM_CHILD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.as_mut() {
        if let Ok(None) = child.try_wait() {
            // Still running; give it a moment.
            drop(guard);
            std::thread::sleep(Duration::from_millis(500));
            return Ok(status(cfg));
        }
        *guard = None;
    }

    let mut cmd = Command::new("ollama");
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .context("cannot spawn `ollama serve` — is Ollama installed and on PATH?")?;
    *guard = Some(child);
    drop(guard);

    // Brief wait so a healthy probe can succeed immediately after start.
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(300));
        if probe_reachable(&base_url) {
            break;
        }
    }
    Ok(status(cfg))
}

pub fn stop_local_llm(cfg: &Config) -> Result<LlmStatus> {
    let mut guard = OWNED_LLM_CHILD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        drop(guard);
        return Ok(status(cfg));
    }
    drop(guard);
    if probe_reachable(&cfg.llm.local.base_url) {
        bail!(
            "a local LLM is running but was not started by lc — stop it yourself \
             (e.g. quit Ollama) so we do not kill an unrelated process"
        );
    }
    Ok(status(cfg))
}
