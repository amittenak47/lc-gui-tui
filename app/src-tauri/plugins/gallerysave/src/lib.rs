//! Save PNG bytes into the system Photos / Pictures library (Android MediaStore).
//! Desktop falls back to the Pictures folder via the host `save_png_bytes` command.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.lc.whiteboard.gallerysave";

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("gallery save is only available on Android")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
struct SaveArgs {
    /// Base64 PNG payload (JNI-friendly).
    png_base64: String,
    filename: String,
}

#[derive(Debug, Deserialize)]
struct SaveResponse {
    uri: String,
}

pub struct GallerySave<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> GallerySave<R> {
    pub fn save_png(&self, png_bytes: &[u8], filename: &str) -> Result<String> {
        use base64::Engine;
        let png_base64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
        let response = self.0.run_mobile_plugin::<SaveResponse>(
            "save_png",
            SaveArgs {
                png_base64,
                filename: filename.to_string(),
            },
        )?;
        Ok(response.uri)
    }
}

pub trait GallerySaveExt<R: Runtime> {
    fn gallery_save(&self) -> Option<&GallerySave<R>>;
}

impl<R: Runtime, T: Manager<R>> GallerySaveExt<R> for T {
    fn gallery_save(&self) -> Option<&GallerySave<R>> {
        self.try_state::<GallerySave<R>>().map(|state| state.inner())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gallerysave")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "GallerySavePlugin")?;
                app.manage(GallerySave::<R>(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                let _ = app;
            }
            Ok(())
        })
        .build()
}
