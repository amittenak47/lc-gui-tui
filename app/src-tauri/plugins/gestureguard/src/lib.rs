//! Keep Android's back-gesture strips off the part of the screen being written on.
//!
//! On a gesture-navigation device the system owns a strip down each side of the
//! screen: a drag inward from the left or the right is Back. That is the margin
//! of the notebook — a downstroke that starts too near the edge leaves the app
//! instead of leaving ink, and the stroke is gone.
//!
//! Android's answer is `View.setSystemGestureExclusionRects`, which this plugin
//! is a thin bridge to. Desktop has no such thing and says so.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.lc.whiteboard.gestureguard";

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("gesture exclusion is only available on Android")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// A rectangle of the WebView, in CSS pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ExclusionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
struct ExclusionArgs {
    rects: Vec<ExclusionRect>,
    /// CSS px → device px. The WebView knows it; Android does not.
    density: f64,
}

#[derive(Debug, Deserialize)]
struct ExclusionResponse {
    /// How many rects survived Android's per-edge budget.
    applied: u32,
}

pub struct GestureGuard<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> GestureGuard<R> {
    /// Ask for these rectangles back from the system gesture handler.
    ///
    /// An empty list is the way to hand them all back — closing a document
    /// should not leave the edges of the next screen deaf to Back.
    pub fn set_exclusions(&self, rects: Vec<ExclusionRect>, density: f64) -> Result<u32> {
        let response = self
            .0
            .run_mobile_plugin::<ExclusionResponse>("set_exclusions", ExclusionArgs { rects, density })?;
        Ok(response.applied)
    }
}

pub trait GestureGuardExt<R: Runtime> {
    fn gesture_guard(&self) -> Option<&GestureGuard<R>>;
}

impl<R: Runtime, T: Manager<R>> GestureGuardExt<R> for T {
    fn gesture_guard(&self) -> Option<&GestureGuard<R>> {
        self.try_state::<GestureGuard<R>>().map(|state| state.inner())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("gestureguard")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "GestureGuardPlugin")?;
                app.manage(GestureGuard::<R>(handle));
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
