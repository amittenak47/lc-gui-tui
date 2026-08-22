//! A child web view Android can actually place, hide and talk to.
//!
//! The live pane and the offscreen page render are the same shape: a second
//! web surface put at a rectangle inside the app window, moved when the layout
//! moves, taken away when the tab is parked, and asked for its DOM when the
//! reader freezes it. On desktop that is wry's child webview. On Android it is
//! not: wry's backend there maps `new_as_child` onto `new`, and `set_bounds`
//! and `set_visible` return `Ok` and do nothing — so a view opened that way
//! covers the whole app and cannot be moved, hidden, or reliably closed.
//!
//! Nothing about Android is missing here; the gap is one layer above it.
//! `android.webkit.WebView` is an ordinary view, and adding it to the
//! activity's decor view at a rectangle is what wry declines to do. So the
//! pane keeps its design — HTML reserves a hole, a native surface follows it —
//! and only the transport underneath changes.
//!
//! `eval` is the part that reaches past the pane. `webview_eval_json` answered
//! Android with "page capture needs a desktop webview"; routed here it answers
//! with the page, so whole-page capture and Freeze work on a tablet for the
//! first time.
//!
//! Desktop has wry and says so: every method is `Unsupported` off Android, and
//! the JS side picks its transport before calling rather than trying both.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.lc.whiteboard.livewebview";

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("a native child web view is only available on Android")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Where the view goes, in the CSS pixels the page measured it in.
///
/// The same units `getBoundingClientRect` reports — relative to the Tauri
/// WebView's viewport, not the screen. Kotlin adds that view's screen origin
/// and the device scale, so no caller has to know either.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LiveRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    label: String,
    url: String,
    rect: LiveRect,
    /// CSS px to device px (`window.devicePixelRatio`).
    density: f64,
    /// `None` leaves the system WebView's own string.
    user_agent: Option<String>,
    /// Behind the app instead of over it — the offscreen render.
    behind: bool,
}

#[derive(Debug, Serialize)]
struct PlaceArgs {
    label: String,
    rect: LiveRect,
    density: f64,
}

#[derive(Debug, Serialize)]
struct ShowArgs {
    label: String,
    visible: bool,
}

#[derive(Debug, Serialize)]
struct LabelArgs {
    label: String,
}

#[derive(Debug, Serialize)]
struct EvalArgs {
    label: String,
    script: String,
}

#[derive(Debug, Deserialize)]
struct OkResponse {
    #[allow(dead_code)]
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct ExistsResponse {
    exists: bool,
}

#[derive(Debug, Deserialize)]
struct EvalResponse {
    /// The JSON encoding of the script's value — `evaluateJavascript`'s own
    /// contract, and the same thing wry's `eval_with_callback` hands back, so
    /// the caller parses one string whichever transport answered.
    value: String,
}

pub struct LiveWebView<R: Runtime>(#[allow(dead_code)] PluginHandle<R>);

impl<R: Runtime> LiveWebView<R> {
    /// Open `url` in a native view at `rect`.
    ///
    /// Replaces any view already under `label`. The label is the identity the
    /// JS side queues on, and two views under one name is the collision that
    /// closed a reader's page mid-serialise on desktop.
    pub fn create(
        &self,
        label: &str,
        url: &str,
        rect: LiveRect,
        density: f64,
        user_agent: Option<String>,
        behind: bool,
    ) -> Result<()> {
        #[cfg(target_os = "android")]
        {
            self.0.run_mobile_plugin::<OkResponse>(
                "create",
                CreateArgs {
                    label: label.to_string(),
                    url: url.to_string(),
                    rect,
                    density,
                    user_agent,
                    behind,
                },
            )?;
            Ok(())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (label, url, rect, density, user_agent, behind);
            Err(Error::Unsupported)
        }
    }

    /// Follow the hole. Called from a `ResizeObserver`, so it stays cheap.
    pub fn place(&self, label: &str, rect: LiveRect, density: f64) -> Result<()> {
        #[cfg(target_os = "android")]
        {
            self.0.run_mobile_plugin::<OkResponse>(
                "place",
                PlaceArgs {
                    label: label.to_string(),
                    rect,
                    density,
                },
            )?;
            Ok(())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (label, rect, density);
            Err(Error::Unsupported)
        }
    }

    /// Park the view without throwing the page's session away.
    pub fn show(&self, label: &str, visible: bool) -> Result<()> {
        #[cfg(target_os = "android")]
        {
            self.0.run_mobile_plugin::<OkResponse>(
                "show",
                ShowArgs {
                    label: label.to_string(),
                    visible,
                },
            )?;
            Ok(())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (label, visible);
            Err(Error::Unsupported)
        }
    }

    /// Take the view off the window and destroy it. Absent is not an error.
    pub fn close(&self, label: &str) -> Result<()> {
        #[cfg(target_os = "android")]
        {
            self.0.run_mobile_plugin::<OkResponse>(
                "close",
                LabelArgs {
                    label: label.to_string(),
                },
            )?;
            Ok(())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = label;
            Err(Error::Unsupported)
        }
    }

    /// Whether a view is open under this label — the plugin's `getByLabel`.
    pub fn exists(&self, label: &str) -> Result<bool> {
        #[cfg(target_os = "android")]
        {
            let response = self.0.run_mobile_plugin::<ExistsResponse>(
                "exists",
                LabelArgs {
                    label: label.to_string(),
                },
            )?;
            Ok(response.exists)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = label;
            Err(Error::Unsupported)
        }
    }

    /// Run a script in the page and return the JSON encoding of its value.
    ///
    /// Blocks the calling thread until the WebView answers or the Kotlin side
    /// gives up, so call it off the main thread — see `web_capture.rs`.
    pub fn eval(&self, label: &str, script: &str) -> Result<String> {
        #[cfg(target_os = "android")]
        {
            let response = self.0.run_mobile_plugin::<EvalResponse>(
                "eval",
                EvalArgs {
                    label: label.to_string(),
                    script: script.to_string(),
                },
            )?;
            Ok(response.value)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (label, script);
            Err(Error::Unsupported)
        }
    }
}

pub trait LiveWebViewExt<R: Runtime> {
    fn live_webview(&self) -> Option<&LiveWebView<R>>;
}

impl<R: Runtime, T: Manager<R>> LiveWebViewExt<R> for T {
    fn live_webview(&self) -> Option<&LiveWebView<R>> {
        self.try_state::<LiveWebView<R>>().map(|state| state.inner())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("livewebview")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "LiveWebViewPlugin")?;
                app.manage(LiveWebView::<R>(handle));
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
