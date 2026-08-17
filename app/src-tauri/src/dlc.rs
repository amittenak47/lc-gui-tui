//! Optional corpus DLC: every dataset in [`harness::dataset::DATASETS`].
//!
//! Nothing is bundled in the APK. Settings downloads a prebuilt jsonl zip
//! (GitHub release `corpora-v1` — no Hugging Face on device), unpacks, and
//! indexes.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use harness::dataset::{self, Dataset};
use harness::index;
use harness::serve::Shared;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use zip::ZipArchive;

const DLC_RELEASE: &str =
    "https://github.com/amittenak47/lc-gui-tui/releases/download/corpora-v1";

fn dlc_slugs() -> impl Iterator<Item = &'static str> {
    dataset::DATASETS.iter().map(|d| d.id)
}

fn is_dlc_slug(slug: &str) -> bool {
    dataset::DATASETS.iter().any(|d| d.id == slug)
}

fn slug_list() -> String {
    dataset::DATASETS
        .iter()
        .map(|d| d.id)
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Clone, Debug, Serialize)]
pub struct DlcStatus {
    pub slug: String,
    pub label: String,
    pub installed: bool,
    pub count: u32,
    pub phase: String,
    pub progress: f32,
    pub error: Option<String>,
}

pub struct DlcHub {
    inner: Mutex<HashMap<String, DlcStatus>>,
}

impl DlcHub {
    pub fn new() -> Self {
        let mut map = HashMap::new();
        for slug in dlc_slugs() {
            let dataset = dataset::get(slug).expect("known DLC slug");
            map.insert(
                slug.to_string(),
                DlcStatus {
                    slug: slug.to_string(),
                    label: dataset.label.to_string(),
                    installed: false,
                    count: 0,
                    phase: "idle".into(),
                    progress: 0.0,
                    error: None,
                },
            );
        }
        Self {
            inner: Mutex::new(map),
        }
    }
}

fn snapshot(hub: &DlcHub) -> Vec<DlcStatus> {
    let map = hub.inner.lock().unwrap_or_else(|e| e.into_inner());
    dlc_slugs()
        .filter_map(|slug| map.get(slug).cloned())
        .collect()
}

fn set_phase(hub: &DlcHub, slug: &str, phase: &str, progress: f32, error: Option<String>) {
    let mut map = hub.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(row) = map.get_mut(slug) {
        row.phase = phase.into();
        row.progress = progress;
        row.error = error;
    }
}

fn refresh_installed(hub: &DlcHub, slug: &str, cfg: &harness::config::Config) {
    let Ok(dataset) = dataset::get(slug) else {
        return;
    };
    let dest = dataset.corpus_dir(cfg).ok();
    let installed = dest.as_ref().is_some_and(|dir| has_corpus_files(dir));
    let count = dataset_row_count(dataset).unwrap_or(0) as u32;
    let mut map = hub.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(row) = map.get_mut(slug) {
        row.installed = installed;
        row.count = count;
        if row.phase != "downloading"
            && row.phase != "unpacking"
            && row.phase != "indexing"
        {
            row.phase = "idle".into();
            row.progress = if installed { 1.0 } else { 0.0 };
        }
    }
}

fn dataset_row_count(dataset: &Dataset) -> Result<i64, String> {
    let conn = index::open_db().map_err(|err| err.to_string())?;
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {}", dataset.table),
        [],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

fn has_corpus_files(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if has_corpus_files(&path) {
                return true;
            }
            continue;
        }
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("json" | "jsonl") => return true,
            _ => {}
        }
    }
    false
}

fn emit(app: &AppHandle) {
    if let Some(hub) = app.try_state::<DlcHub>() {
        let _ = app.emit("lc-dlc-status", snapshot(&hub));
    }
}

fn dlc_url(slug: &str) -> String {
    format!("{DLC_RELEASE}/{slug}.zip")
}

#[tauri::command]
pub async fn lc_dataset_dlc_status(
    app: AppHandle,
    hub: State<'_, DlcHub>,
    state: State<'_, Shared>,
) -> Result<Vec<DlcStatus>, String> {
    let cfg = state.cfg_snapshot();
    for slug in dlc_slugs() {
        refresh_installed(&hub, slug, &cfg);
    }
    let rows = snapshot(&hub);
    let _ = app.emit("lc-dlc-status", &rows);
    Ok(rows)
}

