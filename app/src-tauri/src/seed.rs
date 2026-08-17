//! First-run extract of bundled `leetcode` + `leetcode-with-tests` jsonl.
//!
//! Pads-only builds omit this module (`--no-default-features`). Missing zip
//! files are a no-op so a local `tauri dev` without packed corpora still boots.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use harness::dataset::{self, Dataset};
use harness::index;
use harness::serve::Shared;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

const SEED_SLUGS: &[&str] = &["leetcode", "leetcode-with-tests"];

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

pub fn spawn(app: &tauri::App) {
    let handle = app.handle().clone();
    if let Err(err) = std::thread::Builder::new()
        .name("lc-seed-corpora".into())
        .spawn(move || {
            match run(&handle) {
                Ok(true) => {
                    if let Err(err) = handle.emit("lc-seed-ready", ()) {
                        eprintln!("lc-seed-ready emit: {err}");
                    }
                }
                Ok(false) => {}
                Err(err) => eprintln!("seed corpora: {err}"),
            }
        })
    {
        eprintln!("cannot spawn seed thread: {err}");
    }
}

/// Extract missing seed zips and index empty tables. `true` when the GUI
/// should refetch problem lists.
fn run(app: &AppHandle) -> Result<bool, String> {
    let Some(state) = app.try_state::<Shared>() else {
        return Ok(false);
    };
    let cfg = state.cfg_snapshot();
    let mut changed = false;

    for slug in SEED_SLUGS {
        let dataset = dataset::get(slug).map_err(|err| err.to_string())?;
        let dest = dataset.corpus_dir(&cfg).map_err(|err| err.to_string())?;
        if !has_corpus_files(&dest) {
            if let Some(zip_path) = find_seed_zip(app, slug) {
                eprintln!("seed: extracting {} from {}", slug, zip_path.display());
                extract_zip(&zip_path, &dest)?;
                changed = true;
            } else {
                eprintln!("seed: no bundled zip for {slug} (pack with scripts/pack_seed_corpora.py)");
                continue;
            }
        }
        if !has_corpus_files(&dest) {
            continue;
        }
        if dataset_row_count(dataset)? == 0 {
            eprintln!("seed: indexing {slug} from {}", dest.display());
            index::cmd_index(&cfg, false, Some(dataset)).map_err(|err| err.to_string())?;
            changed = true;
        }
    }
    Ok(changed)
}

fn dataset_row_count(dataset: &Dataset) -> Result<i64, String> {
    let conn = index::open_db().map_err(|err| err.to_string())?;
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", dataset.table), [], |row| {
        row.get(0)
    })
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

fn find_seed_zip(app: &AppHandle, slug: &str) -> Option<PathBuf> {
    let rels = [
        format!("corpora/{slug}.zip"),
        format!("resources/corpora/{slug}.zip"),
    ];
    for rel in rels {
        if let Ok(path) = app.path().resolve(&rel, BaseDirectory::Resource) {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Ok(root) = app.path().resource_dir() {
        for rel in [
            root.join("corpora").join(format!("{slug}.zip")),
            root.join("resources").join("corpora").join(format!("{slug}.zip")),
        ] {
            if rel.is_file() {
                return Some(rel);
            }
        }
    }
    None
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
