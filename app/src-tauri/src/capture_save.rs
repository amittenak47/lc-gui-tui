//! Persist a PNG capture into Pictures / Downloads (desktop) or MediaStore (Android).

use std::fs;
use std::path::PathBuf;

use tauri::AppHandle;
use tauri::Manager;

#[cfg(target_os = "android")]
use tauri_plugin_gallerysave::GallerySaveExt;

/// Where to put the file on disk / gallery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureDest {
    /// System Photos / Pictures gallery (default).
    Photos,
    /// Downloads folder.
    Downloads,
}

impl CaptureDest {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "downloads" | "download" => Self::Downloads,
            _ => Self::Photos,
        }
    }
}

/// Write PNG bytes. On Android + Photos, uses MediaStore so the image appears
/// in the system gallery. Elsewhere writes into Pictures or Downloads.
#[tauri::command]
pub fn save_png_bytes(
    app: AppHandle,
    bytes: Vec<u8>,
    filename: String,
    destination: Option<String>,
) -> Result<String, String> {
    let dest = CaptureDest::parse(destination.as_deref().unwrap_or("photos"));
    let name = sanitize_filename(&filename);

    #[cfg(target_os = "android")]
    {
        if dest == CaptureDest::Photos {
            if let Some(gallery) = app.gallery_save() {
                return gallery
                    .save_png(&bytes, &name)
                    .map_err(|err| err.to_string());
            }
            return Err("gallery save plugin unavailable".into());
        }
    }

    let dir = resolve_save_dir(&app, dest)?;
    fs::create_dir_all(&dir).map_err(|err| format!("create save dir: {err}"))?;
    let path = dir.join(&name);
    fs::write(&path, &bytes).map_err(|err| format!("write png: {err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn sanitize_filename(filename: &str) -> String {
    let safe = filename
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.to_ascii_lowercase().ends_with(".png") {
        safe
    } else if safe.is_empty() {
        "lc-capture.png".into()
    } else {
        format!("{safe}.png")
    }
}

fn resolve_save_dir(app: &AppHandle, dest: CaptureDest) -> Result<PathBuf, String> {
    let resolver = app.path();
    match dest {
        CaptureDest::Photos => {
            if let Ok(dir) = resolver.picture_dir() {
                return Ok(dir.join("lc"));
            }
            if let Ok(dir) = resolver.download_dir() {
                return Ok(dir);
            }
        }
        CaptureDest::Downloads => {
            if let Ok(dir) = resolver.download_dir() {
                return Ok(dir);
            }
            if let Ok(dir) = resolver.picture_dir() {
                return Ok(dir.join("lc"));
            }
        }
    }
    if let Ok(dir) = resolver.document_dir() {
        return Ok(dir.join("lc-captures"));
    }
    if let Ok(dir) = resolver.app_data_dir() {
        return Ok(dir.join("captures"));
    }
    Err("no writable capture directory".into())
}