#[tauri::command]
pub async fn lc_dataset_dlc_install(
    app: AppHandle,
    hub: State<'_, DlcHub>,
    slug: String,
) -> Result<DlcStatus, String> {
    if !is_dlc_slug(&slug) {
        return Err(format!(
            "unknown DLC {slug:?} — expected one of {}",
            slug_list()
        ));
    }
    {
        let map = hub.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(row) = map.get(&slug) {
            if matches!(row.phase.as_str(), "downloading" | "unpacking" | "indexing") {
                return Ok(row.clone());
            }
        }
    }
    set_phase(&hub, &slug, "downloading", -1.0, None);
    emit(&app);
    let handle = app.clone();
    let slug_task = slug.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = install_one(&handle, &slug_task).await {
            if let Some(hub) = handle.try_state::<DlcHub>() {
                set_phase(&hub, &slug_task, "error", 0.0, Some(err));
            }
            emit(&handle);
        }
    });
    let map = hub.inner.lock().unwrap_or_else(|e| e.into_inner());
    Ok(map.get(&slug).cloned().expect("DLC row"))
}

#[tauri::command]
pub async fn lc_dataset_dlc_remove(
    app: AppHandle,
    hub: State<'_, DlcHub>,
    state: State<'_, Shared>,
    slug: String,
) -> Result<DlcStatus, String> {
    if !is_dlc_slug(&slug) {
        return Err(format!("unknown DLC {slug:?}"));
    }
    let dataset = dataset::get(&slug).map_err(|err| err.to_string())?;
    let cfg = state.cfg_snapshot();
    let dest = dataset.corpus_dir(&cfg).map_err(|err| err.to_string())?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|err| err.to_string())?;
    }
    index::clear_dataset(dataset).map_err(|err| err.to_string())?;
    refresh_installed(&hub, &slug, &cfg);
    set_phase(&hub, &slug, "idle", 0.0, None);
    emit(&app);
    let map = hub.inner.lock().unwrap_or_else(|e| e.into_inner());
    Ok(map.get(&slug).cloned().expect("DLC row"))
}

async fn install_one(app: &AppHandle, slug: &str) -> Result<(), String> {
    let Some(state) = app.try_state::<Shared>() else {
        return Err("harness is not running".into());
    };
    let Some(hub) = app.try_state::<DlcHub>() else {
        return Err("DLC hub missing".into());
    };
    let cfg = state.cfg_snapshot();
    let dataset = dataset::get(slug).map_err(|err| err.to_string())?;
    let dest = dataset.corpus_dir(&cfg).map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dest).map_err(|err| err.to_string())?;

    let zip_path = dest.join(format!(".{slug}.zip.part"));
    download_zip(app, slug, &zip_path).await?;

    set_phase(&hub, slug, "unpacking", -1.0, None);
    emit(app);
    extract_zip(&zip_path, &dest)?;
    let _ = std::fs::remove_file(&zip_path);

    set_phase(&hub, slug, "indexing", -1.0, None);
    emit(app);
    let cfg = cfg.clone();
    let slug_owned = slug.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        index::cmd_index(&cfg, false, Some(dataset))
            .map_err(|err| format!("index {slug_owned}: {err:#}"))
    })
    .await
    .map_err(|err| err.to_string())??;

    refresh_installed(&hub, slug, &state.cfg_snapshot());
    set_phase(&hub, slug, "idle", 1.0, None);
    emit(app);
    let _ = app.emit("lc-seed-ready", ());
    Ok(())
}

async fn download_zip(app: &AppHandle, slug: &str, dest: &Path) -> Result<(), String> {
    let url = dlc_url(slug);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|err| err.to_string())?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("download {url}: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "DLC zip missing at {url} ({}) — publish a corpora-v1 GitHub release",
            response.status()
        ));
    }
    let total = response.content_length();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = File::create(dest).map_err(|err| err.to_string())?;
    let mut written: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
        file.write_all(&chunk).map_err(|err| err.to_string())?;
        written += chunk.len() as u64;
        if let Some(hub) = app.try_state::<DlcHub>() {
            let progress = match total {
                Some(t) if t > 0 => (written as f32 / t as f32).clamp(0.0, 1.0),
                _ => -1.0,
            };
            set_phase(&hub, slug, "downloading", progress, None);
        }
        if written % (512 * 1024) < chunk.len() as u64 {
            emit(app);
        }
    }
    emit(app);
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|err| err.to_string())?;
    let file = File::open(zip_path).map_err(|err| format!("open {}: {err}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|err| err.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|err| err.to_string())?;
        let Some(name) = sanitize_zip_name(entry.name()) else {
            continue;
        };
        let out_path = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|err| err.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut out = File::create(&out_path).map_err(|err| err.to_string())?;
        io::copy(&mut entry, &mut out).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn sanitize_zip_name(name: &str) -> Option<PathBuf> {
    let trimmed = name.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for part in Path::new(trimmed).components() {
        match part {
            std::path::Component::Normal(piece) => out.push(piece),
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_zip_name;
    use std::path::PathBuf;

    #[test]
    fn zip_names_drop_traversal() {
        assert_eq!(
            sanitize_zip_name("train.jsonl"),
            Some(PathBuf::from("train.jsonl"))
        );
        assert!(sanitize_zip_name("../secret").is_none());
        assert!(sanitize_zip_name("foo/../../etc/passwd").is_none());
    }
}
