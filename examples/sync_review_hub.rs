//! Isolated real HTTP hub for browser sync regression checks. Never uses the
//! installed application's databases; the runner supplies a fresh directory.
use whiteboard::{config, serve};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = std::env::args().nth(1).expect("fresh test storage directory required");
    let root = std::path::PathBuf::from(root);
    // `--restart` reopens a directory this hub created itself (it carries the
    // marker below), so a check can stop and restart the hub on the same data.
    // Any other existing directory is still refused.
    let restart = std::env::args().nth(2).as_deref() == Some("--restart");
    let marker = root.join(".sync-review-hub");
    anyhow::ensure!(root.is_absolute(), "use a fresh absolute test directory");
    if restart {
        anyhow::ensure!(marker.is_file(), "--restart only reopens a directory this test hub created");
    } else {
        anyhow::ensure!(!root.exists(), "use a fresh absolute test directory");
        std::fs::create_dir_all(&root)?;
        std::fs::write(&marker, b"isolated sync review hub")?;
    }
    config::set_config_dir(root.clone());
    let mut cfg = config::Config::default();
    cfg.workspace.dir = root.join("workspace").display().to_string();
    let router = serve::router(serve::new_state_with_token(cfg, Some("sync-review".into())))
        .layer(tower_http::cors::CorsLayer::permissive().allow_private_network(true));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:1458").await?;
    axum::serve(listener, router).await?;
    Ok(())
}
