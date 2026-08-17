//! Android/desktop still need a writable corpus folder. Corpora themselves
//! are DLC (Settings Install) — nothing is extracted from the APK bundle.
//!
//! Pads-only builds omit this module (`--no-default-features`).

use std::path::PathBuf;

use tauri::Manager;

/// Point an unset `data.json_dir` at this app's data dir so Android has a
/// writable corpus folder (CLI still requires an explicit `data-dir`).
pub fn ensure_corpus_root(
    cfg: &mut harness::config::Config,
    app: &tauri::App,
) -> Result<PathBuf, String> {
    if let Ok(dir) = cfg.json_dir() {
        std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
        return Ok(dir);
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("corpus");
    std::fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    cfg.data.json_dir = Some(root.to_string_lossy().into_owned());
    if let Err(err) = cfg.save() {
        eprintln!("cannot persist default corpus dir: {err:#}");
    }
    Ok(root)
}
