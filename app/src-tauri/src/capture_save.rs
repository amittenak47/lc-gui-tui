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
    /// A directory the student named in Settings.
    Folder,
}

impl CaptureDest {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "downloads" | "download" => Self::Downloads,
            "folder" | "custom" => Self::Folder,
            _ => Self::Photos,
        }
    }
}

/// Write PNG bytes and return where they landed. On Android + Photos, uses
/// MediaStore so the image appears in the system gallery. Elsewhere writes into
/// Pictures, Downloads, or the directory the student named.
///
/// The returned path is not decoration: the frontend reads it back into the
/// capture toast, which is the only way to find out where a capture went
/// without going looking for it.
#[tauri::command]
pub fn save_png_bytes(
    app: AppHandle,
    bytes: Vec<u8>,
    filename: String,
    destination: Option<String>,
    directory: Option<String>,
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

    let dir = match dest {
        CaptureDest::Folder => {
            let raw = directory.unwrap_or_default();
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("no capture folder set".into());
            }
            PathBuf::from(shellexpand_home(trimmed))
        }
        _ => resolve_save_dir(&app, dest)?,
    };
    fs::create_dir_all(&dir).map_err(|err| format!("create save dir: {err}"))?;
    let path = dir.join(&name);
    fs::write(&path, &bytes).map_err(|err| format!("write png: {err}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Expand a leading `~` so a typed path behaves the way a shell would.
fn shellexpand_home(path: &str) -> String {
    let Some(rest) = path.strip_prefix('~') else {
        return path.to_string();
    };
    let Some(home) = home_dir() else {
        return path.to_string();
    };
    let rest = rest.trim_start_matches(['/', '\\']);
    if rest.is_empty() {
        return home.to_string_lossy().into_owned();
    }
    home.join(rest).to_string_lossy().into_owned()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
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
        CaptureDest::Downloads | CaptureDest::Folder => {
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

/// Hand a PNG to the platform's share sheet.
///
/// Android only. The frontend cannot use `navigator.share`: the WebView is
/// served over cleartext http (Annotate fetches), and the Web Share API is
/// Share API is gated on a secure context, so it is undefined there. Desktop
/// has no equivalent worth faking — the error is the frontend's cue to save a
/// file and say where it went instead.
#[tauri::command]
pub fn share_png_bytes(
    app: AppHandle,
    // Not named `base64`: that would sit next to the crate of the same name in
    // the one function that uses it.
    payload: String,
    filename: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.as_bytes())
            .map_err(|err| format!("invalid png base64: {err}"))?;
        let name = sanitize_filename(&filename);
        let Some(gallery) = app.gallery_save() else {
            return Err("gallery save plugin unavailable".into());
        };
        return gallery
            .share_png(&bytes, &name)
            .map_err(|err| err.to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, payload, filename);
        Err("share sheet is only available on Android".into())
    }
}
