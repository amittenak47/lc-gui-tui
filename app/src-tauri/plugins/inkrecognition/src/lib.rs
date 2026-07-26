//! Handwriting → text with **ML Kit Digital Ink Recognition**: on-device,
//! offline, and free.
//!
//! This is the piece that makes a *text-only* local model viable for the
//! 15-second ambient loop. Without it the coach would need a local vision model
//! able to read handwriting on every glance, which a Helio G99 tablet cannot
//! do and a 7B local model cannot do well.
//!
//! The Rust side is a thin bridge: strokes in, text out. All the real work —
//! model download, caching, and recognition — is in `android/` (see
//! `InkRecognitionPlugin.kt`).

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.lc.whiteboard.inkrecognition";

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("handwriting recognition is only available on Android")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// One stroke, as parallel coordinate arrays. Parallel arrays rather than a
/// list of points because that is what crosses the JNI boundary cheaply — a
/// long handwriting session sends thousands of points per glance.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stroke {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

#[derive(Debug, Serialize)]
struct RecognizeArgs {
    strokes: Vec<Stroke>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecognizeResponse {
    /// Best transcription, or "" when nothing was legible.
    pub text: String,
    /// Runner-up candidates, best first. Useful when the top guess is nonsense.
    #[serde(default)]
    pub alternatives: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Empty {}

/// The Kotlin side always resolves an object, so a plain `bool` needs a wrapper
/// to deserialize into.
#[derive(Debug, Deserialize)]
struct BoolValue {
    value: bool,
}

/// Handle to the Kotlin plugin.
pub struct InkRecognition<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> InkRecognition<R> {
    pub fn recognize(&self, strokes: Vec<Stroke>) -> Result<RecognizeResponse> {
        if strokes.is_empty() {
            return Ok(RecognizeResponse::default());
        }
        self.0
            .run_mobile_plugin("recognize", RecognizeArgs { strokes })
            .map_err(Into::into)
    }

    /// Whether the recognition model is downloaded and ready.
    pub fn is_available(&self) -> Result<bool> {
        Ok(self
            .0
            .run_mobile_plugin::<BoolValue>("isAvailable", Empty {})?
            .value)
    }
}

/// Extension trait so callers can do `app.ink_recognition()`.
pub trait InkRecognitionExt<R: Runtime> {
    /// `None` off Android, where there is no ML Kit handle to manage.
    fn ink_recognition(&self) -> Option<&InkRecognition<R>>;
}

impl<R: Runtime, T: Manager<R>> InkRecognitionExt<R> for T {
    fn ink_recognition(&self) -> Option<&InkRecognition<R>> {
        self.try_state::<InkRecognition<R>>().map(|state| state.inner())
    }
}

#[tauri::command]
async fn recognize<R: Runtime>(
    app: AppHandle<R>,
    strokes: Vec<Stroke>,
) -> Result<RecognizeResponse> {
    app.ink_recognition()
        .ok_or(Error::Unsupported)?
        .recognize(strokes)
}

#[tauri::command]
async fn is_available<R: Runtime>(app: AppHandle<R>) -> Result<bool> {
    // Reported as `false` rather than an error: "no recognizer here" is an
    // expected answer on desktop, not a failure.
    Ok(match app.ink_recognition() {
        Some(ink) => ink.is_available().unwrap_or(false),
        None => false,
    })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("inkrecognition")
        .invoke_handler(tauri::generate_handler![recognize, is_available])
        .setup(|_app, _api| {
            // Off Android there is no ML Kit and no handle to manage. The
            // commands then fail with `Unsupported`, `MlKitRecognizer.available()`
            // returns false, and `pickRecognizer` falls through to
            // `NoopRecognizer` — the documented desktop path.
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin(PLUGIN_IDENTIFIER, "InkRecognitionPlugin")?;
                _app.manage(InkRecognition(handle));
            }
            Ok(())
        })
        .build()
}
