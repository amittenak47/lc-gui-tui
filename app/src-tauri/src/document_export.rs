//! Stage exports in bounded IPC chunks; Android copies the file through SAF.
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::{Write, Seek, SeekFrom}, path::PathBuf,
    sync::{Mutex, OnceLock, atomic::{AtomicU64, Ordering}}, time::{SystemTime, UNIX_EPOCH, Instant}};
use tauri::{AppHandle, Manager};

struct Pending { path: PathBuf, file: File, name: String, mime: String, size: u64, touched: Instant }
impl Drop for Pending { fn drop(&mut self) { let _ = fs::remove_file(&self.path); } }
static EXPORTS: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn exports() -> &'static Mutex<HashMap<String, Pending>> { EXPORTS.get_or_init(Default::default) }

fn checked_name(name: &str, mime: &str) -> Result<String, String> {
    let extension = match mime { "application/pdf" => ".pdf", "application/epub+zip" => ".epub", "application/zip" => ".zip", _ => return Err("Unsupported export format".into()) };
    if !name.to_lowercase().ends_with(extension) { return Err("Export extension does not match its format".into()); }
    let safe: String = name.chars().map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
    if safe.len() > 240 || safe.starts_with('.') { return Err("Choose a shorter document name".into()); }
    Ok(safe)
}

#[tauri::command]
pub async fn begin_document_export(app: AppHandle, filename: String, mime: String) -> Result<String, String> {
    let name = checked_name(&filename, &mime)?;
    let mut pending = exports().lock().map_err(|e| e.to_string())?;
    pending.retain(|_, p| p.touched.elapsed().as_secs() < 1800);
    if !pending.is_empty() { return Err("Another document is still being saved".into()); }
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("document-exports");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = format!("{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos(), SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let path = dir.join(&id);
    let file = OpenOptions::new().read(true).write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    pending.insert(id.clone(), Pending { path, file, name, mime, size: 0, touched: Instant::now() });
    Ok(id)
}

#[tauri::command]
pub async fn append_document_export(id: String, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    let mut pending = exports().lock().map_err(|e| e.to_string())?;
    let p = pending.get_mut(&id).ok_or("Export expired; try again")?;
    if bytes.len() > 262_144 || offset != p.size || p.size + bytes.len() as u64 > 1_073_741_824 { return Err("Invalid export chunk".into()); }
    p.file.write_all(&bytes).map_err(|e| e.to_string())?;
    p.size += bytes.len() as u64; p.touched = Instant::now();
    Ok(())
}

#[tauri::command]
pub async fn cancel_document_export(id: String) -> Result<(), String> {
    exports().lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn finish_document_export(app: AppHandle, id: String, size: u64) -> Result<String, String> {
    let mut p = exports().lock().map_err(|e| e.to_string())?.remove(&id).ok_or("Export expired; try again")?;
    if size == 0 || p.size != size { return Err("Export is incomplete".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        p.file.flush().map_err(|e| e.to_string())?;
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_gallerysave::GallerySaveExt;
            app.gallery_save().ok_or("File save plugin unavailable")?
                .save_document(&p.path.to_string_lossy(), &p.name, &p.mime).map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = &p.mime;
            let dir = app.path().download_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            for suffix in 0..10000 {
                let name = if suffix == 0 { p.name.clone() } else { let (stem, ext) = p.name.rsplit_once('.').ok_or("Missing file extension")?; format!("{stem} ({suffix}).{ext}") };
                let path = dir.join(name);
                match OpenOptions::new().write(true).create_new(true).open(&path) {
                    Ok(mut output) => {
                        p.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
                        if let Err(e) = std::io::copy(&mut p.file, &mut output).and_then(|_| output.flush()) { drop(output); let _ = fs::remove_file(&path); return Err(e.to_string()); }
                        return Ok(path.to_string_lossy().into_owned());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err("Too many exports with this name".into())
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn filenames_cannot_escape_downloads() {
        assert!(checked_name("../../file.pdf", "application/pdf").is_err());
        assert_eq!(checked_name("D:\\book.pdf", "application/pdf").unwrap(), "D__book.pdf");
        assert!(checked_name("book.exe", "application/pdf").is_err());
    }
}
