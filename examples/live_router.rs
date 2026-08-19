//! Bind the in-process router on a loopback port so the agent endpoints can be
//! driven from curl / a WebSocket client during manual testing.
//!
//! ```bash
//! cargo run --example live_router -- 7979
//! ```
//!
//! Not a product surface: the desktop window and the APK dispatch in-process
//! and never bind. This exists so `POST /coach/*` and `WS /coach/session` can
//! be exercised against a real model without a GUI.

use anyhow::Result;
use whiteboard::config::Config;
use whiteboard::serve;

#[tokio::main]
async fn main() -> Result<()> {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(7979);
    let mut cfg = Config::load()?;
    // Loopback only, no pairing: the token exists for the LAN pad hub.
    cfg.serve.token = None;
    // LC_CFG_SET="coach.planner_enabled=true,coach.draw_review_enabled=false"
    if let Ok(overrides) = std::env::var("LC_CFG_SET") {
        for pair in overrides.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| anyhow::anyhow!("LC_CFG_SET wants key=value, got {pair:?}"))?;
            cfg.set(key.trim(), value.trim())?;
            eprintln!("override {} = {}", key.trim(), value.trim());
        }
    }
    eprintln!(
        "provider={} model={} base_url={} vision={:?}",
        cfg.llm.default_provider,
        cfg.llm.local.model,
        cfg.llm.local.base_url,
        cfg.llm.local.vision
    );
    eprintln!("listening on http://127.0.0.1:{port}");
    let state = serve::new_state(cfg);
    serve::listen_lan(state, port).await
}
